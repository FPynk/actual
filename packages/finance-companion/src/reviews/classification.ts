import { createHash } from 'node:crypto';

import { canonicalJson } from '#actual/canonical-json';
import type {
  ActualBudgetSnapshotV1,
  ActualCategoryV1,
  ActualPayeeV1,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';

export const classificationDetectorVersion = 1 as const;
const rejectionSuppressionMilliseconds = 180 * 24 * 60 * 60 * 1000;

export const classificationReasonCodes = [
  'consistent-imported-payee-alias',
  'conflicting-payee-alias',
  'dominant-category-history',
  'insufficient-history',
  'ambiguous-category-history',
  'target-already-categorized',
  'target-reconciled',
  'target-split',
  'target-stale',
  'payee-deleted',
  'category-deleted',
  'suppressed',
] as const;

export type ClassificationReasonCode =
  (typeof classificationReasonCodes)[number];

export type MerchantAliasProposalV1 = Readonly<{
  kind: 'merchant-alias';
  proposalId: string;
  normalizedImportedPayee: string;
  sourceSpellings: readonly string[];
  proposedPayeeId: string;
  evidenceTransactionIds: readonly string[];
  confidence: number;
  reasonCodes: readonly ClassificationReasonCode[];
  detectorVersion: typeof classificationDetectorVersion;
}>;

export type CategoryProposalV1 = Readonly<{
  kind: 'category';
  reviewId: string;
  transactionId: string;
  targetVersionHash: string;
  accountId: string;
  payeeId: string;
  proposedCategoryId: string;
  eligibleHistoryCount: number;
  proposedCategoryCount: number;
  confidence: number;
  reasonCodes: readonly ClassificationReasonCode[];
  detectorVersion: typeof classificationDetectorVersion;
}>;

export type ClassificationIntentV1 =
  | Readonly<{ kind: 'categorize_once' }>
  | Readonly<{
      kind: 'create_category_rule';
      expectedRuleSetHash: string;
    }>
  | Readonly<{
      kind: 'create_payee_rename_rule';
      expectedRuleSetHash: string;
    }>;

export type SupportedClassificationRuleV1 =
  | Readonly<{
      kind: 'category';
      payeeId: string;
      accountId: string;
      categoryId: string;
    }>
  | Readonly<{
      kind: 'payee-rename';
      sourceSpellings: readonly string[];
      payeeId: string;
    }>;

export type ClassificationRuleSetEntryV1 = Readonly<
  | {
      kind: 'supported';
      ruleId: string;
      ruleVersionHash: string;
      rule: SupportedClassificationRuleV1;
    }
  | {
      kind: 'unsupported';
      ruleId: string;
      ruleVersionHash: string;
    }
>;

export type ClassificationRuleSetSnapshotV1 = Readonly<{
  contractVersion: 1;
  completeness: 'complete';
  entries: readonly ClassificationRuleSetEntryV1[];
  ruleSetHash: string;
}>;

export type ClassificationProposalRecordV1 = Readonly<{
  proposal: MerchantAliasProposalV1 | CategoryProposalV1;
  availableIntents: readonly ClassificationIntentV1[];
}>;

export type ClassificationSuppressionV1 = Readonly<{
  kind: 'merchant-alias' | 'category';
  subjectId: string;
  reasonCodes: readonly ClassificationReasonCode[];
  ruleStatus?: 'equivalent' | 'competing' | 'unsupported';
}>;

export type ClassificationDetectionResultV1 = Readonly<{
  proposals: readonly ClassificationProposalRecordV1[];
  suppressions: readonly ClassificationSuppressionV1[];
}>;

export type ClassificationProposalRepository = Readonly<{
  findPendingMerchantAlias(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
  ): MerchantAliasProposalV1 | undefined;
  findPendingCategory(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
  ): CategoryProposalV1 | undefined;
  isMerchantAliasRejected(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean;
  isCategoryRejected(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean;
  savePendingMerchantAlias(
    proposal: MerchantAliasProposalV1,
    evaluatedAt: string,
  ): void;
  savePendingCategory(proposal: CategoryProposalV1, evaluatedAt: string): void;
}>;

export type ClassificationDetectionRequestV1 = Readonly<{
  snapshot: ActualBudgetSnapshotV1;
  boundBudgetCurrency: string;
  evaluatedAt: string;
  repository: ClassificationProposalRepository;
  ruleSetSnapshot: ClassificationRuleSetSnapshotV1;
}>;

export type CategoryProposalValidationV1 = Readonly<{
  isCurrent: boolean;
  reasonCodes: readonly ClassificationReasonCode[];
}>;

export type RuleIntentValidationV1 = Readonly<{
  isCurrent: boolean;
  reasonCodes: readonly ClassificationReasonCode[];
  ruleStatus?: 'equivalent' | 'competing' | 'unsupported';
}>;

export function normalizeImportedPayeeV1(importedPayee: string): string {
  return importedPayee
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function assertClassificationTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error('Classification timestamp is invalid.');
  }
}

export function createClassificationRuleSetSnapshot(
  entries: readonly ClassificationRuleSetEntryV1[],
): ClassificationRuleSetSnapshotV1 {
  const canonicalEntries = [...entries]
    .map(canonicalizeRuleSetEntry)
    .sort((left, right) => compareUtf8(left.ruleId, right.ruleId));
  if (
    new Set(canonicalEntries.map(entry => entry.ruleId)).size !==
    canonicalEntries.length
  ) {
    throw new Error('Classification rule-set contains duplicate rule IDs.');
  }
  const canonicalRuleSet = {
    completeness: 'complete' as const,
    contractVersion: 1 as const,
    entries: canonicalEntries,
  };
  return {
    ...canonicalRuleSet,
    ruleSetHash: hashWithDomain(
      'finance-companion/classification-rule-set/v1\0',
      canonicalRuleSet,
    ),
  };
}

export function detectClassificationProposals(
  request: ClassificationDetectionRequestV1,
): ClassificationDetectionResultV1 {
  assertRequestIsBoundToSnapshot(request);
  assertRuleSetSnapshot(request.ruleSetSnapshot);
  const ruleSetSnapshot = request.ruleSetSnapshot;
  const livePayees = new Map(
    (request.snapshot.payees ?? []).map(payee => [payee.id, payee]),
  );
  const liveCategories = new Map(
    (request.snapshot.categories ?? []).map(category => [
      category.id,
      category,
    ]),
  );
  const transactions = request.snapshot.transactions ?? [];
  const proposals: ClassificationProposalRecordV1[] = [];
  const suppressions: ClassificationSuppressionV1[] = [];

  for (const [
    normalizedImportedPayee,
    aliasTransactions,
  ] of groupByNormalizedImportedPayee(transactions)) {
    const aliasResult = detectMerchantAliasProposal(
      normalizedImportedPayee,
      aliasTransactions,
      livePayees,
      ruleSetSnapshot,
      request,
    );
    if (aliasResult.proposal !== undefined) {
      proposals.push(aliasResult.proposal);
    }
    if (aliasResult.suppression !== undefined) {
      suppressions.push(aliasResult.suppression);
    }
  }

  for (const transaction of transactions) {
    const categoryResult = detectCategoryProposal(
      transaction,
      transactions,
      livePayees,
      liveCategories,
      ruleSetSnapshot,
      request,
    );
    if (categoryResult.proposal !== undefined) {
      proposals.push(categoryResult.proposal);
    }
    if (categoryResult.suppression !== undefined) {
      suppressions.push(categoryResult.suppression);
    }
  }

  return { proposals, suppressions };
}

export function validateCategoryProposal(
  proposal: CategoryProposalV1,
  snapshot: ActualBudgetSnapshotV1,
): CategoryProposalValidationV1 {
  const transaction = (snapshot.transactions ?? []).find(
    candidate => candidate.id === proposal.transactionId,
  );
  const payees = new Map(
    (snapshot.payees ?? []).map(payee => [payee.id, payee]),
  );
  const categories = new Map(
    (snapshot.categories ?? []).map(category => [category.id, category]),
  );
  const reasonCodes: ClassificationReasonCode[] = [];
  if (transaction === undefined || transaction.tombstone) {
    reasonCodes.push('target-stale');
  } else {
    if (
      !hasCurrentTargetGraph(transaction, snapshot.transactions ?? [], proposal)
    ) {
      reasonCodes.push('target-stale');
    }
    if (transaction.reconciled) reasonCodes.push('target-reconciled');
    if (isSplitTransaction(transaction)) reasonCodes.push('target-split');
    if (transaction.categoryId !== null) {
      reasonCodes.push('target-already-categorized');
    }
    if (
      transaction.payeeId !== proposal.payeeId ||
      transaction.accountId !== proposal.accountId
    ) {
      reasonCodes.push('target-stale');
    }
  }
  if (!payees.has(proposal.payeeId)) reasonCodes.push('payee-deleted');
  if (!categories.has(proposal.proposedCategoryId)) {
    reasonCodes.push('category-deleted');
  }
  if (reasonCodes.length > 0 && !reasonCodes.includes('target-stale')) {
    reasonCodes.push('target-stale');
  }
  return { isCurrent: reasonCodes.length === 0, reasonCodes };
}

export function validateClassificationRuleIntent(
  intent: Exclude<
    ClassificationIntentV1,
    Readonly<{ kind: 'categorize_once' }>
  >,
  ruleSetSnapshot: ClassificationRuleSetSnapshotV1,
  expectedRule: SupportedClassificationRuleV1,
): RuleIntentValidationV1 {
  assertRuleSetSnapshot(ruleSetSnapshot);
  if (intent.expectedRuleSetHash !== ruleSetSnapshot.ruleSetHash) {
    return { isCurrent: false, reasonCodes: ['target-stale'] };
  }
  const ruleStatus =
    expectedRule.kind === 'category'
      ? categoryRuleStatus(
          expectedRule.payeeId,
          expectedRule.accountId,
          expectedRule.categoryId,
          ruleSetSnapshot.entries,
        )
      : payeeRenameRuleStatus(
          expectedRule.sourceSpellings,
          expectedRule.payeeId,
          ruleSetSnapshot.entries,
        );
  if (ruleStatus !== undefined) {
    return { isCurrent: false, reasonCodes: ['suppressed'], ruleStatus };
  }
  return { isCurrent: true, reasonCodes: [] };
}

export function targetVersionHash(
  graph: Pick<
    ActualTransactionGraphV1,
    'contractVersion' | 'parent' | 'children'
  >,
): string {
  const canonicalGraph = canonicalTransactionGraph(graph);
  return hashWithDomain(
    'finance-companion/actual-transaction-graph/v1\0',
    canonicalGraph,
  );
}

export function merchantAliasProposalId(
  normalizedImportedPayee: string,
  payeeId: string,
  detectorVersion: number,
): string {
  return proposalId({
    detectorVersion,
    kind: 'merchant-alias',
    normalizedImportedPayee,
    payeeId,
  });
}

export function categoryProposalReviewId(
  transactionId: string,
  categoryId: string,
  targetHash: string,
  detectorVersion: number,
): string {
  return proposalId({
    categoryId,
    detectorVersion,
    kind: 'category',
    targetVersionHash: targetHash,
    transactionId,
  });
}

function detectMerchantAliasProposal(
  normalizedImportedPayee: string,
  transactions: readonly ActualTransactionV1[],
  payees: ReadonlyMap<string, ActualPayeeV1>,
  ruleSetSnapshot: ClassificationRuleSetSnapshotV1,
  request: ClassificationDetectionRequestV1,
): Readonly<{
  proposal?: ClassificationProposalRecordV1;
  suppression?: ClassificationSuppressionV1;
}> {
  const eligibleTransactions = transactions.filter(
    isEligibleEvidenceTransaction,
  );
  if (eligibleTransactions.length === 0) return {};
  const resolvedTransactions = eligibleTransactions.map(transaction => ({
    payee:
      transaction.payeeId === null
        ? undefined
        : payees.get(transaction.payeeId),
    transaction,
  }));
  if (resolvedTransactions.some(({ payee }) => payee === undefined)) {
    return suppressedAlias(normalizedImportedPayee, [
      'payee-deleted',
      'target-stale',
    ]);
  }
  const nonTransferTransactions = resolvedTransactions.filter(
    (
      resolvedTransaction,
    ): resolvedTransaction is Readonly<{
      transaction: ActualTransactionV1;
      payee: ActualPayeeV1;
    }> => resolvedTransaction.payee?.transferAccountId === null,
  );
  const eligiblePayeeIds = new Set(
    nonTransferTransactions.map(({ payee }) => payee.id),
  );
  if (eligiblePayeeIds.size > 1) {
    return suppressedAlias(normalizedImportedPayee, [
      'conflicting-payee-alias',
    ]);
  }
  const [payeeId] = eligiblePayeeIds;
  const evidenceTransactions = uniqueTransactionsById(
    nonTransferTransactions.map(({ transaction }) => transaction),
  );
  if (payeeId === undefined || evidenceTransactions.length < 2) return {};
  if (
    request.repository.isMerchantAliasRejected(
      normalizedImportedPayee,
      payeeId,
      classificationDetectorVersion,
      request.evaluatedAt,
    )
  ) {
    return suppressedAlias(normalizedImportedPayee, ['suppressed']);
  }
  const existingProposal = request.repository.findPendingMerchantAlias(
    normalizedImportedPayee,
    payeeId,
    classificationDetectorVersion,
  );
  const proposal =
    existingProposal ??
    createMerchantAliasProposal(
      normalizedImportedPayee,
      evidenceTransactions,
      payeeId,
    );
  const ruleStatus = payeeRenameRuleStatus(
    proposal.sourceSpellings,
    proposal.proposedPayeeId,
    ruleSetSnapshot.entries,
  );
  if (ruleStatus !== undefined) {
    return suppressedAlias(normalizedImportedPayee, ['suppressed'], ruleStatus);
  }
  if (existingProposal === undefined) {
    request.repository.savePendingMerchantAlias(proposal, request.evaluatedAt);
  }
  return {
    proposal: {
      availableIntents: [
        {
          expectedRuleSetHash: ruleSetSnapshot.ruleSetHash,
          kind: 'create_payee_rename_rule',
        },
      ],
      proposal,
    },
  };
}

function detectCategoryProposal(
  transaction: ActualTransactionV1,
  allTransactions: readonly ActualTransactionV1[],
  payees: ReadonlyMap<string, ActualPayeeV1>,
  categories: ReadonlyMap<string, ActualCategoryV1>,
  ruleSetSnapshot: ClassificationRuleSetSnapshotV1,
  request: ClassificationDetectionRequestV1,
): Readonly<{
  proposal?: ClassificationProposalRecordV1;
  suppression?: ClassificationSuppressionV1;
}> {
  const targetSuppression = categoryTargetSuppression(transaction, payees);
  if (targetSuppression !== undefined) return targetSuppression;
  if (transaction.payeeId === null) return {};
  const history = allTransactions.filter(
    candidate =>
      candidate.id !== transaction.id &&
      candidate.accountId === transaction.accountId &&
      candidate.payeeId === transaction.payeeId &&
      isEligibleEvidenceTransaction(candidate) &&
      candidate.categoryId !== null,
  );
  if (history.length < 3) {
    return suppressedCategory(transaction.id, ['insufficient-history']);
  }
  const categoryCounts = new Map<string, number>();
  for (const historicalTransaction of history) {
    const categoryId = historicalTransaction.categoryId;
    if (categoryId === null) continue;
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + 1);
  }
  const rankedCategories = [...categoryCounts.entries()].sort(
    ([firstCategoryId, firstCount], [secondCategoryId, secondCount]) =>
      secondCount - firstCount ||
      compareUtf8(firstCategoryId, secondCategoryId),
  );
  const [proposedCategoryId, proposedCategoryCount] = rankedCategories[0] ?? [];
  if (proposedCategoryId === undefined || proposedCategoryCount === undefined) {
    return suppressedCategory(transaction.id, ['insufficient-history']);
  }
  if (!categories.has(proposedCategoryId)) {
    return suppressedCategory(transaction.id, [
      'category-deleted',
      'target-stale',
    ]);
  }
  if (
    proposedCategoryCount < 3 ||
    proposedCategoryCount * 5 < history.length * 4
  ) {
    return suppressedCategory(transaction.id, ['ambiguous-category-history']);
  }
  const confidence = Math.round((proposedCategoryCount / history.length) * 100);
  const targetHash = targetVersionHash(
    transactionGraphFor(transaction, allTransactions),
  );
  if (
    request.repository.isCategoryRejected(
      transaction.id,
      proposedCategoryId,
      targetHash,
      classificationDetectorVersion,
      request.evaluatedAt,
    )
  ) {
    return suppressedCategory(transaction.id, ['suppressed']);
  }
  const existingProposal = request.repository.findPendingCategory(
    transaction.id,
    proposedCategoryId,
    targetHash,
    classificationDetectorVersion,
  );
  const proposal =
    existingProposal ??
    createCategoryProposal(
      transaction,
      transaction.payeeId,
      proposedCategoryId,
      targetHash,
      history.length,
      proposedCategoryCount,
      confidence,
    );
  const ruleStatus = categoryRuleStatus(
    proposal.payeeId,
    proposal.accountId,
    proposal.proposedCategoryId,
    ruleSetSnapshot.entries,
  );
  if (ruleStatus !== undefined) {
    if (existingProposal === undefined) {
      request.repository.savePendingCategory(proposal, request.evaluatedAt);
    }
    return {
      proposal: { availableIntents: [{ kind: 'categorize_once' }], proposal },
      ...suppressedCategory(transaction.id, ['suppressed'], ruleStatus),
    };
  }
  if (existingProposal === undefined) {
    request.repository.savePendingCategory(proposal, request.evaluatedAt);
  }
  return {
    proposal: {
      availableIntents: [
        { kind: 'categorize_once' },
        {
          expectedRuleSetHash: ruleSetSnapshot.ruleSetHash,
          kind: 'create_category_rule',
        },
      ],
      proposal,
    },
  };
}

function categoryTargetSuppression(
  transaction: ActualTransactionV1,
  payees: ReadonlyMap<string, ActualPayeeV1>,
): Readonly<{ suppression: ClassificationSuppressionV1 }> | undefined {
  if (!hasUsableImportedPayee(transaction) || transaction.payeeId === null) {
    return undefined;
  }
  if (transaction.tombstone) {
    return suppressedCategory(transaction.id, ['target-stale']);
  }
  if (!payees.has(transaction.payeeId)) {
    return suppressedCategory(transaction.id, [
      'payee-deleted',
      'target-stale',
    ]);
  }
  if (transaction.reconciled) {
    return suppressedCategory(transaction.id, ['target-reconciled']);
  }
  if (isSplitTransaction(transaction)) {
    return suppressedCategory(transaction.id, ['target-split']);
  }
  if (transaction.categoryId !== null) {
    return suppressedCategory(transaction.id, ['target-already-categorized']);
  }
  if (!isEligibleEvidenceTransaction(transaction)) return undefined;
  return undefined;
}

function createMerchantAliasProposal(
  normalizedImportedPayee: string,
  transactions: readonly ActualTransactionV1[],
  payeeId: string,
): MerchantAliasProposalV1 {
  const sourceSpellings = [
    ...new Set(
      transactions
        .map(transaction => transaction.importedPayee)
        .filter(
          (importedPayee): importedPayee is string => importedPayee !== null,
        )
        .filter(
          importedPayee => normalizeImportedPayeeV1(importedPayee) !== '',
        ),
    ),
  ]
    .sort(compareUtf8)
    .slice(0, 20);
  const evidenceTransactionIds = [
    ...new Set(transactions.map(transaction => transaction.id)),
  ].sort(compareUtf8);
  return {
    confidence: Math.min(100, 60 + 10 * evidenceTransactionIds.length),
    detectorVersion: classificationDetectorVersion,
    evidenceTransactionIds,
    kind: 'merchant-alias',
    normalizedImportedPayee,
    proposalId: merchantAliasProposalId(
      normalizedImportedPayee,
      payeeId,
      classificationDetectorVersion,
    ),
    proposedPayeeId: payeeId,
    reasonCodes: ['consistent-imported-payee-alias'],
    sourceSpellings,
  };
}

function createCategoryProposal(
  transaction: ActualTransactionV1,
  payeeId: string,
  proposedCategoryId: string,
  targetHash: string,
  eligibleHistoryCount: number,
  proposedCategoryCount: number,
  confidence: number,
): CategoryProposalV1 {
  return {
    accountId: transaction.accountId,
    confidence,
    detectorVersion: classificationDetectorVersion,
    eligibleHistoryCount,
    kind: 'category',
    payeeId,
    proposedCategoryCount,
    proposedCategoryId,
    reasonCodes: ['dominant-category-history'],
    reviewId: categoryProposalReviewId(
      transaction.id,
      proposedCategoryId,
      targetHash,
      classificationDetectorVersion,
    ),
    targetVersionHash: targetHash,
    transactionId: transaction.id,
  };
}

function groupByNormalizedImportedPayee(
  transactions: readonly ActualTransactionV1[],
): ReadonlyMap<string, readonly ActualTransactionV1[]> {
  const groupedTransactions = new Map<string, ActualTransactionV1[]>();
  for (const transaction of transactions) {
    if (!hasUsableImportedPayee(transaction)) continue;
    const normalizedImportedPayee = normalizeImportedPayeeV1(
      transaction.importedPayee,
    );
    const grouped = groupedTransactions.get(normalizedImportedPayee) ?? [];
    grouped.push(transaction);
    groupedTransactions.set(normalizedImportedPayee, grouped);
  }
  return groupedTransactions;
}

function isEligibleEvidenceTransaction(
  transaction: ActualTransactionV1,
): boolean {
  return (
    hasUsableImportedPayee(transaction) &&
    transaction.payeeId !== null &&
    !transaction.tombstone &&
    !transaction.isStartingBalance &&
    transaction.transferId === null &&
    !isSplitTransaction(transaction)
  );
}

function hasUsableImportedPayee(
  transaction: ActualTransactionV1,
): transaction is ActualTransactionV1 & Readonly<{ importedPayee: string }> {
  return (
    transaction.importedPayee !== null &&
    normalizeImportedPayeeV1(transaction.importedPayee) !== ''
  );
}

function isSplitTransaction(transaction: ActualTransactionV1): boolean {
  return (
    transaction.isParent || transaction.isChild || transaction.parentId !== null
  );
}

function uniqueTransactionsById(
  transactions: readonly ActualTransactionV1[],
): readonly ActualTransactionV1[] {
  return [
    ...new Map(
      transactions.map(transaction => [transaction.id, transaction]),
    ).values(),
  ];
}

function transactionGraphFor(
  transaction: ActualTransactionV1,
  transactions: readonly ActualTransactionV1[],
): Readonly<{
  contractVersion: 1;
  parent: ActualTransactionV1;
  children: readonly ActualTransactionV1[];
}> {
  const parent =
    transaction.isChild && transaction.parentId !== null
      ? transactions.find(candidate => candidate.id === transaction.parentId)
      : transaction;
  if (parent === undefined) {
    throw new Error('Classification target parent is missing.');
  }
  const children = transactions
    .filter(candidate => candidate.parentId === parent.id)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    );
  if (new Set(children.map(child => child.id)).size !== children.length) {
    throw new Error('Classification target has duplicate children.');
  }
  return { children, contractVersion: 1, parent };
}

