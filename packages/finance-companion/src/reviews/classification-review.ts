import { createHmac } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionGraphV1,
} from '#contracts/adapter';
import type {
  CategoryProposalV1,
  ClassificationReasonCode,
  MerchantAliasProposalV1,
} from '#reviews/classification';
import {
  assertClassificationTimestamp,
  validateCategoryProposal,
} from '#reviews/classification';

export type ClassificationReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'applied';

export type ClassificationReviewAction = 'categorize_once' | 'create_rule';

export type ClassificationReviewRecordV1 = Readonly<{
  proposal: MerchantAliasProposalV1 | CategoryProposalV1;
  status: ClassificationReviewStatus;
  selectedAction: ClassificationReviewAction | null;
  createdAt: string;
  decidedAt: string | null;
}>;

export type ClassificationReviewRepository = Readonly<{
  listClassificationReviews(): readonly ClassificationReviewRecordV1[];
  recordClassificationDecision(
    record: ClassificationReviewRecordV1,
    status: 'approved' | 'rejected',
    selectedAction: ClassificationReviewAction | null,
    decidedAt: string,
  ): ClassificationReviewRecordV1;
  markClassificationReviewStale(
    record: ClassificationReviewRecordV1,
  ): ClassificationReviewRecordV1;
}>;

type ClassificationReviewSummaryDtoV1 = Readonly<{
  version: 1;
  reviewRef: string;
  kind: 'merchant' | 'category';
  title: string;
  status: ClassificationReviewStatus;
  confidence: number;
  confidenceLabel: string;
  reasons: readonly string[];
  selectedAction: ClassificationReviewAction | null;
  createdAt: string;
  decidedAt: string | null;
}>;

export type ClassificationReviewListDtoV1 = Readonly<{
  version: 1;
  reviews: readonly ClassificationReviewSummaryDtoV1[];
}>;

type MerchantEvidenceDtoV1 = Readonly<{
  kind: 'merchant';
  importedMerchantLabels: readonly string[];
  currentPayee: string;
  proposedPayee: string;
  evidenceTransactionCount: number;
}>;

type CategoryEvidenceDtoV1 = Readonly<{
  kind: 'category';
  currencyCode: string;
  current: Readonly<{
    date: string;
    amountMinorUnits: number;
    account: string;
    payee: string;
    category: string;
    state: 'Uncleared' | 'Cleared';
  }> | null;
  proposedCategory: string;
  matchingHistoryCount: number;
  eligibleHistoryCount: number;
}>;

export type ClassificationReviewDetailDtoV1 = ClassificationReviewSummaryDtoV1 &
  Readonly<{
    allowedActions: readonly ClassificationReviewAction[];
    evidence: MerchantEvidenceDtoV1 | CategoryEvidenceDtoV1;
    guidance: string | null;
  }>;

export type ClassificationReviewDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: ClassificationReviewRepository;
  budgetKeyHash: string;
  currencyCode: string;
}>;

const reasonLabels: Readonly<Record<ClassificationReasonCode, string>> = {
  'consistent-imported-payee-alias':
    'The imported merchant consistently maps to one Actual payee',
  'conflicting-payee-alias':
    'The imported merchant maps to more than one Actual payee',
  'dominant-category-history':
    'This payee and account have a dominant category history',
  'insufficient-history': 'There is not enough category history',
  'ambiguous-category-history': 'Category history is ambiguous',
  'target-already-categorized': 'The transaction already has a category',
  'target-reconciled': 'The transaction is reconciled',
  'target-split': 'The transaction is split',
  'target-stale': 'Actual changed after this suggestion was created',
  'payee-deleted': 'The Actual payee is no longer available',
  'category-deleted': 'The Actual category is no longer available',
  suppressed: 'A matching suggestion or rule is already handled',
};

export function createClassificationReviewListDto(
  repository: ClassificationReviewRepository,
  budgetKeyHash: string,
): ClassificationReviewListDtoV1 {
  return {
    version: 1,
    reviews: repository
      .listClassificationReviews()
      .map(record => createSummary(record, budgetKeyHash)),
  };
}

export async function readClassificationReviewDetail(
  reviewRef: string,
  dependencies: ClassificationReviewDependencies,
): Promise<ClassificationReviewDetailDtoV1 | null> {
  const record = resolveReviewRecord(
    reviewRef,
    dependencies.repository,
    dependencies.budgetKeyHash,
  );
  if (record === null) return null;
  const revalidated = await revalidateRecord(record, dependencies);
  const currentRecord =
    !revalidated.isCurrent &&
    (record.status === 'pending' || record.status === 'approved')
      ? dependencies.repository.markClassificationReviewStale(record)
      : record;
  return createDetail(
    currentRecord,
    dependencies.budgetKeyHash,
    revalidated.evidence,
  );
}

