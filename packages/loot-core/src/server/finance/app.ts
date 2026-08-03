import { v4 as uuidv4 } from 'uuid';

import * as asyncStorage from '#platform/server/asyncStorage';
import { fetch } from '#platform/server/fetch';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { createSchedule, updateSchedule } from '#server/schedules/app';
import { getServer } from '#server/server-config';
import { batchUpdateTransactions } from '#server/transactions';
import { mergeTransactions } from '#server/transactions/merge';
import { undoable } from '#server/undo';
import {
  withFinanceReviewDecision,
  withoutFinanceReviewDecision,
} from '#shared/finance-metadata';
import {
  buildAmazonPaymentSources,
  matchAmazonPayments,
  normalizeAmazonReviewOrders,
} from '#shared/finance/amazon';
import type {
  AmazonMatch,
  AmazonOrder,
  AmazonPaymentSource,
  AmazonTransaction,
} from '#shared/finance/amazon';
import {
  detectRecurringPayments,
  validateRecurringPaymentCandidateForApply,
} from '#shared/finance/recurring-detector';
import type {
  RecurringPaymentCadence,
  RecurringPaymentSchedule,
  RecurringPaymentTransaction,
} from '#shared/finance/recurring-detector';
import { q } from '#shared/query';
import { makeChild } from '#shared/transactions';
import type {
  AmazonReviewOrder,
  FinanceCategorizationRequest,
  FinanceCategorizationResponse,
  FinanceCategorizationStatus,
  FinanceReviewDecision,
  FinanceReviewDecisionRecord,
} from '#types/finance';
import type {
  PayeeEntity,
  RecurConfig,
  RuleConditionEntity,
  ScheduleEntity,
  TransactionEntity,
} from '#types/models';

import { applyFinanceCategorization } from './categorization';
import {
  listNativeReconciliationCandidates,
  scoreNativeReconciliationPair,
} from './reconciliation';

type ReconciliationDecision = 'merge' | 'keep-both' | 'deferred';

export function isReconciliationDecision(
  value: unknown,
): value is ReconciliationDecision {
  return value === 'merge' || value === 'keep-both' || value === 'deferred';
}

export type FinanceHandlers = {
  'finance/reconciliation-list': typeof listNativeReconciliationCandidates;
  'finance/reconciliation-decide': typeof decideNativeReconciliationCandidate;
  'finance/recurring/get-decisions': typeof getRecurringReviewDecisions;
  'finance/recurring/save-decision': typeof saveRecurringReviewDecision;
  'finance/recurring/reopen-decision': typeof reopenRecurringReviewDecision;
  'finance/recurring/apply': typeof applyRecurringPaymentCandidate;
  'finance/amazon/get-orders': typeof getAmazonReviewOrders;
  'finance/amazon/save-orders': typeof saveAmazonReviewOrders;
  'finance/amazon/get-decisions': typeof getAmazonReviewDecisions;
  'finance/amazon/save-decision': typeof saveAmazonReviewDecision;
  'finance/amazon/reopen-decision': typeof reopenAmazonReviewDecision;
  'finance/amazon/apply': typeof applyAmazonReview;
  'finance-categorization-status': typeof getCategorizationStatus;
  'finance-categorize': typeof categorizeTransactions;
  'finance-categorization-api-key-set': typeof setCategorizationApiKey;
  'finance-categorization-apply': typeof applyFinanceCategorization;
};

type FinanceRequestError = { error: string };