function hasCurrentTargetGraph(
  transaction: ActualTransactionV1,
  transactions: readonly ActualTransactionV1[],
  proposal: CategoryProposalV1,
): boolean {
  try {
    return (
      targetVersionHash(transactionGraphFor(transaction, transactions)) ===
      proposal.targetVersionHash
    );
  } catch {
    return false;
  }
}

function canonicalTransactionGraph(
  graph: Pick<
    ActualTransactionGraphV1,
    'contractVersion' | 'parent' | 'children'
  >,
): Readonly<{
  contractVersion: 1;
  parent: ActualTransactionV1;
  children: readonly ActualTransactionV1[];
}> {
  if (graph.contractVersion !== 1) {
    throw new Error('Classification target graph contract is unsupported.');
  }
  const children = [...graph.children].sort((left, right) =>
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
  );
  if (new Set(children.map(child => child.id)).size !== children.length) {
    throw new Error('Classification target graph has duplicate children.');
  }
  return { children, contractVersion: 1, parent: graph.parent };
}

function canonicalizeSupportedRule(
  rule: SupportedClassificationRuleV1,
): SupportedClassificationRuleV1 {
  if (rule.kind === 'category') {
    if (!rule.payeeId || !rule.accountId || !rule.categoryId) {
      throw new Error('Category rule projection is invalid.');
    }
    return {
      accountId: rule.accountId,
      categoryId: rule.categoryId,
      kind: 'category',
      payeeId: rule.payeeId,
    };
  }
  if (!rule.payeeId) {
    throw new Error('Payee rename rule projection is invalid.');
  }
  const sourceSpellings = [...new Set(rule.sourceSpellings)]
    .filter(sourceSpelling => sourceSpelling.trim() !== '')
    .sort(compareUtf8);
  if (sourceSpellings.length === 0 || sourceSpellings.length > 20) {
    throw new Error('Payee rename rule spellings are invalid.');
  }
  return { kind: 'payee-rename', payeeId: rule.payeeId, sourceSpellings };
}

