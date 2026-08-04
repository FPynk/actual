export const maximumReceiptMatchCandidates = 25;
export const maximumReceiptMatchDateDistanceDays = 7;

const minimumPreselectionScore = 80;
const minimumPreselectionMargin = 15;
const minimumMerchantSimilarityWithoutConflict = 0.35;
const minimumTotalConfidenceForPreselection = 0.8;

export type ReceiptMatchReceiptSnapshot = Readonly<{
  budgetId: string;
  currency: string;
  dateIsAmbiguous?: boolean;
  fingerprint: string;
  id: string;
  merchant?: string | null;
  paymentSourceHint?: string | null;
  purchaseDate?: string | null;
  splitTender?: boolean;
  tombstone?: boolean;
  total?: number | null;
  totalConfidence?: number | null;
}>;

export type ReceiptMatchTransactionSnapshot = Readonly<{
  accountId: string;
  accountPaymentSource?: string | null;
  amount: number;
  budgetId: string;
  currency: string;
  date: string;
  deleted?: boolean;
  id: string;
  importedPayee?: string | null;
  isChild?: boolean;
  isParent?: boolean;
  linkedReceiptId?: string | null;
  parentId?: string | null;
  payee?: string | null;
  startingBalance?: boolean;
  tombstone?: boolean;
  transferId?: string | null;
}>;

export type ReceiptMatchCandidateReason =
  | 'exact-total'
  | 'near-total'
  | 'same-date'
  | 'one-day-date'
  | 'two-to-three-day-date'
  | 'four-to-seven-day-date'
  | 'merchant-exact'
  | 'merchant-similar'
  | 'merchant-conflict'
  | 'merchant-missing'
  | 'source-agreement'
  | 'source-different'
  | 'source-missing';

export type ReceiptMatchExclusionReason =
  | 'amount-mismatch'
  | 'currency-mismatch'
  | 'date-outside-window'
  | 'deleted-target'
  | 'invalid-date'
  | 'non-expense-target'
  | 'split-target'
  | 'starting-balance-target'
  | 'target-reused'
  | 'transfer-target';

export type ReceiptMatchManualSelectionReason =
  | 'ambiguous-date'
  | 'low-confidence-total'
  | 'merchant-conflict'
  | 'missing-date'
  | 'missing-total'
  | 'near-total'
  | 'no-eligible-candidate'
  | 'reused-target'
  | 'split-tender'
  | 'tie';

export type ReceiptMatchCandidate = Readonly<{
  accountId: string;
  amount: number;
  amountScore: number;
  date: string;
  dateDistanceDays: number;
  dateScore: number;
  fingerprint: string;
  merchantScore: number;
  payee: string | null;
  reasons: readonly ReceiptMatchCandidateReason[];
  score: number;
  sourceScore: number;
  transactionId: string;
}>;

export type ReceiptMatchExclusion = Readonly<{
  reason: ReceiptMatchExclusionReason;
  transactionId: string;
}>;

export type ReceiptMatchResult = Readonly<{
  candidates: readonly ReceiptMatchCandidate[];
  exclusions: readonly ReceiptMatchExclusion[];
  manualSelectionReasons: readonly ReceiptMatchManualSelectionReason[];
  preselectedTransactionId: string | null;
}>;

export type ReceiptMatchConfirmation = Readonly<{
  candidateFingerprint: string;
  expectedBudgetId: string;
  receiptFingerprint: string;
  receiptId: string;
  transactionId: string;
}>;

export type ReceiptMatchConfirmationFailureReason =
  | 'receipt-deleted'
  | 'receipt-stale'
  | 'target-deleted'
  | 'target-ineligible'
  | 'target-reused'
  | 'target-stale'
  | 'wrong-budget';

export type ReceiptMatchConfirmationValidation =
  | Readonly<{ isValid: true }>
  | Readonly<{
      isValid: false;
      reason: ReceiptMatchConfirmationFailureReason;
    }>;

/**
 * Produces the complete, deterministic candidate list from current snapshots.
 * The caller is responsible for obtaining those snapshots from the open budget.
 */
