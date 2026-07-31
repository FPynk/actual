import { createHmac } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type { SourceIdentityRepository } from '#database/source-identity-repository';

import type {
  ReconciliationCandidateRepository,
  ReconciliationCandidateStatus,
  ReconciliationCandidateV1,
  ReconciliationReasonCode,
} from './candidates.ts';

export type ReconciliationReviewCandidateDtoV1 = Readonly<{
  version: 1;
  reviewId: string;
  status: ReconciliationCandidateStatus;
  score: number;
  confidence: string;
  reasons: readonly string[];
  competingCandidateCount: number;
  createdAt: string;
  decidedAt: string | null;
  evidence: ReconciliationReviewEvidenceDtoV1 | null;
}>;

export type ReconciliationReviewEvidenceDtoV1 = Readonly<{
  currencyCode: string;
  source: Readonly<{
    date: string;
    amountMinorUnits: number;
    merchant: string;
    accountName: string;
    state: 'Unknown' | 'Pending' | 'Posted';
  }>;
  actual: Readonly<{
    date: string;
    amountMinorUnits: number;
    merchant: string;
    accountName: string;
    state: 'Cleared' | 'Uncleared';
  }> | null;
}>;

export type ReconciliationReviewListDtoV1 = Readonly<{
  version: 1;
  candidates: readonly ReconciliationReviewCandidateDtoV1[];
}>;

const reasonLabels: Readonly<Record<ReconciliationReasonCode, string>> = {
  'source-observation': 'Bank source observation is available',
  'fingerprint-review-only': 'Match is provided for review only',
  'stable-id-agreement': 'Stable import identifiers agree',
  'changed-id-review-only': 'Import identifiers changed; review is required',
  'stable-id-unavailable': 'Stable import identifiers are unavailable',
  'exact-account': 'Account matches exactly',
  'exact-amount': 'Amount matches exactly',
  'date-exact': 'Date matches exactly',
  'date-within-three-days': 'Date is within three days',
  'date-outside-window': 'Date is outside the usual window',
  'payee-match': 'Payee matches',
  'payee-unavailable': 'Payee evidence is unavailable',
  'payee-mismatch': 'Payee differs',
  'pending-compatible': 'Pending state is compatible',
  'posted-compatible': 'Posted state is compatible',
  'pending-cleared-conflict': 'Pending state conflicts with a cleared target',
  'posted-uncleared': 'Posted state differs from an uncleared target',
  'booking-status-unknown': 'Booking status is unknown',
};

export function createReconciliationReviewListDto(
  repository: ReconciliationCandidateRepository,
  budgetKeyHash: string,
): ReconciliationReviewListDtoV1 {
  const candidates = repository.list();
  return {
    version: 1,
    candidates: candidates.map(candidate =>
      createReconciliationReviewCandidateDto(
        candidate,
        candidates,
        budgetKeyHash,
      ),
    ),
  };
}

export function readReconciliationReviewCandidate(
  repository: ReconciliationCandidateRepository,
  reviewId: string,
  budgetKeyHash: string,
): ReconciliationCandidateV1 | null {
  if (!/^review_[A-Za-z0-9_-]{43}$/.test(reviewId)) return null;
  const candidates = repository
    .list()
    .filter(
      candidate =>
        createReconciliationReviewId(candidate.id, budgetKeyHash) === reviewId,
    );
  return candidates.length === 1 ? candidates[0] : null;
}

export function createReconciliationReviewCandidateDto(
  candidate: ReconciliationCandidateV1,
  allCandidates: readonly ReconciliationCandidateV1[],
  budgetKeyHash: string,
  evidence: ReconciliationReviewEvidenceDtoV1 | null = null,
): ReconciliationReviewCandidateDtoV1 {
  return {
    version: 1,
    reviewId: createReconciliationReviewId(candidate.id, budgetKeyHash),
    status: candidate.status,
    score: candidate.score,
    confidence: confidenceLabel(candidate.score),
    reasons: candidate.reasonCodes.map(reason => reasonLabels[reason]),
    competingCandidateCount: allCandidates.filter(
      other =>
        other.id !== candidate.id &&
        other.sourceTransactionId === candidate.sourceTransactionId &&
        other.status === 'pending',
    ).length,
    createdAt: candidate.createdAt,
    decidedAt: candidate.decidedAt,
    evidence,
  };
}