function canonicalizeRuleSetEntry(
  entry: ClassificationRuleSetEntryV1,
): ClassificationRuleSetEntryV1 {
  if (!entry.ruleId || !isHash(entry.ruleVersionHash)) {
    throw new Error('Classification rule-set entry is invalid.');
  }
  if (entry.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      ruleId: entry.ruleId,
      ruleVersionHash: entry.ruleVersionHash,
    };
  }
  return {
    kind: 'supported',
    rule: canonicalizeSupportedRule(entry.rule),
    ruleId: entry.ruleId,
    ruleVersionHash: entry.ruleVersionHash,
  };
}

function assertRuleSetSnapshot(
  snapshot: ClassificationRuleSetSnapshotV1 | undefined,
): asserts snapshot is ClassificationRuleSetSnapshotV1 {
  if (
    snapshot === undefined ||
    Object.keys(snapshot).length !== 4 ||
    !Object.keys(snapshot).every(key =>
      ['completeness', 'contractVersion', 'entries', 'ruleSetHash'].includes(
        key,
      ),
    ) ||
    snapshot.completeness !== 'complete'
  ) {
    throw new Error('Classification rule-set snapshot is incomplete.');
  }
  const expectedSnapshot = createClassificationRuleSetSnapshot(
    snapshot.entries,
  );
  if (
    snapshot.contractVersion !== expectedSnapshot.contractVersion ||
    canonicalJson(snapshot.entries) !==
      canonicalJson(expectedSnapshot.entries) ||
    snapshot.ruleSetHash !== expectedSnapshot.ruleSetHash
  ) {
    throw new Error('Classification rule-set snapshot is invalid.');
  }
}