export function matchReceiptToTransactions({
  receipt,
  transactions,
}: {
  receipt: ReceiptMatchReceiptSnapshot;
  transactions: readonly ReceiptMatchTransactionSnapshot[];
}): ReceiptMatchResult {
  const manualSelectionReasons = new Set<ReceiptMatchManualSelectionReason>();
  if (!isPositiveInteger(receipt.total)) {
    manualSelectionReasons.add('missing-total');
  }
  if (!isValidDate(receipt.purchaseDate)) {
    manualSelectionReasons.add('missing-date');
  }
  if (receipt.dateIsAmbiguous) {
    manualSelectionReasons.add('ambiguous-date');
  }
  if (
    receipt.totalConfidence !== undefined &&
    receipt.totalConfidence !== null &&
    receipt.totalConfidence < minimumTotalConfidenceForPreselection
  ) {
    manualSelectionReasons.add('low-confidence-total');
  }
  if (receipt.splitTender) {
    manualSelectionReasons.add('split-tender');
  }

  const candidates: ReceiptMatchCandidate[] = [];
  const exclusions: ReceiptMatchExclusion[] = [];
  for (const transaction of transactions) {
    const exclusionReason = getReceiptMatchExclusionReason(
      receipt,
      transaction,
    );
    if (exclusionReason) {
      exclusions.push({
        reason: exclusionReason,
        transactionId: transaction.id,
      });
      if (exclusionReason === 'target-reused') {
        manualSelectionReasons.add('reused-target');
      }
      continue;
    }

    const candidate = scoreReceiptMatchCandidate(receipt, transaction);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort(compareReceiptMatchCandidates);
  const rankedCandidates = candidates.slice(0, maximumReceiptMatchCandidates);
  const preselectedTransactionId = getPreselectedTransactionId(
    receipt,
    rankedCandidates,
    manualSelectionReasons,
  );

  if (rankedCandidates.length === 0) {
    manualSelectionReasons.add('no-eligible-candidate');
  }

  return {
    candidates: rankedCandidates,
    exclusions,
    manualSelectionReasons: [...manualSelectionReasons].sort(),
    preselectedTransactionId,
  };
}

export function scoreReceiptMatchCandidate(
  receipt: ReceiptMatchReceiptSnapshot,
  transaction: ReceiptMatchTransactionSnapshot,
): ReceiptMatchCandidate | null {
  if (getReceiptMatchExclusionReason(receipt, transaction)) {
    return null;
  }

  const total = receipt.total;
  const date = receipt.purchaseDate;
  if (!isPositiveInteger(total) || !isValidDate(date)) {
    return null;
  }

  const transactionTotal = -transaction.amount;
  const amountDifference = Math.abs(transactionTotal - total);
  const amountTolerance = getNearTotalTolerance(total);
  const isExactTotal = amountDifference === 0;
  const amountScore = isExactTotal
    ? 50
    : Math.max(1, Math.round(20 * (1 - amountDifference / amountTolerance)));
  const dateDistanceDays = dateDistanceInDays(date, transaction.date);
  const dateScore = getDateScore(dateDistanceDays);
  const merchant = scoreMerchantEvidence(receipt.merchant, transaction);
  const source = scoreSourceEvidence(
    receipt.paymentSourceHint,
    transaction.accountPaymentSource,
  );
  const reasons: ReceiptMatchCandidateReason[] = [
    isExactTotal ? 'exact-total' : 'near-total',
    getDateReason(dateDistanceDays),
    merchant.reason,
    source.reason,
  ];

  return {
    accountId: transaction.accountId,
    amount: transaction.amount,
    amountScore,
    date: transaction.date,
    dateDistanceDays,
    dateScore,
    fingerprint: receiptTransactionMatchFingerprint(receipt, transaction),
    merchantScore: merchant.score,
    payee: transaction.importedPayee ?? transaction.payee ?? null,
    reasons,
    score: amountScore + dateScore + merchant.score + source.score,
    sourceScore: source.score,
    transactionId: transaction.id,
  };
}

export function getReceiptMatchExclusionReason(
  receipt: ReceiptMatchReceiptSnapshot,
  transaction: ReceiptMatchTransactionSnapshot,
): ReceiptMatchExclusionReason | null {
  if (transaction.tombstone || transaction.deleted) return 'deleted-target';
  if (transaction.isParent || transaction.isChild || transaction.parentId) {
    return 'split-target';
  }
  if (transaction.transferId) return 'transfer-target';
  if (transaction.startingBalance) return 'starting-balance-target';
  if (transaction.amount >= 0) return 'non-expense-target';
  if (
    transaction.linkedReceiptId &&
    transaction.linkedReceiptId !== receipt.id
  ) {
    return 'target-reused';
  }
  if (
    normalizeCurrency(transaction.currency) !==
    normalizeCurrency(receipt.currency)
  ) {
    return 'currency-mismatch';
  }
  if (!isValidDate(receipt.purchaseDate) || !isValidDate(transaction.date)) {
    return 'invalid-date';
  }
  if (
    dateDistanceInDays(receipt.purchaseDate, transaction.date) >
    maximumReceiptMatchDateDistanceDays
  ) {
    return 'date-outside-window';
  }
  if (!isPositiveInteger(receipt.total)) return 'amount-mismatch';
  if (
    Math.abs(-transaction.amount - receipt.total) >
    getNearTotalTolerance(receipt.total)
  ) {
    return 'amount-mismatch';
  }
  return null;
}

export function receiptTransactionMatchFingerprint(
  receipt: ReceiptMatchReceiptSnapshot,
  transaction: ReceiptMatchTransactionSnapshot,
): string {
  return JSON.stringify([
    receipt.id,
    receipt.budgetId,
    receipt.fingerprint,
    normalizeCurrency(receipt.currency),
    receipt.total ?? null,
    receipt.purchaseDate ?? null,
    normalizeEvidence(receipt.merchant),
    normalizeEvidence(receipt.paymentSourceHint),
    transaction.id,
    transaction.budgetId,
    normalizeCurrency(transaction.currency),
    transaction.amount,
    transaction.date,
    transaction.accountId,
    normalizeEvidence(transaction.importedPayee ?? transaction.payee),
    normalizeEvidence(transaction.accountPaymentSource),
    transaction.linkedReceiptId ?? null,
  ]);
}

export function createReceiptMatchConfirmation(
  receipt: ReceiptMatchReceiptSnapshot,
  candidate: ReceiptMatchCandidate,
): ReceiptMatchConfirmation {
  return {
    candidateFingerprint: candidate.fingerprint,
    expectedBudgetId: receipt.budgetId,
    receiptFingerprint: receipt.fingerprint,
    receiptId: receipt.id,
    transactionId: candidate.transactionId,
  };
}

export function validateReceiptMatchConfirmation({
  confirmation,
  receipt,
  transaction,
}: {
  confirmation: ReceiptMatchConfirmation;
  receipt: ReceiptMatchReceiptSnapshot | null;
  transaction: ReceiptMatchTransactionSnapshot | null;
}): ReceiptMatchConfirmationValidation {
  if (!receipt || receipt.tombstone || receipt.id !== confirmation.receiptId) {
    return { isValid: false, reason: 'receipt-deleted' };
  }
  if (!transaction || transaction.tombstone || transaction.deleted) {
    return { isValid: false, reason: 'target-deleted' };
  }
  if (
    receipt.budgetId !== confirmation.expectedBudgetId ||
    transaction.budgetId !== confirmation.expectedBudgetId
  ) {
    return { isValid: false, reason: 'wrong-budget' };
  }
  if (receipt.fingerprint !== confirmation.receiptFingerprint) {
    return { isValid: false, reason: 'receipt-stale' };
  }
  if (
    transaction.linkedReceiptId &&
    transaction.linkedReceiptId !== receipt.id
  ) {
    return { isValid: false, reason: 'target-reused' };
  }
  if (getReceiptMatchExclusionReason(receipt, transaction)) {
    return { isValid: false, reason: 'target-ineligible' };
  }
  if (
    transaction.id !== confirmation.transactionId ||
    receiptTransactionMatchFingerprint(receipt, transaction) !==
      confirmation.candidateFingerprint
  ) {
    return { isValid: false, reason: 'target-stale' };
  }
  return { isValid: true };
}

function getPreselectedTransactionId(
  receipt: ReceiptMatchReceiptSnapshot,
  candidates: readonly ReceiptMatchCandidate[],
  manualSelectionReasons: Set<ReceiptMatchManualSelectionReason>,
): string | null {
  const [firstCandidate, secondCandidate] = candidates;
  if (!firstCandidate) return null;
  if (firstCandidate.reasons.includes('near-total')) {
    manualSelectionReasons.add('near-total');
  }
  if (firstCandidate.reasons.includes('merchant-conflict')) {
    manualSelectionReasons.add('merchant-conflict');
  }
  if (secondCandidate && secondCandidate.score === firstCandidate.score) {
    manualSelectionReasons.add('tie');
  }
  if (
    manualSelectionReasons.size > 0 ||
    firstCandidate.amountScore !== 50 ||
    firstCandidate.dateDistanceDays > 1 ||
    firstCandidate.score < minimumPreselectionScore ||
    (secondCandidate &&
      firstCandidate.score - secondCandidate.score < minimumPreselectionMargin)
  ) {
    return null;
  }
  return firstCandidate.transactionId;
}

function scoreMerchantEvidence(
  merchant: string | null | undefined,
  transaction: ReceiptMatchTransactionSnapshot,
): { reason: ReceiptMatchCandidateReason; score: number } {
  const normalizedMerchant = normalizeEvidence(merchant);
  const normalizedPayee = normalizeEvidence(
    transaction.importedPayee ?? transaction.payee,
  );
  if (!normalizedMerchant || !normalizedPayee) {
    return { reason: 'merchant-missing', score: 0 };
  }
  if (normalizedMerchant === normalizedPayee) {
    return { reason: 'merchant-exact', score: 20 };
  }
  const similarity = merchantSimilarity(normalizedMerchant, normalizedPayee);
  if (similarity < minimumMerchantSimilarityWithoutConflict) {
    return { reason: 'merchant-conflict', score: 0 };
  }
  return { reason: 'merchant-similar', score: Math.round(similarity * 20) };
}

function scoreSourceEvidence(
  receiptSource: string | null | undefined,
  accountSource: string | null | undefined,
): { reason: ReceiptMatchCandidateReason; score: number } {
  const normalizedReceiptSource = normalizeEvidence(receiptSource);
  const normalizedAccountSource = normalizeEvidence(accountSource);
  if (!normalizedReceiptSource || !normalizedAccountSource) {
    return { reason: 'source-missing', score: 0 };
  }
  if (normalizedReceiptSource === normalizedAccountSource) {
    return { reason: 'source-agreement', score: 10 };
  }
  return { reason: 'source-different', score: 0 };
}

function merchantSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(' '));
  const rightTokens = new Set(right.split(' '));
  let sharedTokenCount = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) sharedTokenCount++;
  }
  const tokenSimilarity =
    (2 * sharedTokenCount) / (leftTokens.size + rightTokens.size);
  const prefixSimilarity =
    left.startsWith(right) || right.startsWith(left)
      ? Math.min(left.length, right.length) /
        Math.max(left.length, right.length)
      : 0;
  return Math.max(tokenSimilarity, prefixSimilarity);
}

