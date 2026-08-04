export const maximumCategorizationCandidates = 5_000;
export const maximumCategorizationProviderBatchSize = 25;
export const maximumCategorizationReceiptEvidenceBytes = 8 * 1024;
export const maximumCategorizationReceiptLineItems = 40;
export const maximumCategorizationReceiptLineItemLabelLength = 120;
export const maximumCategorizationReceiptMerchantLength = 128;

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
  | 'off-budget'
  | 'reconciled'
  | 'split'
  | 'starting-balance'
  | 'transfer'
  | 'zero-amount';

export type CategorizationTransactionDirection = 'inflow' | 'outflow';

export type PreparedCategorizationCandidate = {
  account?: string;
  amount: string;
  amountInteger: number;
  candidateId: string;
  currentCategoryId?: string | null;
  currency: string;
  date: string;
  description?: string;
  direction: CategorizationTransactionDirection;
  fingerprint: string;
  payee?: string;
  receiptEvidence?: CategorizationReceiptEvidence;
  transactionId: string;
  transactionFingerprint: string;
};

export type CategorizationReceiptEvidence = {
  fingerprint: string;
  lineItems: Array<{
    amount?: number;
    label: string;
    quantity?: number;
  }>;
  merchant?: string;
  truncated: boolean;
};

export type CategorizationReceiptSource = {
  fingerprint: string;
  id: string;
  lineItems: ReadonlyArray<{
    amount?: number;
    label: string;
    quantity?: number;
  }>;
  merchant: string | null;
  transcriptRevision: number;
};

export type CategorizationGatewayCandidate = {
  account?: string;
  amount: string;
  candidate_id: string;
  currency: string;
  date: string;
  description?: string;
  direction: CategorizationTransactionDirection;
  payee?: string;
  receipt?: {
    line_items: Array<{
      amount?: number;
      label: string;
      quantity?: number;
    }>;
    merchant?: string;
    truncated?: true;
  };
};

export type CategorizationProposal = {
  candidateId: string;
  categoryId: string | null;
  confidence: CategorizationConfidence;
  explanation: string;
};

export type CategorizationProposalRequestResult = {
  outcome: 'aborted' | 'complete' | 'failed';
  proposals: CategorizationProposal[];
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
  receiptFingerprint: string | null = null,
): string {
  return combineCategorizationFingerprint(
    categorizationTransactionFingerprint(transaction),
    receiptFingerprint,
  );
}