async function financeRequest<ResponseData>(
  path: string,
  method: string,
  body?: unknown,
): Promise<ResponseData | FinanceRequestError> {
  const userToken = await asyncStorage.getItem('user-token');
  const server = getServer();
  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!userToken || !server || !fileId) {
    return { error: 'unavailable' };
  }

  try {
    const response = await fetch(`${server.BASE_SERVER}/finance${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-ACTUAL-TOKEN': userToken,
        'X-Actual-File-Id': fileId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok || payload?.status !== 'ok') {
      return { error: payload?.reason || 'request-failed' };
    }
    return payload.data;
  } catch {
    return { error: 'network-failure' };
  }
}

async function getCategorizationStatus() {
  return await financeRequest<FinanceCategorizationStatus>('/status', 'GET');
}

async function categorizeTransactions(request: FinanceCategorizationRequest) {
  return await financeRequest<FinanceCategorizationResponse>(
    '/categorize',
    'POST',
    request,
  );
}

async function setCategorizationApiKey({ value }: { value: string | null }) {
  const userToken = await asyncStorage.getItem('user-token');
  const server = getServer();
  const fileId = prefs.getPrefs()?.cloudFileId;
  if (!userToken || !server || !fileId) {
    return { error: 'unavailable' };
  }

  const normalizedValue = value?.trim() ?? null;
  if (value !== null && !normalizedValue) {
    return { error: 'invalid-api-key' };
  }

  try {
    const response = await fetch(
      normalizedValue === null
        ? `${server.BASE_SERVER}/secret/openai_apiKey`
        : `${server.BASE_SERVER}/secret`,
      {
        method: normalizedValue === null ? 'DELETE' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ACTUAL-TOKEN': userToken,
          'X-Actual-File-Id': fileId,
        },
        body: JSON.stringify(
          normalizedValue === null
            ? {}
            : { name: 'openai_apiKey', value: normalizedValue },
        ),
      },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      return { error: payload?.reason || 'request-failed' };
    }
    return { success: true };
  } catch {
    return { error: 'network-failure' };
  }
}

async function decideNativeReconciliationCandidate({
  candidateKey,
  fingerprint,
  decision,
}: {
  candidateKey: string;
  fingerprint: string;
  decision: ReconciliationDecision;
}) {
  if (!isReconciliationDecision(decision)) {
    throw new Error('Invalid reconciliation decision.');
  }

  const candidates = await listNativeReconciliationCandidates();
  const candidate = candidates.find(
    currentCandidate => currentCandidate.candidateKey === candidateKey,
  );
  if (!candidate || candidate.fingerprint !== fingerprint) {
    return { status: 'stale' as const };
  }

  const [left, right] = await Promise.all(
    candidate.transactionIds.map(transactionId =>
      db.getTransaction(transactionId),
    ),
  );
  if (!left || !right) {
    return { status: 'stale' as const };
  }

  const payeeIds = [left.payee, right.payee].filter(
    (payeeId): payeeId is string => Boolean(payeeId),
  );
  const payees = await Promise.all(
    payeeIds.map(payeeId => db.getPayee(payeeId)),
  );
  const freshCandidate = scoreNativeReconciliationPair(
    left,
    right,
    new Map(
      payees
        .filter(payee => payee !== null && payee !== undefined)
        .map(payee => [payee.id, payee.name]),
    ),
  );
  if (
    !freshCandidate ||
    freshCandidate.candidateKey !== candidateKey ||
    freshCandidate.fingerprint !== fingerprint
  ) {
    return { status: 'stale' as const };
  }

  if (decision === 'merge') {
    const leftHasImportEvidence = Boolean(
      left.imported_id || left.imported_payee,
    );
    const rightHasImportEvidence = Boolean(
      right.imported_id || right.imported_payee,
    );
    let preferredFieldsTransactionId: string | undefined;
    if (leftHasImportEvidence !== rightHasImportEvidence) {
      preferredFieldsTransactionId = leftHasImportEvidence ? right.id : left.id;
    }
    const keptTransactionId = await mergeTransactions(
      candidate.transactionIds.map(id => ({ id })),
      { preferredFieldsTransactionId },
    );
    return { status: 'merged' as const, keptTransactionId };
  }

  const storedDecision: FinanceReviewDecision =
    decision === 'keep-both' ? 'keep-both' : 'deferred';
  await prefs.saveFinanceMetadata(
    withFinanceReviewDecision(prefs.getFinanceMetadata(), {
      candidateKey,
      decision: storedDecision,
      feature: 'reconciliation',
      updatedAt: new Date().toISOString(),
    }),
  );
  return { status: storedDecision };
}

export const app = createApp<FinanceHandlers>();

app.method('finance/reconciliation-list', listNativeReconciliationCandidates);
app.method(
  'finance/reconciliation-decide',
  mutator(undoable(decideNativeReconciliationCandidate)),
);

const recurringReviewDecisions = ['deferred', 'rejected', 'applied'] as const;
const maximumCandidateKeyLength = 256;
const maximumEvidenceFingerprintLength = 65_536;

type RecurringReviewDecision = (typeof recurringReviewDecisions)[number];

const amazonReviewDecisions = ['deferred', 'rejected', 'applied'] as const;
const manuallySavedAmazonReviewDecisions = ['deferred', 'rejected'] as const;
type AmazonReviewDecision = (typeof amazonReviewDecisions)[number];
type ManuallySavedAmazonReviewDecision =
  (typeof manuallySavedAmazonReviewDecisions)[number];
type AmazonReviewDecisionRecord = FinanceReviewDecisionRecord &
  Readonly<{ decision: AmazonReviewDecision; feature: 'amazon' }>;

type SaveAmazonReviewOrdersResult =
  | Readonly<{
      conflictingOrderIds: readonly string[];
      status: 'conflict';
    }>
  | Readonly<{
      orders: readonly AmazonOrder[];
      status: 'saved';
    }>;

export async function getAmazonReviewOrders(): Promise<readonly AmazonOrder[]> {
  return prefs.getFinanceMetadata().amazonOrders;
}

export async function saveAmazonReviewOrders({
  orders,
  replaceExistingOrderIds,
}: {
  orders: unknown;
  replaceExistingOrderIds?: unknown;
}): Promise<SaveAmazonReviewOrdersResult> {
  const normalizedOrders = toStoredAmazonReviewOrders(
    normalizeAmazonReviewOrders(orders),
  );
  const ordersById = new Map(
    normalizedOrders.map(order => [order.orderId, order] as const),
  );
  const replacementOrderIds = parseReplacementOrderIds(
    replaceExistingOrderIds,
    ordersById,
  );
  const existingOrders = prefs.getFinanceMetadata().amazonOrders;
  const conflictingOrderIds = normalizedOrders
    .filter(order => {
      const existing = existingOrders.find(
        value => value.orderId === order.orderId,
      );
      return (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(order)
      );
    })
    .map(order => order.orderId);
  if (conflictingOrderIds.some(orderId => !replacementOrderIds.has(orderId))) {
    return { conflictingOrderIds, status: 'conflict' };
  }
  const combinedOrders = existingOrders.map(order =>
    replacementOrderIds.has(order.orderId)
      ? (ordersById.get(order.orderId) ?? order)
      : order,
  );
  for (const order of normalizedOrders) {
    if (!existingOrders.some(value => value.orderId === order.orderId)) {
      combinedOrders.push(order);
    }
  }
  const finance = prefs.getFinanceMetadata();
  await prefs.saveFinanceMetadata({
    ...finance,
    amazonOrders: combinedOrders,
  });
  return { orders: prefs.getFinanceMetadata().amazonOrders, status: 'saved' };
}

export async function getAmazonReviewDecisions(): Promise<
  readonly AmazonReviewDecisionRecord[]
> {
  return prefs
    .getFinanceMetadata()
    .reviewDecisions.filter(
      (decision): decision is AmazonReviewDecisionRecord =>
        decision.feature === 'amazon' &&
        isAmazonReviewDecision(decision.decision),
    );
}

export async function saveAmazonReviewDecision({
  candidateKey,
  decision,
}: {
  candidateKey: string;
  decision: ManuallySavedAmazonReviewDecision;
}): Promise<AmazonReviewDecisionRecord> {
  assertAmazonReviewCandidateKey(candidateKey);
  if (!isManuallySavedAmazonReviewDecision(decision)) {
    throw new Error('Invalid Amazon review decision.');
  }
  const record = {
    candidateKey,
    decision,
    feature: 'amazon',
    updatedAt: new Date().toISOString(),
  } satisfies AmazonReviewDecisionRecord;
  await prefs.saveFinanceMetadata(
    withFinanceReviewDecision(prefs.getFinanceMetadata(), record),
  );
  return record;
}

export async function reopenAmazonReviewDecision({
  candidateKey,
}: {
  candidateKey: string;
}): Promise<void> {
  assertAmazonReviewCandidateKey(candidateKey);
  await prefs.saveFinanceMetadata(
    withoutFinanceReviewDecision(
      prefs.getFinanceMetadata(),
      'amazon',
      candidateKey,
    ),
  );
}

function isAmazonReviewDecision(
  decision: string,
): decision is AmazonReviewDecision {
  return amazonReviewDecisions.some(value => value === decision);
}

function isManuallySavedAmazonReviewDecision(
  decision: string,
): decision is ManuallySavedAmazonReviewDecision {
  return manuallySavedAmazonReviewDecisions.some(value => value === decision);
}

type ApplyAmazonReviewResult = Readonly<{
  appliedFields: readonly ('note' | 'split' | 'category')[];
  status: 'applied' | 'stale';
}>;

const maximumAmazonSplitAllocations = 100;

export async function applyAmazonReview({
  applyNote,
  applySplit,
  candidateKey,
  categoryIdsByAllocationId,
  evidenceFingerprint,
  transactionId,
}: {
  applyNote: boolean;
  applySplit: boolean;
  candidateKey: string;
  categoryIdsByAllocationId: Record<string, string | null>;
  evidenceFingerprint: string;
  transactionId: string;
}): Promise<ApplyAmazonReviewResult> {
  assertAmazonReviewCandidateKey(candidateKey);
  if (
    typeof evidenceFingerprint !== 'string' ||
    evidenceFingerprint.length === 0 ||
    evidenceFingerprint.length > maximumEvidenceFingerprintLength ||
    typeof transactionId !== 'string' ||
    transactionId.length === 0 ||
    transactionId.length > maximumCandidateKeyLength ||
    typeof applyNote !== 'boolean' ||
    typeof applySplit !== 'boolean' ||
    !isCategoryIdsByAllocationId(categoryIdsByAllocationId)
  ) {
    throw new Error('Invalid Amazon apply request.');
  }

  const currentMatch = await getCurrentAmazonMatch(candidateKey);
  if (
    currentMatch === null ||
    currentMatch.transaction === null ||
    currentMatch.transaction.id !== transactionId ||
    currentMatch.evidenceFingerprint !== evidenceFingerprint ||
    (currentMatch.status !== 'ready' && currentMatch.status !== 'review')
  ) {
    return { status: 'stale', appliedFields: [] };
  }

  const transaction = await db.getTransaction(transactionId);
  const account = transaction ? await db.getAccount(transaction.account) : null;
  if (
    !transaction ||
    !account ||
    !isSafeAmazonApplyTarget(transaction, account)
  ) {
    throw new Error('Amazon review target is not safe to update.');
  }

  const source = currentMatch.source;
  const normalizedCategoryIdsByAllocationId =
    normalizeAmazonAllocationCategories(source, categoryIdsByAllocationId);
  const selectedCategoryIds = new Set(
    Object.values(normalizedCategoryIdsByAllocationId).filter(
      (categoryId): categoryId is string => categoryId !== null,
    ),
  );
  if (selectedCategoryIds.size > 0) {
    await assertAmazonCategoriesExist(selectedCategoryIds);
  }

  const hasSingleAllocationCategory =
    !applySplit &&
    source.allocations.length === 1 &&
    normalizedCategoryIdsByAllocationId[source.allocations[0].id] !== null;
  if (
    !applySplit &&
    source.allocations.length > 1 &&
    selectedCategoryIds.size > 0
  ) {
    throw new Error('Amazon allocation categories require a split.');
  }
  if (applySplit) {
    if (
      source.allocations.length < 2 ||
      source.allocations.length > maximumAmazonSplitAllocations ||
      source.allocations.reduce(
        (total, allocation) => total + allocation.amount,
        0,
      ) !== transaction.amount
    ) {
      throw new Error('Amazon allocations cannot safely create a split.');
    }
  }

  const appliedFields: Array<'note' | 'split' | 'category'> = [];
  const updatedTransaction: {
    category?: TransactionEntity['category'] | null;
    id: TransactionEntity['id'];
    is_parent?: boolean;
    notes?: string;
    payee?: TransactionEntity['payee'];
  } = { id: transaction.id };
  if (applyNote) {
    updatedTransaction.notes = appendAmazonReviewNote(
      transaction.notes,
      source,
    );
    appliedFields.push('note');
  }
  if (applySplit) {
    updatedTransaction.is_parent = true;
    updatedTransaction.category = null;
    updatedTransaction.payee = null;
    appliedFields.push('split');
  } else if (hasSingleAllocationCategory) {
    updatedTransaction.category =
      normalizedCategoryIdsByAllocationId[source.allocations[0].id] ??
      undefined;
    appliedFields.push('category');
  }

  if (appliedFields.length === 0) {
    throw new Error('Choose an Amazon change to apply.');
  }

  await batchUpdateTransactions({
    added: applySplit
      ? source.allocations.map((allocation, index) =>
          makeChild(transaction, {
            amount: allocation.amount,
            category:
              normalizedCategoryIdsByAllocationId[allocation.id] ?? undefined,
            id: uuidv4(),
            notes: allocation.label,
            sort_order: -(index + 1),
          }),
        )
      : [],
    updated: [updatedTransaction as TransactionEntity],
    runTransfers: false,
  });
  await saveAmazonAppliedReviewDecision(candidateKey);
  return { status: 'applied', appliedFields };
}

async function getCurrentAmazonMatch(
  candidateKey: string,
): Promise<AmazonMatch | null> {
  const [transactionsResult, payeesResult, currencyPreference] =
    await Promise.all([
      aqlQuery(q('transactions').select('*')),
      aqlQuery(q('payees').select('*')),
      db.first<Pick<db.DbPreference, 'value'>>(
        'SELECT value FROM preferences WHERE id = ?',
        ['defaultCurrencyCode'],
      ),
    ]);
  const payeeNames = new Map(
    (payeesResult.data as PayeeEntity[]).map(payee => [payee.id, payee.name]),
  );
  const transactions = (transactionsResult.data as TransactionEntity[]).map(
    transaction =>
      ({
        ...transaction,
        payee_name:
          transaction.payee == null
            ? null
            : (payeeNames.get(transaction.payee) ?? null),
      }) satisfies AmazonTransaction,
  );
  return (
    matchAmazonPayments(
      buildAmazonPaymentSources(prefs.getFinanceMetadata().amazonOrders),
      transactions,
      currencyPreference?.value ?? '',
    ).find(match => match.candidateKey === candidateKey) ?? null
  );
}

function isCategoryIdsByAllocationId(
  value: unknown,
): value is Record<string, string | null> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every(
      allocationId => allocationId.length > 0 && allocationId.length <= 256,
    ) &&
    Object.values(value).every(
      categoryId =>
        categoryId === null ||
        (typeof categoryId === 'string' &&
          categoryId.length > 0 &&
          categoryId.length <= 256),
    )
  );
}

function normalizeAmazonAllocationCategories(
  source: AmazonPaymentSource,
  categoryIdsByAllocationId: Record<string, string | null>,
): Record<string, string | null> {
  const allocationIds = new Set(source.allocations.map(value => value.id));
  const categoryAllocationIds = Object.keys(categoryIdsByAllocationId);
  if (categoryAllocationIds.some(id => !allocationIds.has(id))) {
    throw new Error('Amazon allocation categories do not match this review.');
  }
  return Object.fromEntries(
    source.allocations.map(allocation => [
      allocation.id,
      categoryIdsByAllocationId[allocation.id] ?? null,
    ]),
  );
}

async function assertAmazonCategoriesExist(
  categoryIds: ReadonlySet<string>,
): Promise<void> {
  const categories = (await db.getCategoriesGrouped())
    .filter(group => !group.hidden && !group.is_income)
    .flatMap(group => group.categories)
    .filter(category => !category.hidden && !category.is_income)
    .map(category => category.id);
  if ([...categoryIds].some(categoryId => !categories.includes(categoryId))) {
    throw new Error('Amazon allocation category does not exist.');
  }
}

function isSafeAmazonApplyTarget(
  transaction: TransactionEntity,
  account: db.DbAccount,
): boolean {
  return !(
    transaction.is_parent ||
    transaction.is_child ||
    transaction.parent_id ||
    transaction.reconciled ||
    transaction.starting_balance_flag ||
    transaction.tombstone ||
    transaction._deleted ||
    transaction.transfer_id ||
    account.offbudget ||
    account.closed ||
    account.tombstone
  );
}

function appendAmazonReviewNote(
  currentNotes: string | undefined,
  source: AmazonPaymentSource,
): string {
  const amazonNote = `Amazon ${source.orderId}`;
  if (currentNotes?.includes(amazonNote)) return currentNotes;
  return currentNotes ? `${currentNotes}\n${amazonNote}` : amazonNote;
}

async function saveAmazonAppliedReviewDecision(
  candidateKey: string,
): Promise<void> {
  await prefs.saveFinanceMetadata(
    withFinanceReviewDecision(prefs.getFinanceMetadata(), {
      candidateKey,
      decision: 'applied',
      feature: 'amazon',
      updatedAt: new Date().toISOString(),
    }),
  );
}

function toStoredAmazonReviewOrders(
  orders: readonly AmazonOrder[],
): AmazonReviewOrder[] {
  return orders.map(order => ({
    ...order,
    items: order.items.map(item => ({ ...item })),
    refunds: order.refunds.map(refund => ({ ...refund })),
    shipments: order.shipments.map(shipment => ({ ...shipment })),
  }));
}

function parseReplacementOrderIds(
  value: unknown,
  ordersById: ReadonlyMap<string, AmazonReviewOrder>,
): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > ordersById.size) {
    throw new Error('Invalid Amazon replacement order identifiers.');
  }
  const identifiers = new Set<string>();
  for (const orderId of value) {
    if (
      typeof orderId !== 'string' ||
      !ordersById.has(orderId) ||
      identifiers.has(orderId)
    ) {
      throw new Error('Invalid Amazon replacement order identifiers.');
    }
    identifiers.add(orderId);
  }
  return identifiers;
}

function assertAmazonReviewCandidateKey(candidateKey: string): void {
  assertCandidateKey(candidateKey);
  if (
    !candidateKey.startsWith('amazon:') ||
    [...candidateKey].some(
      character =>
        character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
    )
  ) {
    throw new Error('Invalid Amazon review candidate key.');
  }
}

export type RecurringReviewDecisionRecord = FinanceReviewDecisionRecord &
  Readonly<{
    decision: RecurringReviewDecision;
    feature: 'recurring';
  }>;

type ApplyRecurringPaymentResult =
  | Readonly<{
      status: 'created' | 'updated';
      scheduleId: string;
    }>
  | Readonly<{
      status:
        | 'stale'
        | 'blocked-reconciled'
        | 'blocked-ambiguous-cadence'
        | 'blocked-ambiguous-schedules';
    }>;

export async function getRecurringReviewDecisions(): Promise<
  readonly RecurringReviewDecisionRecord[]
> {
  return prefs
    .getFinanceMetadata()
    .reviewDecisions.filter(
      (decision): decision is RecurringReviewDecisionRecord =>
        decision.feature === 'recurring' &&
        isRecurringReviewDecision(decision.decision),
    );
}

export async function saveRecurringReviewDecision({
  candidateKey,
  decision,
}: {
  candidateKey: string;
  decision: RecurringReviewDecision;
}): Promise<RecurringReviewDecisionRecord> {
  assertCandidateKey(candidateKey);
  if (!isRecurringReviewDecision(decision)) {
    throw new Error('Invalid recurring review decision.');
  }

  const record = {
    candidateKey,
    decision,
    feature: 'recurring',
    updatedAt: new Date().toISOString(),
  } satisfies RecurringReviewDecisionRecord;
  const finance = withFinanceReviewDecision(prefs.getFinanceMetadata(), record);
  await prefs.saveFinanceMetadata(finance);
  return record;
}

export function isRecurringReviewDecision(
  decision: string,
): decision is RecurringReviewDecision {
  return recurringReviewDecisions.some(
    recurringDecision => recurringDecision === decision,
  );
}

export async function reopenRecurringReviewDecision({
  candidateKey,
}: {
  candidateKey: string;
}): Promise<void> {
  assertCandidateKey(candidateKey);
  await prefs.saveFinanceMetadata(
    withoutFinanceReviewDecision(
      prefs.getFinanceMetadata(),
      'recurring',
      candidateKey,
    ),
  );
}

export async function applyRecurringPaymentCandidate({
  candidateKey,
  evidenceFingerprint,
}: {
  candidateKey: string;
  evidenceFingerprint: string;
}): Promise<ApplyRecurringPaymentResult> {
  assertCandidateKey(candidateKey);
  if (
    evidenceFingerprint.length === 0 ||
    evidenceFingerprint.length > maximumEvidenceFingerprintLength
  ) {
    throw new Error('Invalid recurring evidence fingerprint.');
  }

  const currentCandidates = await readRecurringPaymentCandidates();
  const validation = validateRecurringPaymentCandidateForApply(
    candidateKey,
    evidenceFingerprint,
    currentCandidates,
  );
  if (validation.status !== 'ready') return validation;

  const candidate = validation.candidate;
  const conditions = createScheduleConditions(candidate);
  const currentScheduleId = candidate.relatedScheduleIds[0];
  let result: ApplyRecurringPaymentResult;
  if (currentScheduleId == null) {
    const scheduleId = await createSchedule({
      conditions,
      schedule: { posts_transaction: false },
    });
    result = { scheduleId, status: 'created' };
  } else {
    await updateSchedule({
      conditions,
      resetNextDate: true,
      schedule: { id: currentScheduleId },
    });
    result = { scheduleId: currentScheduleId, status: 'updated' };
  }

  await saveRecurringReviewDecision({ candidateKey, decision: 'applied' });
  return result;
}

async function readRecurringPaymentCandidates() {
  const [transactionResult, scheduleResult, payeeResult] = await Promise.all([
    aqlQuery(q('transactions').select('*')),
    aqlQuery(q('schedules').select('*')),
    aqlQuery(q('payees').select('*')),
  ]);
  const transactions = transactionResult.data as TransactionEntity[];
  const schedules = scheduleResult.data as ScheduleEntity[];
  const payees = payeeResult.data as PayeeEntity[];
  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));

  return detectRecurringPayments(
    transactions.map(
      transaction =>
        ({
          accountId: transaction.account,
          amount: transaction.amount,
          date: transaction.date,
          id: transaction.id,
          isReconciled: transaction.reconciled === true,
          isSplitParent: transaction.is_parent === true,
          isStartingBalance: transaction.starting_balance_flag === true,
          isTombstone:
            transaction.tombstone === true || transaction._deleted === true,
          isTransfer: transaction.transfer_id != null,
          payeeId: transaction.payee ?? null,
          payeeName:
            transaction.payee == null
              ? null
              : (payeeNames.get(transaction.payee) ?? null),
        }) satisfies RecurringPaymentTransaction,
    ),
    schedules.map(projectRecurringPaymentSchedule),
  );
}

function projectRecurringPaymentSchedule(
  schedule: ScheduleEntity,
): RecurringPaymentSchedule {
  return {
    accountId: schedule._account ?? null,
    amount: schedule._amount ?? null,
    amountOperator: schedule._amountOp ?? null,
    id: schedule.id,
    isCompleted: schedule.completed,
    payeeId: schedule._payee ?? null,
    recurrence: schedule._date ?? null,
  };
}

function createScheduleConditions(candidate: {
  accountId: string;
  cadence: RecurringPaymentCadence;
  lastDate: string;
  medianAmount: number;
  payeeId: string;
}): RuleConditionEntity[] {
  if (candidate.cadence === 'ambiguous') {
    throw new Error('An ambiguous cadence cannot create a schedule.');
  }
  const frequency =
    candidate.cadence === 'annual'
      ? 'yearly'
      : candidate.cadence === 'quarterly'
        ? 'monthly'
        : candidate.cadence;
  const recurrence = {
    endDate: candidate.lastDate,
    endMode: 'never',
    endOccurrences: 1,
    frequency,
    interval: candidate.cadence === 'quarterly' ? 3 : 1,
    patterns: [],
    skipWeekend: false,
    start: candidate.lastDate,
    weekendSolveMode: 'after',
  } satisfies RecurConfig;

  return [
    { field: 'payee', op: 'is', value: candidate.payeeId },
    { field: 'account', op: 'is', value: candidate.accountId },
    { field: 'date', op: 'isapprox', value: recurrence },
    { field: 'amount', op: 'isapprox', value: -candidate.medianAmount },
  ];
}

function assertCandidateKey(candidateKey: string): void {
  if (
    candidateKey.length === 0 ||
    candidateKey.length > maximumCandidateKeyLength
  ) {
    throw new Error('Invalid recurring candidate key.');
  }
}

app.method('finance/recurring/get-decisions', getRecurringReviewDecisions);
app.method(
  'finance/recurring/save-decision',
  mutator(saveRecurringReviewDecision),
);
app.method(
  'finance/recurring/reopen-decision',
  mutator(reopenRecurringReviewDecision),
);
app.method(
  'finance/recurring/apply',
  mutator(undoable(applyRecurringPaymentCandidate)),
);
app.method('finance/amazon/get-orders', getAmazonReviewOrders);
app.method('finance/amazon/save-orders', mutator(saveAmazonReviewOrders));
app.method('finance/amazon/get-decisions', getAmazonReviewDecisions);
app.method('finance/amazon/save-decision', mutator(saveAmazonReviewDecision));
app.method(
  'finance/amazon/reopen-decision',
  mutator(reopenAmazonReviewDecision),
);
app.method('finance/amazon/apply', mutator(undoable(applyAmazonReview)));
app.method('finance-categorization-status', getCategorizationStatus);
app.method('finance-categorize', categorizeTransactions);
app.method('finance-categorization-api-key-set', setCategorizationApiKey);
app.method(
  'finance-categorization-apply',
  mutator(undoable(applyFinanceCategorization)),
);