function getNearTotalTolerance(total: number): number {
  return Math.max(100, Math.ceil(total * 0.02));
}

function getDateScore(dateDistanceDays: number): number {
  if (dateDistanceDays === 0) return 20;
  if (dateDistanceDays === 1) return 12;
  if (dateDistanceDays <= 3) return 6;
  return 2;
}

function getDateReason(dateDistanceDays: number): ReceiptMatchCandidateReason {
  if (dateDistanceDays === 0) return 'same-date';
  if (dateDistanceDays === 1) return 'one-day-date';
  if (dateDistanceDays <= 3) return 'two-to-three-day-date';
  return 'four-to-seven-day-date';
}

function compareReceiptMatchCandidates(
  left: ReceiptMatchCandidate,
  right: ReceiptMatchCandidate,
): number {
  return (
    right.score - left.score ||
    left.dateDistanceDays - right.dateDistanceDays ||
    left.date.localeCompare(right.date) ||
    left.transactionId.localeCompare(right.transactionId)
  );
}

function dateDistanceInDays(left: string, right: string): number {
  return Math.abs(dateTimestamp(left) - dateTimestamp(right)) / 86_400_000;
}

function isValidDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(dateTimestamp(value));
}

function dateTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.NaN;
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : Number.NaN;
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeEvidence(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized || null;
}
