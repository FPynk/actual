import {
  maximumCategorizationCandidates,
  prepareCategorizationCandidates,
} from '@actual-app/core/shared/finance-categorization';
import type {
  CategorizationIneligibilityReason,
  CategorizationTransactionSnapshot,
  PreparedCategorizationCandidate,
} from '@actual-app/core/shared/finance-categorization';
import { q, Query } from '@actual-app/core/shared/query';
import type { QueryState } from '@actual-app/core/shared/query';

export type CategorizationScope =
  | { kind: 'all' }
  | { endDate: string; kind: 'date-range'; startDate: string }
  | { kind: 'current-filter'; query: QueryState }
  | { kind: 'selected'; transactionIds: string[] };

export type CategorizationQueryRow = {
  account: string;
  accountName?: string | null;
  accountOffBudget?: boolean;
  amount: number;
  category?: string | null;
  date: string;
  imported_payee?: string | null;
  is_child?: boolean;
  is_parent?: boolean;
  parent_id?: string | null;
  payee?: string | null;
  payeeTransferAccount?: string | null;
  payeeName?: string | null;
  reconciled?: boolean;
  starting_balance_flag?: boolean;
  tombstone?: boolean;
  transfer_id?: string | null;
  id: string;
};

export const categorizationScopePageSize = 500;

export function normalizeCategorizationCurrencyCode(currencyCode: string) {
  const normalizedCurrencyCode = currencyCode.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalizedCurrencyCode)
    ? normalizedCurrencyCode
    : 'XXX';
}

const categorizationTransactionFields = [
  'id',
  'date',
  'amount',
  'account',
  'category',
  'payee',
  'imported_payee',
  'is_parent',
  'is_child',
  'parent_id',
  'transfer_id',
  'reconciled',
  'starting_balance_flag',
  'tombstone',
  { accountName: { $id: '$account.name' } },
  { accountOffBudget: { $id: '$account.offbudget' } },
  { payeeName: { $id: '$payee.name' } },
  { payeeTransferAccount: { $id: '$payee.transfer_acct.id' } },
];

export function makeCategorizationScopeQuery(
  scope: CategorizationScope,
  { limit, offset }: { limit: number; offset: number },
) {
  let query: Query;
  switch (scope.kind) {
    case 'selected':
      query = q('transactions').filter({
        id: { $oneof: scope.transactionIds },
      });
      break;
    case 'current-filter':
      query = new Query({ ...scope.query, limit: null, offset: null });
      break;
    case 'date-range':
      query = q('transactions').filter({
        $and: [
          { date: { $gte: scope.startDate } },
          { date: { $lte: scope.endDate } },
        ],
      });
      break;
    case 'all':
      query = q('transactions');
      break;
    default:
      throw new Error('Unsupported categorization scope');
  }

  return query
    .options({ splits: 'all' })
    .select(categorizationTransactionFields)
    .limit(limit)
    .offset(offset);
}

export function toCategorizationTransactionSnapshot(
  row: CategorizationQueryRow,
): CategorizationTransactionSnapshot {
  return {
    accountId: row.account,
    accountName: row.accountName,
    accountOffBudget: Boolean(row.accountOffBudget),
    amount: row.amount,
    categoryId: row.category,
    date: row.date,
    deleted: row.tombstone,
    importedPayee: row.imported_payee,
    isChild: row.is_child,
    isParent: row.is_parent,
    parentId: row.parent_id,
    payeeId: row.payee,
    payeeIsTransfer: Boolean(row.payeeTransferAccount),
    payeeName: row.payeeName,
    reconciled: row.reconciled,
    startingBalance: row.starting_balance_flag,
    transactionId: row.id,
    transferId: row.transfer_id,
  };
}

export async function prepareCategorizationScopeCandidates({
  scope,
  includeCategorized,
  currency,
  decimalPlaces,
  createCandidateId,
  readPage,
  maximumCandidates = maximumCategorizationCandidates,
  pageSize = categorizationScopePageSize,
}: {
  scope: CategorizationScope;
  includeCategorized: boolean;
  currency: string;
  decimalPlaces: number;
  createCandidateId: () => string;
  readPage: (query: Query) => Promise<CategorizationQueryRow[]>;
  maximumCandidates?: number;
  pageSize?: number;
}): Promise<{
  candidates: PreparedCategorizationCandidate[];
  exceededMaximum: boolean;
  skipped: Record<CategorizationIneligibilityReason, number>;
}> {
  const initialResult = prepareCategorizationCandidates({
    transactions: [],
    includeCategorized,
    currency,
    decimalPlaces,
    createCandidateId,
  });
  const candidates = initialResult.candidates;
  const skipped = initialResult.skipped;

  for (let offset = 0; ; offset += pageSize) {
    const rows = await readPage(
      makeCategorizationScopeQuery(scope, { limit: pageSize, offset }),
    );
    const page = prepareCategorizationCandidates({
      transactions: rows.map(toCategorizationTransactionSnapshot),
      includeCategorized,
      currency,
      decimalPlaces,
      createCandidateId,
    });
    for (const reason of Object.keys(
      page.skipped,
    ) as Array<CategorizationIneligibilityReason>) {
      skipped[reason] += page.skipped[reason];
    }

    const candidatesNeededToDetectOverflow =
      maximumCandidates + 1 - candidates.length;
    candidates.push(
      ...page.candidates.slice(0, candidatesNeededToDetectOverflow),
    );
    if (candidates.length > maximumCandidates) {
      return { candidates, exceededMaximum: true, skipped };
    }
    if (rows.length < pageSize) {
      return { candidates, exceededMaximum: false, skipped };
    }
  }
}
