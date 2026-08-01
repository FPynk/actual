import { createHmac } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualAccountV1,
  ActualCategoryV1,
  ActualPayeeV1,
  ActualTransactionGraphV1,
} from '#contracts/adapter';
import { targetVersionHash } from '#reviews/classification';
import type { AmazonMatchReasonCode } from '#service/amazon-matching';
import type {
  AmazonReviewAction,
  AmazonReviewAllocationRecordV1,
  AmazonReviewParentRecordV1,
  AmazonReviewRecordV1,
  AmazonReviewRepository,
  AmazonReviewStatus,
} from '#service/amazon-review-repository';
import { AmazonReviewConflictError } from '#service/amazon-review-repository';

export type AmazonReviewSummaryDtoV1 = Readonly<{
  version: 1;
  reviewRef: string;
  status: AmazonReviewStatus;
  score: number;
  parentCount: number;
  allocationCount: number;
  competingCandidateCount: number;
  createdAt: string;
  decidedAt: string | null;
}>;

export type AmazonReviewListDtoV1 = Readonly<{
  version: 1;
  reviews: readonly AmazonReviewSummaryDtoV1[];
}>;

export type AmazonReviewDetailDtoV1 = AmazonReviewSummaryDtoV1 &
  Readonly<{
    currencyCode: string;
    allowedActions: readonly AmazonReviewAction['kind'][];
    reasons: readonly string[];
    staleReason: 'missing' | 'reconciled' | 'changed' | null;
    parents: readonly Readonly<{
      parentRef: string;
      date: string | null;
      amountMinorUnits: number | null;
      account: string;
      payee: string;
      category: string;
      reconciled: boolean;
      competingCandidateCount: number;
      allocations: readonly Readonly<{
        kind: AmazonReviewAllocationRecordV1['kind'];
        amountMinorUnits: number;
        itemTitle: string | null;
        proposedCategory: string | null;
      }>[];
    }>[];
    guidance: string | null;
  }>;

export type AmazonReviewDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: AmazonReviewRepository;
  budgetKeyHash: string;
  currencyCode: string;
  now?: () => Date;
}>;

type TargetValidation = Readonly<{
  graphs: ReadonlyMap<string, ActualTransactionGraphV1 | null>;
  staleReason: AmazonReviewDetailDtoV1['staleReason'];
}>;

type ActualLabels = Readonly<{
  accounts: readonly ActualAccountV1[];
  payees: readonly ActualPayeeV1[];
  categories: readonly ActualCategoryV1[];
}>;

const reasonLabels: Readonly<Record<AmazonMatchReasonCode, string>> = {
  'currency-match': 'The Amazon source and Actual budget currencies match',
  'currency-mismatch': 'The Amazon source currency does not match Actual',
  'target-reconciled': 'The Actual parent is reconciled',
  'target-stale': 'The Actual parent changed after this candidate was created',
  'charge-sign-match': 'Purchase components match a charge parent',
  'refund-sign-match': 'Refund components match a refund parent',
  'exact-parent-sum': 'Every parent is explained by an exact signed allocation',
  'source-capacity-available': 'The source components have available capacity',
  'source-capacity-exhausted': 'A source component has no remaining capacity',
  'target-capacity-exhausted': 'The Actual parent has no remaining capacity',
  'date-exact': 'The source and Actual dates are the same',
  'date-within-three-days': 'The source and Actual dates are within three days',
  'date-outside-window': 'The source and Actual dates are farther apart',
};

export async function readAmazonReviewList(
  dependencies: AmazonReviewDependencies,
): Promise<AmazonReviewListDtoV1> {
  const records = await refreshActionableRecords(dependencies);
  return {
    version: 1,
    reviews: records.map(record =>
      createSummary(record, records, dependencies),
    ),
  };
}

