import { createHmac } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualAccountV1,
  ActualPayeeV1,
  ActualTransactionV1,
  SubscriptionScheduleSnapshotV1,
} from '#contracts/adapter';

import { matchingScheduleIds } from './subscription-detector';
import type {
  SubscriptionCandidateType,
  SubscriptionCandidateV1,
  SubscriptionHistoryTransactionV1,
  SubscriptionReasonCode,
} from './subscription-detector';
import { scanSubscriptionCandidates } from './subscription-scan-service';
import type { SubscriptionCandidateRepository } from './subscription-scan-service';

export type SubscriptionReviewAction =
  | Readonly<{
      kind: 'approve';
      userSelectedType: SubscriptionCandidateType;
    }>
  | Readonly<{ kind: 'defer' }>
  | Readonly<{
      kind: 'reject';
      reasonCode?: 'not-recurring' | 'other';
    }>
  | Readonly<{ kind: 'reopen' }>;

export type SubscriptionReviewRecordV1 = Readonly<{
  candidate: SubscriptionCandidateV1;
  decidedAt: string | null;
}>;

export type SubscriptionReviewRepository = SubscriptionCandidateRepository &
  Readonly<{
    listSubscriptionReviewRecords():
      | readonly SubscriptionReviewRecordV1[]
      | Promise<readonly SubscriptionReviewRecordV1[]>;
    recordSubscriptionReviewDecision(
      record: SubscriptionReviewRecordV1,
      action: SubscriptionReviewAction,
      decidedAt: string,
    ): SubscriptionReviewRecordV1 | Promise<SubscriptionReviewRecordV1>;
  }>;

type SubscriptionReviewStatus = SubscriptionCandidateV1['status'];
type SubscriptionReviewActionKind = SubscriptionReviewAction['kind'];

export type SubscriptionScheduleAssociation =
  | 'existing'
  | 'ambiguous'
  | 'none'
  | 'stale';

export type SubscriptionReviewSummaryDtoV1 = Readonly<{
  version: 1;
  reviewRef: string;
  title: string;
  status: SubscriptionReviewStatus;
  cadence: string;
  confidence: number;
  selectedType: SubscriptionCandidateType | null;
  hasExistingSchedule: boolean;
  evaluatedAt: string;
  decidedAt: string | null;
}>;

export type SubscriptionReviewListDtoV1 = Readonly<{
  version: 1;
  reviews: readonly SubscriptionReviewSummaryDtoV1[];
}>;

export type SubscriptionReviewDetailDtoV1 = SubscriptionReviewSummaryDtoV1 &
  Readonly<{
    allowedActions: readonly SubscriptionReviewActionKind[];
    reasons: readonly string[];
    evidence: Readonly<{
      currencyCode: string;
      account: string;
      payee: string;
      cadence: string;
      occurrenceCount: number;
      firstDate: string;
      lastDate: string;
      medianAmountMinorUnits: number;
      amountVarianceBasisPoints: number;
      dateVarianceDays: number;
      recentPriceChangeBasisPoints: number | null;
      hasReconciledHistory: boolean;
      scheduleAssociation: SubscriptionScheduleAssociation;
    }>;
    guidance: string | null;
  }>;

export type SubscriptionReviewDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: SubscriptionReviewRepository;
  budgetKeyHash: string;
  currencyCode: string;
  now?: () => Date;
}>;

type ReviewSnapshot = Readonly<{
  accounts: readonly ActualAccountV1[];
  payees: readonly ActualPayeeV1[];
  schedules: readonly SubscriptionScheduleSnapshotV1[];
  transactions: readonly SubscriptionHistoryTransactionV1[];
}>;

type RefreshedReviews = Readonly<{
  records: readonly SubscriptionReviewRecordV1[];
  snapshot: ReviewSnapshot | null;
}>;

const millisecondsPerDay = 86_400_000;

