import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import {
  createCategorizationReceiptEvidence,
  maximumCategorizationCandidates,
  planCategorizationApply,
} from '#shared/finance-categorization';
import type {
  CategorizationApplyProposal,
  CategorizationReceiptEvidence,
  CategorizationTransactionSnapshot,
} from '#shared/finance-categorization';
import { financeCategorizationPreferenceId } from '#types/finance';

function readAllowedCategoryIds(serializedSettings: string | null): string[] {
  if (!serializedSettings) return [];
  try {
    const value: unknown = JSON.parse(serializedSettings);
    if (!value || typeof value !== 'object' || !('categoryIds' in value)) {
      return [];
    }
    const categoryIds = (value as { categoryIds?: unknown }).categoryIds;
    return Array.isArray(categoryIds)
      ? categoryIds.filter(
          (categoryId): categoryId is string => typeof categoryId === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

export async function applyFinanceCategorization({
  includeCategorized,
  proposals,
}: {
  includeCategorized: boolean;
  proposals: CategorizationApplyProposal[];
}) {
  if (
    typeof includeCategorized !== 'boolean' ||
    !Array.isArray(proposals) ||
    proposals.length > maximumCategorizationCandidates ||
    proposals.some(
      proposal =>
        !proposal ||
        typeof proposal.transactionId !== 'string' ||
        typeof proposal.categoryId !== 'string' ||
        typeof proposal.fingerprint !== 'string',
    )
  ) {
    throw new Error('Invalid categorization apply request');
  }

  const [preference, categoryGroups, accounts, payees, transactions] =
    await Promise.all([
      db.first<Pick<db.DbPreference, 'value'>>(
        'SELECT value FROM preferences WHERE id = ?',
        [financeCategorizationPreferenceId],
      ),
      db.getCategoriesGrouped(),
      db.getAccounts(),
      db.getPayees(),
      Promise.all(
        proposals.map(proposal => db.getTransaction(proposal.transactionId)),
      ),
    ]);

  const configuredCategoryIds = new Set(
    readAllowedCategoryIds(preference?.value ?? null),
  );
  const allowedCategoryIds = new Set(
    categoryGroups
      .filter(group => !group.hidden)
      .flatMap(group => group.categories)
      .filter(
        category => configuredCategoryIds.has(category.id) && !category.hidden,
      )
      .map(category => category.id),
  );
  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const payeesById = new Map(payees.map(payee => [payee.id, payee]));
  const receiptEvidenceByTransactionId =
    await readReceiptEvidenceByTransactionId(
      transactions.flatMap(transaction =>
        transaction ? [transaction.id] : [],
      ),
    );

  const currentTransactions = transactions.flatMap(
    (transaction): CategorizationTransactionSnapshot[] => {
      if (!transaction) return [];
      const account = accountsById.get(transaction.account);
      const payee = transaction.payee
        ? payeesById.get(transaction.payee)
        : undefined;
      return [
        {
          accountId: transaction.account,
          accountName: account?.name,
          accountOffBudget: Boolean(account?.offbudget),
          amount: transaction.amount,
          categoryId: transaction.category,
          date: transaction.date,
          deleted: Boolean(transaction.tombstone),
          importedPayee: transaction.imported_payee,
          isChild: Boolean(transaction.is_child),
          isParent: Boolean(transaction.is_parent),
          parentId: transaction.parent_id,
          payeeId: transaction.payee,
          payeeIsTransfer: Boolean(payee?.transfer_acct),
          payeeName: payee?.name,
          reconciled: Boolean(transaction.reconciled),
          startingBalance: Boolean(transaction.starting_balance_flag),
          transactionId: transaction.id,
          transferId: transaction.transfer_id,
        },
      ];
    },
  );

  const applyPlan = planCategorizationApply({
    proposals,
    currentTransactions,
    allowedCategoryIds,
    includeCategorized,
    receiptEvidenceByTransactionId,
  });
  if (applyPlan.updates.length > 0) {
    await batchUpdateTransactions({
      updated: applyPlan.updates,
      runTransfers: false,
    });
  }

  return {
    appliedTransactionIds: applyPlan.updates.map(update => update.id),
    skipped: applyPlan.skipped,
  };
}

async function readReceiptEvidenceByTransactionId(
  transactionIds: string[],
): Promise<Map<string, CategorizationReceiptEvidence>> {
  const receiptLists = await Promise.all(
    [...new Set(transactionIds)].map(
      async transactionId =>
        [
          transactionId,
          await db.getActiveReceiptsByTransactionId(transactionId),
        ] as const,
    ),
  );
  const receiptEvidenceByTransactionId = new Map<
    string,
    CategorizationReceiptEvidence
  >();
  for (const [transactionId, receipts] of receiptLists) {
    if (receipts.length !== 1) continue;
    const receipt = receipts[0];
    const evidence = createCategorizationReceiptEvidence({
      fingerprint: receipt.fingerprint,
      id: receipt.id,
      merchant: receipt.merchant,
      transcript: receipt.transcript,
      transcriptRevision: receipt.transcript_revision,
    });
    if (evidence) receiptEvidenceByTransactionId.set(transactionId, evidence);
  }
  return receiptEvidenceByTransactionId;
}