export function createReconciliationReviewId(
  candidateId: string,
  budgetKeyHash: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(budgetKeyHash)) {
    throw new TypeError('Reconciliation review key is invalid.');
  }
  const token = createHmac('sha256', Buffer.from(budgetKeyHash, 'hex'))
    .update('finance-companion/reconciliation-review/v1\0')
    .update(candidateId)
    .digest('base64url');
  return `review_${token}`;
}

export async function readReconciliationReviewEvidence(
  candidate: ReconciliationCandidateV1,
  dependencies: Readonly<{
    adapter: ActualAdapter;
    sourceIdentityRepository: SourceIdentityRepository;
    budgetKeyHash: string;
    currencyCode: string;
  }>,
): Promise<ReconciliationReviewEvidenceDtoV1> {
  if (!/^[A-Z]{3}$/.test(dependencies.currencyCode)) {
    throw new TypeError('Reconciliation review currency is invalid.');
  }
  const source = dependencies.sourceIdentityRepository
    .readReconciliationSources()
    .find(item => item.id === candidate.sourceTransactionId);
  if (source === undefined) {
    throw new Error('Reconciliation source transaction is unavailable.');
  }
  const targetResponse = await dependencies.adapter.execute({
    kind: 'read-actual-target',
    target: { id: candidate.actualTransactionId, kind: 'transaction' },
  });
  if (targetResponse.kind !== 'read-actual-target') {
    throw new Error('Actual returned an unexpected reconciliation target.');
  }
  if (
    targetResponse.target !== null &&
    targetResponse.target.parent.id !== candidate.actualTransactionId
  ) {
    throw new Error('Actual returned an unexpected reconciliation target.');
  }
  const snapshotResponse = await dependencies.adapter.execute({
    kind: 'read-budget-snapshot',
    sections: ['accounts', 'payees'],
  });
  if (
    snapshotResponse.kind !== 'read-budget-snapshot' ||
    snapshotResponse.snapshot.budget.budgetKeyHash !==
      dependencies.budgetKeyHash ||
    snapshotResponse.snapshot.budget.currencyCode !== dependencies.currencyCode
  ) {
    throw new Error('Actual returned an unexpected reconciliation snapshot.');
  }
  const accounts = new Map(
    (snapshotResponse.snapshot.accounts ?? []).map(account => [
      account.id,
      account.name,
    ]),
  );
  const payees = new Map(
    (snapshotResponse.snapshot.payees ?? []).map(payee => [
      payee.id,
      payee.name,
    ]),
  );
  const actual = targetResponse.target?.parent ?? null;
  return {
    currencyCode: dependencies.currencyCode,
    source: {
      date: source.postedDate ?? source.transactionDate,
      amountMinorUnits: source.amount,
      merchant: displayLabel(source.importedPayee ?? source.normalizedPayeeKey),
      accountName: displayLabel(accounts.get(source.actualAccountId)),
      state: capitalize(source.bookingStatus),
    },
    actual:
      actual === null
        ? null
        : {
            date: actual.date,
            amountMinorUnits: actual.amountMinorUnits,
            merchant: displayLabel(
              actual.importedPayee ??
                (actual.payeeId === null
                  ? undefined
                  : payees.get(actual.payeeId)),
            ),
            accountName: displayLabel(accounts.get(actual.accountId)),
            state: actual.cleared ? 'Cleared' : 'Uncleared',
          },
  };
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

function capitalize(
  value: 'unknown' | 'pending' | 'posted',
): 'Unknown' | 'Pending' | 'Posted' {
  if (value === 'pending') return 'Pending';
  if (value === 'posted') return 'Posted';
  return 'Unknown';
}

function confidenceLabel(score: number): string {
  if (score >= 90) return 'Strong match';
  if (score >= 75) return 'Likely match';
  if (score >= 60) return 'Possible match';
  return 'Low-confidence match';
}