function categoryRuleStatus(
  payeeId: string,
  accountId: string,
  categoryId: string,
  entries: readonly ClassificationRuleSetEntryV1[],
): 'equivalent' | 'competing' | 'unsupported' | undefined {
  let hasUnsupportedRule = false;
  let hasEquivalentRule = false;
  for (const entry of entries) {
    if (entry.kind === 'unsupported') {
      hasUnsupportedRule = true;
      continue;
    }
    const rule = entry.rule;
    if (
      rule.kind === 'category' &&
      rule.payeeId === payeeId &&
      rule.accountId === accountId
    ) {
      if (rule.categoryId !== categoryId) return 'competing';
      hasEquivalentRule = true;
    }
  }
  if (hasEquivalentRule) return 'equivalent';
  return hasUnsupportedRule ? 'unsupported' : undefined;
}

function payeeRenameRuleStatus(
  sourceSpellings: readonly string[],
  payeeId: string,
  entries: readonly ClassificationRuleSetEntryV1[],
): 'equivalent' | 'competing' | 'unsupported' | undefined {
  const expectedSpellings = new Set(sourceSpellings);
  let hasUnsupportedRule = false;
  let hasEquivalentRule = false;
  for (const entry of entries) {
    if (entry.kind === 'unsupported') {
      hasUnsupportedRule = true;
      continue;
    }
    const rule = entry.rule;
    if (rule.kind !== 'payee-rename') continue;
    const hasOverlap = rule.sourceSpellings.some(sourceSpelling =>
      expectedSpellings.has(sourceSpelling),
    );
    if (hasOverlap) {
      const isEquivalent =
        rule.payeeId === payeeId &&
        rule.sourceSpellings.length === expectedSpellings.size &&
        rule.sourceSpellings.every(sourceSpelling =>
          expectedSpellings.has(sourceSpelling),
        );
      if (!isEquivalent) return 'competing';
      hasEquivalentRule = true;
    }
  }
  if (hasEquivalentRule) return 'equivalent';
  return hasUnsupportedRule ? 'unsupported' : undefined;
}