export async function readAmazonReviewDetail(
  reviewRef: string,
  dependencies: AmazonReviewDependencies,
): Promise<AmazonReviewDetailDtoV1 | null> {
  const initialRecords = dependencies.repository.listAmazonReviewRecords();
  if (resolveRecord(reviewRef, initialRecords, dependencies) === null) {
    return null;
  }
  const records = await refreshActionableRecords(dependencies, initialRecords);
  const record = resolveRecord(reviewRef, records, dependencies);
  if (record === null) return null;
  const validation = await validateTargets(record, dependencies.adapter);
  const labels = await readActualLabels(dependencies);
  return createDetail(record, records, validation, labels, dependencies);
}

export async function decideAmazonReview(
  request: Readonly<{
    reviewRef: string;
    action: AmazonReviewAction;
    decidedAt: string;
  }>,
  dependencies: AmazonReviewDependencies,
): Promise<AmazonReviewDetailDtoV1 | null> {
  assertTimestamp(request.decidedAt);
  const records = dependencies.repository.listAmazonReviewRecords();
  const record = resolveRecord(request.reviewRef, records, dependencies);
  if (record === null) return null;
  assertActionAllowed(record.status, request.action.kind);

  const validation = await validateTargets(record, dependencies.adapter);
  if (validation.staleReason !== null) {
    dependencies.repository.markAmazonReviewStale(record.id);
  } else {
    dependencies.repository.recordAmazonReviewDecision(
      record,
      request.action,
      request.decidedAt,
    );
  }

  const decidedRecords = dependencies.repository.listAmazonReviewRecords();
  const decided = resolveRecord(
    request.reviewRef,
    decidedRecords,
    dependencies,
  );
  if (decided === null) return null;
  const decidedValidation =
    validation.staleReason === null
      ? validation
      : await validateTargets(decided, dependencies.adapter);
  const labels = await readActualLabels(dependencies);
  return createDetail(
    decided,
    decidedRecords,
    decidedValidation,
    labels,
    dependencies,
  );
}

export function createAmazonReviewRef(
  record: Pick<AmazonReviewRecordV1, 'id' | 'matcherVersion'>,
  budgetKeyHash: string,
): string {
  assertBudgetKeyHash(budgetKeyHash);
  const token = createHmac('sha256', Buffer.from(budgetKeyHash, 'hex'))
    .update('finance-companion/amazon-review/v1\0')
    .update(record.id)
    .update('\0')
    .update(String(record.matcherVersion))
    .digest('base64url');
  return `amazon_${token}`;
}

async function refreshActionableRecords(
  dependencies: AmazonReviewDependencies,
  existingRecords = dependencies.repository.listAmazonReviewRecords(),
): Promise<readonly AmazonReviewRecordV1[]> {
  const graphCache = new Map<string, ActualTransactionGraphV1 | null>();
  for (const record of existingRecords) {
    if (record.status !== 'pending' && record.status !== 'deferred') continue;
    const validation = await validateTargets(
      record,
      dependencies.adapter,
      graphCache,
    );
    if (validation.staleReason !== null) {
      dependencies.repository.markAmazonReviewStale(record.id);
    }
  }
  return dependencies.repository.listAmazonReviewRecords();
}

async function validateTargets(
  record: AmazonReviewRecordV1,
  adapter: ActualAdapter,
  graphCache = new Map<string, ActualTransactionGraphV1 | null>(),
): Promise<TargetValidation> {
  let staleReason: AmazonReviewDetailDtoV1['staleReason'] = null;
  for (const parent of record.parents) {
    let graph: ActualTransactionGraphV1 | null;
    if (graphCache.has(parent.actualTransactionId)) {
      graph = graphCache.get(parent.actualTransactionId) ?? null;
    } else {
      graph = await readCurrentTarget(adapter, parent.actualTransactionId);
      graphCache.set(parent.actualTransactionId, graph);
    }
    if (graph === null || graph.parent.tombstone) {
      staleReason ??= 'missing';
    } else if (graph.parent.reconciled) {
      staleReason = 'reconciled';
    } else if (
      graph.parent.id !== parent.actualTransactionId ||
      graph.parent.isChild ||
      graph.parent.isStartingBalance ||
      graph.targetVersionHash !== parent.actualTargetVersion ||
      graph.targetVersionHash !== targetVersionHash(graph)
    ) {
      staleReason ??= 'changed';
    }
  }
  return { graphs: graphCache, staleReason };
}