const reasonLabels: Readonly<Record<SubscriptionReasonCode, string>> = {
  'cadence-weekly': 'Payments recur on a weekly cadence',
  'cadence-monthly': 'Payments recur on a monthly cadence',
  'cadence-quarterly': 'Payments recur on a quarterly cadence',
  'cadence-annual': 'Payments recur on an annual cadence',
  'cadence-ambiguous': 'More than one cadence fits this history',
  'minimum-occurrences': 'The minimum number of recurring payments was found',
  'billing-date-variance': 'Billing dates vary within the allowed window',
  'stable-amount': 'Payment amounts are stable',
  'amount-variance': 'Payment amounts vary within the allowed range',
  'price-change': 'The most recent payment has a material price change',
  'gap-detected': 'One expected payment appears to be missing',
  'reconciled-history': 'The evidence includes a reconciled transaction',
  'existing-schedule': 'One current Actual schedule matches this cadence',
  'schedule-ambiguous': 'More than one Actual schedule matches this cadence',
};

export class SubscriptionReviewConflictError extends Error {
  constructor() {
    super('Subscription review state changed.');
    this.name = 'SubscriptionReviewConflictError';
  }
}

export async function readSubscriptionReviewList(
  dependencies: SubscriptionReviewDependencies,
): Promise<SubscriptionReviewListDtoV1> {
  const refreshed = await refreshReviews(dependencies);
  return {
    version: 1,
    reviews: refreshed.records.map(record =>
      createSummary(record, dependencies, refreshed.snapshot),
    ),
  };
}

export async function readSubscriptionReviewDetail(
  reviewRef: string,
  dependencies: SubscriptionReviewDependencies,
): Promise<SubscriptionReviewDetailDtoV1 | null> {
  const initialRecords =
    await dependencies.repository.listSubscriptionReviewRecords();
  if (
    resolveRecord(reviewRef, initialRecords, dependencies.budgetKeyHash) ===
    null
  ) {
    return null;
  }
  const refreshed = await refreshReviews(dependencies, initialRecords);
  const record = resolveRecord(
    reviewRef,
    refreshed.records,
    dependencies.budgetKeyHash,
  );
  return record === null
    ? null
    : createDetail(record, dependencies, refreshed.snapshot);
}

export async function decideSubscriptionReview(
  request: Readonly<{
    reviewRef: string;
    action: SubscriptionReviewAction;
    decidedAt: string;
  }>,
  dependencies: SubscriptionReviewDependencies,
): Promise<SubscriptionReviewDetailDtoV1 | null> {
  assertTimestamp(request.decidedAt);
  const initialRecords =
    await dependencies.repository.listSubscriptionReviewRecords();
  const initialRecord = resolveRecord(
    request.reviewRef,
    initialRecords,
    dependencies.budgetKeyHash,
  );
  if (initialRecord === null) return null;

  const decidedAt = new Date(request.decidedAt);
  const refreshed = await refreshReviews(
    dependencies,
    initialRecords,
    decidedAt,
  );
  const currentRecord = resolveRecord(
    request.reviewRef,
    refreshed.records,
    dependencies.budgetKeyHash,
  );
  if (currentRecord === null) return null;
  if (
    initialRecord.candidate.status === 'pending' &&
    currentRecord.candidate.status === 'stale'
  ) {
    return createDetail(currentRecord, dependencies, refreshed.snapshot);
  }
  assertActionAllowed(currentRecord, request.action);
  await dependencies.repository.recordSubscriptionReviewDecision(
    currentRecord,
    request.action,
    request.decidedAt,
  );

  if (request.action.kind === 'reopen' && refreshed.snapshot !== null) {
    await scanSubscriptionCandidates({
      clock: { now: () => decidedAt },
      repository: dependencies.repository,
      schedules: refreshed.snapshot.schedules,
      transactions: refreshed.snapshot.transactions,
    });
  }
  const decidedRecords =
    await dependencies.repository.listSubscriptionReviewRecords();
  const decidedRecord = resolveRecord(
    request.reviewRef,
    decidedRecords,
    dependencies.budgetKeyHash,
  );
  if (decidedRecord === null) {
    throw new SubscriptionReviewConflictError();
  }
  return createDetail(decidedRecord, dependencies, refreshed.snapshot);
}