function suppressedAlias(
  normalizedImportedPayee: string,
  reasonCodes: readonly ClassificationReasonCode[],
  ruleStatus?: 'equivalent' | 'competing' | 'unsupported',
): Readonly<{ suppression: ClassificationSuppressionV1 }> {
  return {
    suppression: {
      kind: 'merchant-alias',
      reasonCodes,
      ...(ruleStatus === undefined ? {} : { ruleStatus }),
      subjectId: normalizedImportedPayee,
    },
  };
}

function suppressedCategory(
  transactionId: string,
  reasonCodes: readonly ClassificationReasonCode[],
  ruleStatus?: 'equivalent' | 'competing' | 'unsupported',
): Readonly<{ suppression: ClassificationSuppressionV1 }> {
  return {
    suppression: {
      kind: 'category',
      reasonCodes,
      ...(ruleStatus === undefined ? {} : { ruleStatus }),
      subjectId: transactionId,
    },
  };
}

function assertRequestIsBoundToSnapshot(
  request: ClassificationDetectionRequestV1,
): void {
  assertClassificationTimestamp(request.evaluatedAt);
  if (
    request.snapshot.contractVersion !== 1 ||
    request.snapshot.budget.currencyCode !== request.boundBudgetCurrency ||
    !/^[A-Z]{3}$/.test(request.boundBudgetCurrency)
  ) {
    throw new Error(
      'Classification request does not match its bound snapshot.',
    );
  }
}

function proposalId(value: Record<string, unknown>): string {
  return `classification-v1-${hash(value)}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashWithDomain(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(canonicalJson(value))
    .digest('hex');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export const classificationRejectionSuppressionMilliseconds =
  rejectionSuppressionMilliseconds;