async function readCurrentTarget(
  adapter: ActualAdapter,
  actualTransactionId: string,
): Promise<ActualTransactionGraphV1 | null> {
  const response = await adapter.execute({
    kind: 'read-actual-target',
    target: { kind: 'transaction', id: actualTransactionId },
  });
  if (response.kind !== 'read-actual-target') {
    throw new Error('Actual returned an unexpected Amazon target response.');
  }
  return response.target;
}

async function readActualLabels(
  dependencies: AmazonReviewDependencies,
): Promise<ActualLabels> {
  const response = await dependencies.adapter.execute({
    kind: 'read-budget-snapshot',
    sections: ['accounts', 'payees', 'categories'],
  });
  if (
    response.kind !== 'read-budget-snapshot' ||
    response.snapshot.budget.budgetKeyHash !== dependencies.budgetKeyHash ||
    response.snapshot.budget.currencyCode !== dependencies.currencyCode ||
    response.snapshot.accounts === undefined ||
    response.snapshot.payees === undefined ||
    response.snapshot.categories === undefined
  ) {
    throw new Error('Actual returned incomplete Amazon review labels.');
  }
  return {
    accounts: response.snapshot.accounts,
    payees: response.snapshot.payees,
    categories: response.snapshot.categories,
  };
}

function createSummary(
  record: AmazonReviewRecordV1,
  records: readonly AmazonReviewRecordV1[],
  dependencies: AmazonReviewDependencies,
): AmazonReviewSummaryDtoV1 {
  return {
    version: 1,
    reviewRef: createAmazonReviewRef(record, dependencies.budgetKeyHash),
    status: record.status,
    score: record.score,
    parentCount: record.parents.length,
    allocationCount: record.parents.reduce(
      (count, parent) => count + parent.allocations.length,
      0,
    ),
    competingCandidateCount: countCompetingRecords(record, records),
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  };
}

function createDetail(
  record: AmazonReviewRecordV1,
  records: readonly AmazonReviewRecordV1[],
  validation: TargetValidation,
  labels: ActualLabels,
  dependencies: AmazonReviewDependencies,
): AmazonReviewDetailDtoV1 {
  return {
    ...createSummary(record, records, dependencies),
    currencyCode: record.currencyCode,
    allowedActions: allowedActions(record.status),
    reasons: record.reasonCodes.map(reason => reasonLabels[reason]),
    staleReason: validation.staleReason,
    parents: record.parents.map(parent =>
      createParentDetail(
        record,
        parent,
        records,
        validation,
        labels,
        dependencies,
      ),
    ),
    guidance:
      record.status === 'approved'
        ? 'Open each matching parent in Actual and review its splits or categories manually. Approval recorded guidance only; Finance Companion did not change Actual.'
        : null,
  };
}