export async function decideClassificationReview(
  request: Readonly<{
    reviewRef: string;
    decision: 'approve' | 'reject';
    action: ClassificationReviewAction | null;
    decidedAt: string;
  }>,
  dependencies: ClassificationReviewDependencies,
): Promise<ClassificationReviewDetailDtoV1 | null> {
  assertClassificationTimestamp(request.decidedAt);
  const record = resolveReviewRecord(
    request.reviewRef,
    dependencies.repository,
    dependencies.budgetKeyHash,
  );
  if (record === null) return null;
  if (record.status !== 'pending') {
    throw new Error('Classification review is not pending.');
  }
  assertDecisionIsAllowed(record, request.decision, request.action);
  const revalidated = await revalidateRecord(record, dependencies);
  if (!revalidated.isCurrent) {
    const stale = dependencies.repository.markClassificationReviewStale(record);
    return createDetail(
      stale,
      dependencies.budgetKeyHash,
      revalidated.evidence,
    );
  }
  const decided = dependencies.repository.recordClassificationDecision(
    record,
    request.decision === 'approve' ? 'approved' : 'rejected',
    request.decision === 'approve' ? request.action : null,
    request.decidedAt,
  );
  return createDetail(
    decided,
    dependencies.budgetKeyHash,
    revalidated.evidence,
  );
}

export function createClassificationReviewRef(
  record: ClassificationReviewRecordV1,
  budgetKeyHash: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(budgetKeyHash)) {
    throw new TypeError('Classification review key is invalid.');
  }
  const proposalId =
    record.proposal.kind === 'merchant-alias'
      ? record.proposal.proposalId
      : record.proposal.reviewId;
  const token = createHmac('sha256', Buffer.from(budgetKeyHash, 'hex'))
    .update('finance-companion/classification-review/v1\0')
    .update(record.proposal.kind)
    .update('\0')
    .update(proposalId)
    .digest('base64url');
  return `classification_${token}`;
}

function resolveReviewRecord(
  reviewRef: string,
  repository: ClassificationReviewRepository,
  budgetKeyHash: string,
): ClassificationReviewRecordV1 | null {
  if (!/^classification_[A-Za-z0-9_-]{43}$/.test(reviewRef)) return null;
  const matching = repository
    .listClassificationReviews()
    .filter(
      record =>
        createClassificationReviewRef(record, budgetKeyHash) === reviewRef,
    );
  return matching.length === 1 ? matching[0] : null;
}

function createSummary(
  record: ClassificationReviewRecordV1,
  budgetKeyHash: string,
): ClassificationReviewSummaryDtoV1 {
  return {
    version: 1,
    reviewRef: createClassificationReviewRef(record, budgetKeyHash),
    kind: record.proposal.kind === 'merchant-alias' ? 'merchant' : 'category',
    title:
      record.proposal.kind === 'merchant-alias'
        ? 'Merchant payee suggestion'
        : 'Transaction category suggestion',
    status: record.status,
    confidence: record.proposal.confidence,
    confidenceLabel: confidenceLabel(record.proposal.confidence),
    reasons: record.proposal.reasonCodes.map(reason => reasonLabels[reason]),
    selectedAction: record.selectedAction,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  };
}

function createDetail(
  record: ClassificationReviewRecordV1,
  budgetKeyHash: string,
  evidence: MerchantEvidenceDtoV1 | CategoryEvidenceDtoV1,
): ClassificationReviewDetailDtoV1 {
  return {
    ...createSummary(record, budgetKeyHash),
    allowedActions:
      record.status !== 'pending'
        ? []
        : record.proposal.kind === 'merchant-alias'
          ? ['create_rule']
          : ['categorize_once', 'create_rule'],
    evidence,
    guidance: guidanceFor(record),
  };
}

async function revalidateRecord(
  record: ClassificationReviewRecordV1,
  dependencies: ClassificationReviewDependencies,
): Promise<
  Readonly<{
    isCurrent: boolean;
    evidence: MerchantEvidenceDtoV1 | CategoryEvidenceDtoV1;
  }>
