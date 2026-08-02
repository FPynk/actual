export const maximumCategorizationCandidates = 5_000;
export const maximumCategorizationProviderBatchSize = 25;

export type CategorizationConfidence = 'high' | 'medium' | 'low';

export type CategorizationTransactionSnapshot = {
  accountId: string;
  accountName?: string | null;
  accountOffBudget?: boolean;
  amount: number;
  categoryId?: string | null;
  date: string;
  deleted?: boolean;
  importedPayee?: string | null;
  isChild?: boolean;
  isParent?: boolean;
  parentId?: string | null;
  payeeId?: string | null;
  payeeIsTransfer?: boolean;
  payeeName?: string | null;
  reconciled?: boolean;
  startingBalance?: boolean;
  transactionId: string;
  transferId?: string | null;
};

export type CategorizationIneligibilityReason =
  | 'already-categorized'
  | 'deleted'
  | 'missing-description'
  | 'not-expense'
  | 'off-budget'
  | 'reconciled'
  | 'split'
  | 'starting-balance'
  | 'transfer';

export type PreparedCategorizationCandidate = {
  account?: string;
  amount: string;
  amountInteger: number;
  candidateId: string;
  currentCategoryId?: string | null;
  currency: string;
  date: string;
  description?: string;
  fingerprint: string;
  payee?: string;
  transactionId: string;
};

export type CategorizationGatewayCandidate = {
  account?: string;
  amount: string;
  candidate_id: string;
  currency: string;
  date: string;
  description?: string;
  payee?: string;
};

export type CategorizationProposal = {
  candidateId: string;
  categoryId: string | null;
  confidence: CategorizationConfidence;
  explanation: string;
};

export type CategorizationApplyProposal = {
  categoryId: string;
  fingerprint: string;
  transactionId: string;
};

export type CategorizationApplySkipReason =
  | CategorizationIneligibilityReason
  | 'category-not-allowed'
  | 'duplicate-transaction'
  | 'missing'
  | 'stale';

export function categorizationFingerprint(
  transaction: CategorizationTransactionSnapshot,
): string {
  return JSON.stringify([
    transaction.date,
    transaction.amount,
    transaction.accountId,
    transaction.accountName ?? null,
    transaction.payeeId ?? null,
    transaction.payeeName ?? null,
    transaction.importedPayee ?? null,
    transaction.categoryId ?? null,
  ]);
}

export function getCategorizationIneligibilityReason(
  transaction: CategorizationTransactionSnapshot,
  includeCategorized: boolean,
): CategorizationIneligibilityReason | null {
  if (transaction.deleted) return 'deleted';
  if (transaction.isParent || transaction.isChild || transaction.parentId) {
    return 'split';
  }
  if (transaction.reconciled) return 'reconciled';
  if (transaction.startingBalance) return 'starting-balance';
  if (transaction.transferId || transaction.payeeIsTransfer) {
    return 'transfer';
  }
  if (transaction.accountOffBudget) return 'off-budget';
  if (transaction.amount >= 0) return 'not-expense';

  const description = transaction.importedPayee?.trim();
  const payee = transaction.payeeName?.trim();
  if (!description && !payee) return 'missing-description';
  if (!includeCategorized && transaction.categoryId) {
    return 'already-categorized';
  }
  return null;
}

export function prepareCategorizationCandidates({
  transactions,
  includeCategorized,
  currency,
  decimalPlaces,
  createCandidateId,
}: {
  transactions: CategorizationTransactionSnapshot[];
  includeCategorized: boolean;
  currency: string;
  decimalPlaces: number;
  createCandidateId: () => string;
}): {
  candidates: PreparedCategorizationCandidate[];
  skipped: Record<CategorizationIneligibilityReason, number>;
} {
  const skipped: Record<CategorizationIneligibilityReason, number> = {
    'already-categorized': 0,
    deleted: 0,
    'missing-description': 0,
    'not-expense': 0,
    'off-budget': 0,
    reconciled: 0,
    split: 0,
    'starting-balance': 0,
    transfer: 0,
  };
  const candidates: PreparedCategorizationCandidate[] = [];

  for (const transaction of transactions) {
    const ineligibilityReason = getCategorizationIneligibilityReason(
      transaction,
      includeCategorized,
    );
    if (ineligibilityReason) {
      skipped[ineligibilityReason]++;
      continue;
    }

    const importedDescription = transaction.importedPayee?.trim();
    const payeeName = transaction.payeeName?.trim();
    candidates.push({
      account: transaction.accountName?.trim() || undefined,
      amount: (transaction.amount / Math.pow(10, decimalPlaces)).toFixed(
        decimalPlaces,
      ),
      amountInteger: transaction.amount,
      candidateId: createCandidateId(),
      currentCategoryId: transaction.categoryId,
      currency,
      date: transaction.date,
      description: importedDescription || payeeName || undefined,
      fingerprint: categorizationFingerprint(transaction),
      payee:
        payeeName && payeeName !== importedDescription ? payeeName : undefined,
      transactionId: transaction.transactionId,
    });
  }

  return { candidates, skipped };
}