function createParentDetail(
  record: AmazonReviewRecordV1,
  parent: AmazonReviewParentRecordV1,
  records: readonly AmazonReviewRecordV1[],
  validation: TargetValidation,
  labels: ActualLabels,
  dependencies: AmazonReviewDependencies,
): AmazonReviewDetailDtoV1['parents'][number] {
  const graph = validation.graphs.get(parent.actualTransactionId) ?? null;
  const transaction = graph?.parent;
  return {
    parentRef: createParentRef(record, parent, dependencies.budgetKeyHash),
    date: transaction?.date ?? null,
    amountMinorUnits: transaction?.amountMinorUnits ?? null,
    account: displayLabel(
      labels.accounts.find(account => account.id === transaction?.accountId)
        ?.name,
    ),
    payee: displayLabel(
      labels.payees.find(payee => payee.id === transaction?.payeeId)?.name,
    ),
    category: displayLabel(
      labels.categories.find(
        category => category.id === transaction?.categoryId,
      )?.name,
    ),
    reconciled: transaction?.reconciled ?? false,
    competingCandidateCount: countParentCompetitors(parent, record, records),
    allocations: parent.allocations.map(allocation => ({
      kind: allocation.kind,
      amountMinorUnits: allocation.amountMinorUnits,
      itemTitle:
        allocation.itemTitle === null
          ? null
          : displayLabel(allocation.itemTitle),
      proposedCategory:
        allocation.proposedActualCategoryId === null
          ? null
          : displayLabel(
              labels.categories.find(
                category => category.id === allocation.proposedActualCategoryId,
              )?.name,
            ),
    })),
  };
}

function resolveRecord(
  reviewRef: string,
  records: readonly AmazonReviewRecordV1[],
  dependencies: AmazonReviewDependencies,
): AmazonReviewRecordV1 | null {
  if (!/^amazon_[A-Za-z0-9_-]{43}$/.test(reviewRef)) return null;
  const matching = records.filter(
    record =>
      createAmazonReviewRef(record, dependencies.budgetKeyHash) === reviewRef,
  );
  return matching.length === 1 ? matching[0] : null;
}

function createParentRef(
  record: AmazonReviewRecordV1,
  parent: AmazonReviewParentRecordV1,
  budgetKeyHash: string,
): string {
  return `parent_${createHmac('sha256', Buffer.from(budgetKeyHash, 'hex'))
    .update('finance-companion/amazon-review-parent/v1\0')
    .update(record.id)
    .update('\0')
    .update(parent.actualTransactionId)
    .digest('base64url')}`;
}

function countCompetingRecords(
  record: AmazonReviewRecordV1,
  records: readonly AmazonReviewRecordV1[],
): number {
  const parentIds = new Set(
    record.parents.map(parent => parent.actualTransactionId),
  );
  return records.filter(
    candidate =>
      candidate.id !== record.id &&
      (candidate.status === 'pending' || candidate.status === 'deferred') &&
      candidate.parents.some(parent =>
        parentIds.has(parent.actualTransactionId),
      ),
  ).length;
}

function countParentCompetitors(
  parent: AmazonReviewParentRecordV1,
  record: AmazonReviewRecordV1,
  records: readonly AmazonReviewRecordV1[],
): number {
  return records.filter(
    candidate =>
      candidate.id !== record.id &&
      (candidate.status === 'pending' || candidate.status === 'deferred') &&
      candidate.parents.some(
        candidateParent =>
          candidateParent.actualTransactionId === parent.actualTransactionId,
      ),
  ).length;
}

function allowedActions(
  status: AmazonReviewStatus,
): readonly AmazonReviewAction['kind'][] {
  if (status === 'pending') return ['approve', 'reject', 'defer'];
  if (status === 'deferred' || status === 'approved' || status === 'rejected') {
    return ['reopen'];
  }
  return [];
}

function assertActionAllowed(
  status: AmazonReviewStatus,
  action: AmazonReviewAction['kind'],
): void {
  if (!allowedActions(status).includes(action)) {
    throw new AmazonReviewConflictError();
  }
}

function displayLabel(value: string | null | undefined): string {
  const normalized = value
    ?.normalize('NFC')
    .split('')
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .trim()
    .replace(/[\t\n\f\r ]+/g, ' ');
  return normalized === undefined || normalized === ''
    ? 'Not available'
    : normalized.slice(0, 160);
}

function assertBudgetKeyHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Amazon review key is invalid.');
  }
}

function assertTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Amazon review timestamp is invalid.');
  }
}