export function createSubscriptionReviewRef(
  record: SubscriptionReviewRecordV1,
  budgetKeyHash: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(budgetKeyHash)) {
    throw new TypeError('Subscription review key is invalid.');
  }
  const token = createHmac('sha256', Buffer.from(budgetKeyHash, 'hex'))
    .update('finance-companion/subscription-review/v1\0')
    .update(record.candidate.signature)
    .update('\0')
    .update(String(record.candidate.detectorVersion))
    .digest('base64url');
  return `subscription_${token}`;
}

async function refreshReviews(
  dependencies: SubscriptionReviewDependencies,
  existingRecords?: readonly SubscriptionReviewRecordV1[],
  evaluatedAt = readClock(dependencies),
): Promise<RefreshedReviews> {
  const records =
    existingRecords ??
    (await dependencies.repository.listSubscriptionReviewRecords());
  if (records.length === 0) {
    return { records, snapshot: null };
  }
  const snapshot = await readReviewSnapshot(records, dependencies, evaluatedAt);
  await scanSubscriptionCandidates({
    clock: { now: () => evaluatedAt },
    repository: dependencies.repository,
    schedules: snapshot.schedules,
    transactions: snapshot.transactions,
  });
  return {
    records: await dependencies.repository.listSubscriptionReviewRecords(),
    snapshot,
  };
}

async function readReviewSnapshot(
  records: readonly SubscriptionReviewRecordV1[],
  dependencies: SubscriptionReviewDependencies,
  evaluatedAt: Date,
): Promise<ReviewSnapshot> {
  const firstDate = records.map(record => record.candidate.firstDate).sort()[0];
  const finalInclusiveDate = [
    evaluatedAt.toISOString().slice(0, 10),
    ...records.map(record => record.candidate.lastDate),
  ]
    .sort()
    .at(-1);
  if (firstDate === undefined || finalInclusiveDate === undefined) {
    throw new TypeError('Subscription review history is missing.');
  }
  const ranges = partitionDateRange(firstDate, addDays(finalInclusiveDate, 1));
  let accounts: readonly ActualAccountV1[] | undefined;
  let payees: readonly ActualPayeeV1[] | undefined;
  const transactions: ActualTransactionV1[] = [];
  const accountIds = [
    ...new Set(records.map(record => record.candidate.accountId)),
  ].sort();
  for (const [index, transactionRange] of ranges.entries()) {
    const response = await dependencies.adapter.execute({
      kind: 'read-budget-snapshot',
      sections: index === 0 ? ['accounts', 'payees'] : [],
      transactionRange: {
        ...transactionRange,
        ...(accountIds.length <= 100 ? { accountIds } : {}),
      },
    });
    if (
      response.kind !== 'read-budget-snapshot' ||
      response.snapshot.budget.budgetKeyHash !== dependencies.budgetKeyHash ||
      response.snapshot.budget.currencyCode !== dependencies.currencyCode ||
      response.snapshot.transactions === undefined
    ) {
      throw new Error('Actual returned an unexpected subscription snapshot.');
    }
    if (index === 0) {
      accounts = response.snapshot.accounts;
      payees = response.snapshot.payees;
      if (accounts === undefined || payees === undefined) {
        throw new Error('Actual returned an incomplete subscription snapshot.');
      }
    }
    transactions.push(...response.snapshot.transactions);
  }
  const scheduleResponse = await dependencies.adapter.execute({
    kind: 'read-budget-snapshot',
    sections: ['schedules'],
  });
  if (
    scheduleResponse.kind !== 'read-budget-snapshot' ||
    scheduleResponse.snapshot.budget.budgetKeyHash !==
      dependencies.budgetKeyHash ||
    scheduleResponse.snapshot.budget.currencyCode !==
      dependencies.currencyCode ||
    scheduleResponse.snapshot.schedules === undefined
  ) {
    throw new Error('Actual returned an unexpected subscription snapshot.');
  }
  if (accounts === undefined || payees === undefined) {
    throw new Error('Actual returned an incomplete subscription snapshot.');
  }
  return {
    accounts,
    payees,
    schedules: scheduleResponse.snapshot.schedules,
    transactions: transactions.map(projectHistoryTransaction),
  };
}