export function categorizationTransactionFingerprint(
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

export function combineCategorizationFingerprint(
  transactionFingerprint: string,
  receiptFingerprint: string | null,
): string {
  return JSON.stringify([transactionFingerprint, receiptFingerprint]);
}

export function createCategorizationReceiptEvidence(
  receipt: CategorizationReceiptSource,
): CategorizationReceiptEvidence | null {
  if (!receipt.fingerprint || !receipt.id) return null;

  const merchant = limitCodePoints(
    receipt.merchant ?? '',
    maximumCategorizationReceiptMerchantLength,
  );
  const sourceLineItems = receipt.lineItems.slice(
    0,
    maximumCategorizationReceiptLineItems,
  );
  let truncated = receipt.lineItems.length > sourceLineItems.length;
  const lineItems = sourceLineItems.flatMap(item => {
    const label = limitCodePoints(
      item.label,
      maximumCategorizationReceiptLineItemLabelLength,
    );
    if (!label) return [];
    if (label !== item.label) truncated = true;
    return [
      {
        ...(Number.isSafeInteger(item.amount) ? { amount: item.amount } : {}),
        label,
        ...(typeof item.quantity === 'number' && Number.isFinite(item.quantity)
          ? { quantity: item.quantity }
          : {}),
      },
    ];
  });
  if (merchant !== (receipt.merchant ?? '')) truncated = true;

  const evidence: CategorizationReceiptEvidence = {
    fingerprint: JSON.stringify([
      receipt.id,
      receipt.transcriptRevision,
      receipt.fingerprint,
    ]),
    lineItems,
    ...(merchant ? { merchant } : {}),
    truncated,
  };
  while (
    lineItems.length > 0 &&
    receiptEvidenceByteLength(evidence) >
      maximumCategorizationReceiptEvidenceBytes
  ) {
    lineItems.pop();
    evidence.truncated = true;
  }
  if (
    receiptEvidenceByteLength(evidence) >
    maximumCategorizationReceiptEvidenceBytes
  ) {
    evidence.merchant = undefined;
    evidence.truncated = true;
  }
  return evidence;
}

export function withCategorizationReceiptEvidence(
  candidate: PreparedCategorizationCandidate,
  receipt: CategorizationReceiptSource | null | undefined,
): PreparedCategorizationCandidate {
  const receiptEvidence = receipt
    ? createCategorizationReceiptEvidence(receipt)
    : undefined;
  return {
    ...candidate,
    ...(receiptEvidence ? { receiptEvidence } : {}),
    fingerprint: combineCategorizationFingerprint(
      candidate.transactionFingerprint,
      receiptEvidence?.fingerprint ?? null,
    ),
  };
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
  if (transaction.amount === 0) return 'zero-amount';

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
    'off-budget': 0,
    reconciled: 0,
    split: 0,
    'starting-balance': 0,
    transfer: 0,
    'zero-amount': 0,
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
    const transactionFingerprint =
      categorizationTransactionFingerprint(transaction);
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
      direction: transaction.amount > 0 ? 'inflow' : 'outflow',
      fingerprint: combineCategorizationFingerprint(
        transactionFingerprint,
        null,
      ),
      payee:
        payeeName && payeeName !== importedDescription ? payeeName : undefined,
      transactionId: transaction.transactionId,
      transactionFingerprint,
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
    direction: candidate.direction,
    payee: candidate.payee,
    ...(candidate.receiptEvidence
      ? {
          receipt: {
            line_items: candidate.receiptEvidence.lineItems,
            ...(candidate.receiptEvidence.merchant
              ? { merchant: candidate.receiptEvidence.merchant }
              : {}),
            ...(candidate.receiptEvidence.truncated ? { truncated: true } : {}),
          },
        }
      : {}),
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
  signal,
}: {
  candidates: PreparedCategorizationCandidate[];
  allowedCategoryIds: ReadonlySet<string>;
  requestBatch: (
    batch: PreparedCategorizationCandidate[],
    signal: AbortSignal | undefined,
  ) => Promise<CategorizationProposal[]>;
  signal?: AbortSignal;
}): Promise<CategorizationProposalRequestResult> {
  const proposals: CategorizationProposal[] = [];
  for (const batch of splitCategorizationProviderBatches(candidates)) {
    if (signal?.aborted) return { outcome: 'aborted', proposals };

    let response: CategorizationProposal[];
    try {
      response = await requestBatch(batch, signal);
    } catch {
      return { outcome: signal?.aborted ? 'aborted' : 'failed', proposals };
    }
    const batchProposals = validateCategorizationProposals(
      batch,
      response,
      allowedCategoryIds,
    );
    if (!batchProposals) {
      return { outcome: 'failed', proposals };
    }
    proposals.push(...batchProposals);
  }
  return { outcome: 'complete', proposals };
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
  receiptEvidenceByTransactionId,
}: {
  proposals: CategorizationApplyProposal[];
  currentTransactions: CategorizationTransactionSnapshot[];
  allowedCategoryIds: ReadonlySet<string>;
  includeCategorized: boolean;
  receiptEvidenceByTransactionId?: ReadonlyMap<
    string,
    CategorizationReceiptEvidence
  >;
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
    if (
      categorizationFingerprint(
        transaction,
        receiptEvidenceByTransactionId?.get(transaction.transactionId)
          ?.fingerprint ?? null,
      ) !== proposal.fingerprint
    ) {
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

function limitCodePoints(value: string, maximum: number): string {
  return Array.from(value.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .slice(0, maximum)
    .join('');
}

function receiptEvidenceByteLength(
  value: CategorizationReceiptEvidence,
): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