> {
  if (record.proposal.kind === 'merchant-alias') {
    const proposal = record.proposal;
    const snapshot = await readBoundSnapshot(dependencies, ['payees']);
    const payee = (snapshot.payees ?? []).find(
      candidate => candidate.id === proposal.proposedPayeeId,
    );
    const label = displayLabel(payee?.name);
    return {
      isCurrent: payee !== undefined && payee.transferAccountId === null,
      evidence: {
        kind: 'merchant',
        importedMerchantLabels: proposal.sourceSpellings.map(displayLabel),
        currentPayee: label,
        proposedPayee: label,
        evidenceTransactionCount: proposal.evidenceTransactionIds.length,
      },
    };
  }

  const targetResponse = await dependencies.adapter.execute({
    kind: 'read-actual-target',
    target: { id: record.proposal.transactionId, kind: 'transaction' },
  });
  if (targetResponse.kind !== 'read-actual-target') {
    throw new Error('Actual returned an unexpected classification target.');
  }
  const snapshot = await readBoundSnapshot(dependencies, [
    'accounts',
    'payees',
    'categories',
  ]);
  const graph = targetResponse.target;
  const validationSnapshot: ActualBudgetSnapshotV1 = {
    ...snapshot,
    transactions: graph === null ? [] : [graph.parent, ...graph.children],
  };
  const validation = validateCategoryProposal(
    record.proposal,
    validationSnapshot,
  );
  return {
    isCurrent:
      validation.isCurrent && targetMatchesProposal(graph, record.proposal),
    evidence: categoryEvidence(record.proposal, graph, snapshot),
  };
}

async function readBoundSnapshot(
  dependencies: ClassificationReviewDependencies,
  sections: readonly ('accounts' | 'payees' | 'categories')[],
): Promise<ActualBudgetSnapshotV1> {
  const response = await dependencies.adapter.execute({
    kind: 'read-budget-snapshot',
    sections,
  });
  if (
    response.kind !== 'read-budget-snapshot' ||
    response.snapshot.budget.budgetKeyHash !== dependencies.budgetKeyHash ||
    response.snapshot.budget.currencyCode !== dependencies.currencyCode
  ) {
    throw new Error('Actual returned an unexpected classification snapshot.');
  }
  return response.snapshot;
}

function categoryEvidence(
  proposal: CategoryProposalV1,
  graph: ActualTransactionGraphV1 | null,
  snapshot: ActualBudgetSnapshotV1,
): CategoryEvidenceDtoV1 {
  const accounts = new Map(
    (snapshot.accounts ?? []).map(account => [account.id, account.name]),
  );
  const payees = new Map(
    (snapshot.payees ?? []).map(payee => [payee.id, payee.name]),
  );
  const categories = new Map(
    (snapshot.categories ?? []).map(category => [category.id, category.name]),
  );
  const transaction = graph?.parent ?? null;
  return {
    kind: 'category',
    currencyCode: snapshot.budget.currencyCode,
    current:
      transaction === null
        ? null
        : {
            date: transaction.date,
            amountMinorUnits: transaction.amountMinorUnits,
            account: displayLabel(accounts.get(transaction.accountId)),
            payee: displayLabel(
              transaction.payeeId === null
                ? transaction.importedPayee
                : payees.get(transaction.payeeId),
            ),
            category:
              transaction.categoryId === null
                ? 'Uncategorized'
                : displayLabel(categories.get(transaction.categoryId)),
            state: transaction.cleared ? 'Cleared' : 'Uncleared',
          },
    proposedCategory: displayLabel(categories.get(proposal.proposedCategoryId)),
    matchingHistoryCount: proposal.proposedCategoryCount,
    eligibleHistoryCount: proposal.eligibleHistoryCount,
  };
}

function targetMatchesProposal(
  graph: ActualTransactionGraphV1 | null,
  proposal: CategoryProposalV1,
): boolean {
  return (
    graph !== null &&
    graph.parent.id === proposal.transactionId &&
    graph.targetVersionHash === proposal.targetVersionHash
  );
}

function assertDecisionIsAllowed(
  record: ClassificationReviewRecordV1,
  decision: 'approve' | 'reject',
  action: ClassificationReviewAction | null,
): void {
  if (decision === 'reject') {
    if (action !== null) {
      throw new Error('A rejection cannot select an action.');
    }
    return;
  }
  if (action === null) {
    throw new Error('Approval requires an explicit action.');
  }
  if (record.proposal.kind === 'merchant-alias' && action !== 'create_rule') {
    throw new Error('Merchant approval requires create_rule.');
  }
}

function guidanceFor(record: ClassificationReviewRecordV1): string | null {
  if (record.status !== 'approved') return null;
  if (record.selectedAction === 'categorize_once') {
    return 'Open this transaction in Actual and set the proposed category once. Finance Companion did not change the transaction or create a rule.';
  }
  if (record.proposal.kind === 'merchant-alias') {
    return 'In Actual, create a payee rename rule for the shown imported merchant labels and proposed payee. Finance Companion did not create a rule or change any transaction.';
  }
  return 'In Actual, create a category rule for this payee and account that only targets uncategorized, unreconciled transactions. Finance Companion did not create a rule or change any transaction.';
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 90) return 'Strong confidence';
  if (confidence >= 80) return 'High confidence';
  if (confidence >= 70) return 'Moderate confidence';
  return 'Low confidence';
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