function createSummary(
  record: SubscriptionReviewRecordV1,
  dependencies: SubscriptionReviewDependencies,
  snapshot: ReviewSnapshot | null,
): SubscriptionReviewSummaryDtoV1 {
  const payeeName = snapshot?.payees.find(
    payee => payee.id === record.candidate.payeeId,
  )?.name;
  const association = scheduleAssociation(record.candidate, snapshot);
  return {
    version: 1,
    reviewRef: createSubscriptionReviewRef(record, dependencies.budgetKeyHash),
    title: `${displayLabel(payeeName)} recurring payment`,
    status: record.candidate.status,
    cadence: cadenceLabel(record.candidate.cadence),
    confidence: record.candidate.confidence,
    selectedType: selectedType(record.candidate),
    hasExistingSchedule: association === 'existing',
    evaluatedAt: record.candidate.evaluatedAt,
    decidedAt: record.decidedAt,
  };
}

function createDetail(
  record: SubscriptionReviewRecordV1,
  dependencies: SubscriptionReviewDependencies,
  snapshot: ReviewSnapshot | null,
): SubscriptionReviewDetailDtoV1 {
  const candidate = record.candidate;
  const accountName = snapshot?.accounts.find(
    account => account.id === candidate.accountId,
  )?.name;
  const payeeName = snapshot?.payees.find(
    payee => payee.id === candidate.payeeId,
  )?.name;
  const association = scheduleAssociation(candidate, snapshot);
  return {
    ...createSummary(record, dependencies, snapshot),
    allowedActions: allowedActions(candidate.status),
    reasons: candidate.reasonCodes.map(reason => reasonLabels[reason]),
    evidence: {
      currencyCode: dependencies.currencyCode,
      account: displayLabel(accountName),
      payee: displayLabel(payeeName),
      cadence: cadenceLabel(candidate.cadence),
      occurrenceCount: candidate.occurrenceCount,
      firstDate: candidate.firstDate,
      lastDate: candidate.lastDate,
      medianAmountMinorUnits: candidate.medianAmount,
      amountVarianceBasisPoints: candidate.amountVarianceBasisPoints,
      dateVarianceDays: candidate.dateVarianceDays,
      recentPriceChangeBasisPoints: candidate.recentPriceChangeBasisPoints,
      hasReconciledHistory:
        candidate.reasonCodes.includes('reconciled-history'),
      scheduleAssociation: association,
    },
    guidance: approvalGuidance(record, association),
  };
}

function resolveRecord(
  reviewRef: string,
  records: readonly SubscriptionReviewRecordV1[],
  budgetKeyHash: string,
): SubscriptionReviewRecordV1 | null {
  if (!/^subscription_[A-Za-z0-9_-]{43}$/.test(reviewRef)) return null;
  const matching = records.filter(
    record => createSubscriptionReviewRef(record, budgetKeyHash) === reviewRef,
  );
  return matching.length === 1 ? matching[0] : null;
}

function scheduleAssociation(
  candidate: SubscriptionCandidateV1,
  snapshot: ReviewSnapshot | null,
): SubscriptionScheduleAssociation {
  if (snapshot === null) return 'none';
  const currentMatches = matchingScheduleIds(candidate, snapshot.schedules);
  if (candidate.actualScheduleId !== null) {
    return currentMatches.includes(candidate.actualScheduleId)
      ? 'existing'
      : 'stale';
  }
  if (currentMatches.length === 1) return 'existing';
  if (currentMatches.length > 1) return 'ambiguous';
  return 'none';
}

