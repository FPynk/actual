import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { getFinanceMetadata } from '#server/prefs';
import { q } from '#shared/query';
import type {
  FinanceMetadata,
  NativeReconciliationCandidate,
  NativeReconciliationReason,
  NativeReconciliationTransaction,
} from '#types/finance';
import type { TransactionEntity } from '#types/models';

const maximumCandidates = 250;
const maximumDateDistanceDays = 7;

export async function listNativeReconciliationCandidates(): Promise<
  readonly NativeReconciliationCandidate[]
> {
  const [{ data: transactions }, payees] = await Promise.all([
    aqlQuery(q('transactions').select('*').options({ splits: 'none' })),
    db.getPayees(),
  ]);

  return buildNativeReconciliationCandidates(
    transactions,
    new Map(payees.map(payee => [payee.id, payee.name])),
    getFinanceMetadata(),
  );
}

export function buildNativeReconciliationCandidates(
  transactions: readonly TransactionEntity[],
  payeeNames: ReadonlyMap<string, string> = new Map(),
  metadata?: FinanceMetadata,
): readonly NativeReconciliationCandidate[] {
  const transactionsByAccountAndAmount = new Map<string, TransactionEntity[]>();

  for (const transaction of transactions) {
    if (!isEligibleTransaction(transaction)) {
      continue;
    }
    const groupingKey = `${transaction.account}\0${transaction.amount}`;
    const groupedTransactions =
      transactionsByAccountAndAmount.get(groupingKey) ?? [];
    groupedTransactions.push(transaction);
    transactionsByAccountAndAmount.set(groupingKey, groupedTransactions);
  }

  const hiddenCandidateKeys = new Set(
    metadata?.reviewDecisions
      .filter(decision => decision.feature === 'reconciliation')
      .map(decision => decision.candidateKey) ?? [],
  );
  const candidates: NativeReconciliationCandidate[] = [];

  for (const groupedTransactions of transactionsByAccountAndAmount.values()) {
    groupedTransactions.sort(
      (left, right) =>
        left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
    );
    for (
      let leftIndex = 0;
      leftIndex < groupedTransactions.length;
      leftIndex++
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < groupedTransactions.length;
        rightIndex++
      ) {
        const left = groupedTransactions[leftIndex];
        const right = groupedTransactions[rightIndex];
        const dateDistance = dateDistanceInDays(left.date, right.date);
        if (dateDistance > maximumDateDistanceDays) {
          break;
        }

        const candidate = scoreNativeReconciliationPair(
          left,
          right,
          payeeNames,
        );
        if (
          candidate !== null &&
          !hiddenCandidateKeys.has(candidate.candidateKey)
        ) {
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.transactions[0].date.localeCompare(right.transactions[0].date) ||
        left.candidateKey.localeCompare(right.candidateKey),
    )
    .slice(0, maximumCandidates);
}

export function scoreNativeReconciliationPair(
  left: TransactionEntity,
  right: TransactionEntity,
  payeeNames: ReadonlyMap<string, string> = new Map(),
): NativeReconciliationCandidate | null {
  if (
    !isEligibleTransaction(left) ||
    !isEligibleTransaction(right) ||
    left.account !== right.account ||
    left.amount !== right.amount
  ) {
    return null;
  }

  const dateDistance = dateDistanceInDays(left.date, right.date);
  if (dateDistance > maximumDateDistanceDays) {
    return null;
  }

  let score = 60;
  const reasons: NativeReconciliationReason[] = [];

  if (left.imported_id && left.imported_id === right.imported_id) {
    score += 20;
    reasons.push('same imported transaction ID');
  } else if (left.imported_id && right.imported_id) {
    reasons.push('both transactions came from imports');
  }

  if (dateDistance === 0) {
    score += 20;
    reasons.push('same transaction date');
  } else {
    score += dateDistance <= 3 ? 10 : 5;
    reasons.push('transaction dates are close');
  }

  const leftPayee = normalizedPayee(left, payeeNames);
  const rightPayee = normalizedPayee(right, payeeNames);
  if (!leftPayee || !rightPayee) {
    reasons.push('merchant evidence is unavailable');
  } else if (leftPayee === rightPayee) {
    score += 15;
    reasons.push('same normalized merchant');
  } else {
    score -= 10;
    reasons.push('merchant names differ');
  }

  if (Boolean(left.cleared) !== Boolean(right.cleared)) {
    score += 5;
    reasons.push('pending and posted states differ');
  }

  if (score < 80) {
    return null;
  }

  const sortedTransactions = [left, right].sort((first, second) =>
    first.id.localeCompare(second.id),
  ) as [TransactionEntity, TransactionEntity];
  const transactionIds = sortedTransactions.map(
    transaction => transaction.id,
  ) as [string, string];
  const transactionEvidence = sortedTransactions.map(transaction =>
    toEvidence(transaction, payeeNames),
  ) as [NativeReconciliationTransaction, NativeReconciliationTransaction];
  const candidateKey = `reconciliation:${transactionIds.join(':')}`;

  return {
    candidateKey,
    fingerprint: JSON.stringify(transactionEvidence),
    transactionIds,
    accountId: left.account,
    amount: left.amount,
    confidence: score >= 100 ? 'high' : score >= 90 ? 'medium' : 'low',
    score,
    reasons,
    transactions: transactionEvidence,
  };
}

function isEligibleTransaction(transaction: TransactionEntity): boolean {
  return !(
    transaction.tombstone ||
    transaction._deleted ||
    transaction.is_parent ||
    transaction.is_child ||
    transaction.parent_id ||
    transaction.starting_balance_flag ||
    transaction.transfer_id ||
    transaction.reconciled
  );
}

function normalizedPayee(
  transaction: TransactionEntity,
  payeeNames: ReadonlyMap<string, string>,
): string | null {
  const payee =
    transaction.imported_payee ??
    (transaction.payee ? payeeNames.get(transaction.payee) : null);
  if (!payee) {
    return null;
  }
  const normalized = payee
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return normalized || null;
}

function toEvidence(
  transaction: TransactionEntity,
  payeeNames: ReadonlyMap<string, string>,
): NativeReconciliationTransaction {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    payee:
      (transaction.payee ? payeeNames.get(transaction.payee) : null) ?? null,
    importedPayee: transaction.imported_payee ?? null,
    importedId: transaction.imported_id ?? null,
    categoryId: transaction.category ?? null,
    notes: transaction.notes ?? null,
    cleared: Boolean(transaction.cleared),
  };
}

function dateDistanceInDays(left: string, right: string): number {
  const leftTimestamp = Date.parse(`${left}T00:00:00.000Z`);
  const rightTimestamp = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftTimestamp) || !Number.isFinite(rightTimestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(leftTimestamp - rightTimestamp) / 86_400_000;
}