export function splitCategorizationProviderBatches<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (
    let offset = 0;
    offset < items.length;
    offset += maximumCategorizationProviderBatchSize
  ) {
    batches.push(
      items.slice(offset, offset + maximumCategorizationProviderBatchSize),
    );
  }
  return batches;
}

export function toCategorizationGatewayCandidate(
  candidate: PreparedCategorizationCandidate,
): CategorizationGatewayCandidate {
  return {
    account: candidate.account,
    amount: candidate.amount,
    candidate_id: candidate.candidateId,
    currency: candidate.currency,
    date: candidate.date,
    description: candidate.description,
    payee: candidate.payee,
  };
}

export function validateCategorizationProposals(
  candidates: PreparedCategorizationCandidate[],
  proposals: CategorizationProposal[],
  allowedCategoryIds: ReadonlySet<string>,
): CategorizationProposal[] | null {
  if (proposals.length !== candidates.length) return null;

  const expectedCandidateIds = new Set(
    candidates.map(candidate => candidate.candidateId),
  );
  const seenCandidateIds = new Set<string>();
  for (const proposal of proposals) {
    if (
      !expectedCandidateIds.has(proposal.candidateId) ||
      seenCandidateIds.has(proposal.candidateId) ||
      (proposal.categoryId !== null &&
        !allowedCategoryIds.has(proposal.categoryId)) ||
      !['high', 'medium', 'low'].includes(proposal.confidence) ||
      typeof proposal.explanation !== 'string' ||
      proposal.explanation.length > 240
    ) {
      return null;
    }
    seenCandidateIds.add(proposal.candidateId);
  }

  return proposals;
}

export async function requestCategorizationProposalsSequentially({
  candidates,
  allowedCategoryIds,
  requestBatch,
}: {
  candidates: PreparedCategorizationCandidate[];
  allowedCategoryIds: ReadonlySet<string>;
  requestBatch: (
    batch: PreparedCategorizationCandidate[],
  ) => Promise<CategorizationProposal[]>;
}): Promise<CategorizationProposal[]> {
  const proposals: CategorizationProposal[] = [];
  for (const batch of splitCategorizationProviderBatches(candidates)) {
    const batchProposals = validateCategorizationProposals(
      batch,
      await requestBatch(batch),
      allowedCategoryIds,
    );
    if (!batchProposals) {
      throw new Error('invalid-categorization-response');
    }
    proposals.push(...batchProposals);
  }
  return proposals;
}

export function getDefaultSelectedCategorizationCandidateIds(
  proposals: CategorizationProposal[],
): Set<string> {
  return new Set(
    proposals
      .filter(
        proposal =>
          proposal.confidence === 'high' && proposal.categoryId !== null,
      )
      .map(proposal => proposal.candidateId),
  );
}

export function planCategorizationApply({
  proposals,
  currentTransactions,
  allowedCategoryIds,
  includeCategorized,
}: {
  proposals: CategorizationApplyProposal[];
  currentTransactions: CategorizationTransactionSnapshot[];
  allowedCategoryIds: ReadonlySet<string>;
  includeCategorized: boolean;
}): {
  skipped: Array<{
    reason: CategorizationApplySkipReason;
    transactionId: string;
  }>;
  updates: Array<{ category: string; id: string }>;
} {
  const transactionsById = new Map(
    currentTransactions.map(transaction => [
      transaction.transactionId,
      transaction,
    ]),
  );
  const seenTransactionIds = new Set<string>();
  const skipped: Array<{
    reason: CategorizationApplySkipReason;
    transactionId: string;
  }> = [];
  const updates: Array<{ category: string; id: string }> = [];

  for (const proposal of proposals) {
    if (seenTransactionIds.has(proposal.transactionId)) {
      skipped.push({
        reason: 'duplicate-transaction',
        transactionId: proposal.transactionId,
      });
      continue;
    }
    seenTransactionIds.add(proposal.transactionId);

    const transaction = transactionsById.get(proposal.transactionId);
    if (!transaction) {
      skipped.push({
        reason: 'missing',
        transactionId: proposal.transactionId,
      });
      continue;
    }
    if (categorizationFingerprint(transaction) !== proposal.fingerprint) {
      skipped.push({
        reason: 'stale',
        transactionId: proposal.transactionId,
      });
      continue;
    }

    const ineligibilityReason = getCategorizationIneligibilityReason(
      transaction,
      includeCategorized,
    );
    if (ineligibilityReason) {
      skipped.push({
        reason: ineligibilityReason,
        transactionId: proposal.transactionId,
      });
      continue;
    }
    if (!allowedCategoryIds.has(proposal.categoryId)) {
      skipped.push({
        reason: 'category-not-allowed',
        transactionId: proposal.transactionId,
      });
      continue;
    }

    updates.push({ id: proposal.transactionId, category: proposal.categoryId });
  }

  return { skipped, updates };
}