function selectedType(
  candidate: SubscriptionCandidateV1,
): SubscriptionCandidateType | null {
  if (candidate.status === 'approved' || candidate.status === 'applied') {
    return candidate.candidateType;
  }
  return candidate.candidateType === 'unknown' ? null : candidate.candidateType;
}

function allowedActions(
  status: SubscriptionReviewStatus,
): readonly SubscriptionReviewActionKind[] {
  if (status === 'pending') return ['approve', 'defer', 'reject'];
  if (status === 'approved' || status === 'deferred' || status === 'rejected') {
    return ['reopen'];
  }
  return [];
}

function assertActionAllowed(
  record: SubscriptionReviewRecordV1,
  action: SubscriptionReviewAction,
): void {
  if (!allowedActions(record.candidate.status).includes(action.kind)) {
    throw new SubscriptionReviewConflictError();
  }
  if (action.kind === 'approve' && !isCandidateType(action.userSelectedType)) {
    throw new TypeError('Subscription review type is invalid.');
  }
}

function approvalGuidance(
  record: SubscriptionReviewRecordV1,
  association: SubscriptionScheduleAssociation,
): string | null {
  if (record.candidate.status !== 'approved') return null;
  if (association === 'existing') {
    return 'Review the matching schedule in Actual. Approval recorded guidance only; Finance Companion did not change the schedule or any transaction.';
  }
  return 'Open Schedules in Actual and review the recurring payment manually. Approval recorded guidance only; Finance Companion did not create or change a schedule or transaction.';
}

function projectHistoryTransaction(
  transaction: ActualTransactionV1,
): SubscriptionHistoryTransactionV1 {
  return {
    accountId: transaction.accountId,
    amount: transaction.amountMinorUnits,
    date: transaction.date,
    id: transaction.id,
    isReconciled: transaction.reconciled,
    isSplitParent: transaction.isParent,
    isStartingBalance: transaction.isStartingBalance,
    isTombstone: transaction.tombstone,
    isTransfer: transaction.transferId !== null,
    payeeId: transaction.payeeId,
  };
}

function partitionDateRange(
  startDate: string,
  endDateExclusive: string,
): readonly Readonly<{ startDate: string; endDateExclusive: string }>[] {
  const start = parseDate(startDate);
  const end = parseDate(endDateExclusive);
  if (start >= end) {
    throw new TypeError('Subscription review range is invalid.');
  }
  const ranges: Readonly<{ startDate: string; endDateExclusive: string }>[] =
    [];
  for (let cursor = start; cursor < end; cursor += 90 * millisecondsPerDay) {
    ranges.push({
      startDate: isoDate(cursor),
      endDateExclusive: isoDate(
        Math.min(end, cursor + 90 * millisecondsPerDay),
      ),
    });
  }
  return ranges;
}

function addDays(value: string, count: number): string {
  return isoDate(parseDate(value) + count * millisecondsPerDay);
}

function parseDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('Subscription review date is invalid.');
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || isoDate(parsed) !== value) {
    throw new TypeError('Subscription review date is invalid.');
  }
  return parsed;
}

function isoDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function readClock(dependencies: SubscriptionReviewDependencies): Date {
  const value = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('Subscription review clock is invalid.');
  }
  return value;
}

function assertTimestamp(value: string): void {
  const date = new Date(value);
  if (
    value.length !== 24 ||
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== value
  ) {
    throw new TypeError('Subscription review timestamp is invalid.');
  }
}

function cadenceLabel(cadence: SubscriptionCandidateV1['cadence']): string {
  if (cadence === 'unknown') return 'Ambiguous cadence';
  return cadence.charAt(0).toUpperCase() + cadence.slice(1);
}

function displayLabel(value: string | undefined | null): string {
  const normalized = value
    ?.split('')
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return normalized === undefined || normalized === ''
    ? 'Not available'
    : normalized.slice(0, 160);
}

function isCandidateType(value: string): value is SubscriptionCandidateType {
  return (
    value === 'subscription' ||
    value === 'household_bill' ||
    value === 'financial_bill' ||
    value === 'unknown'
  );
}
