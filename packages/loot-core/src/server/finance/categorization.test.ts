import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import { categorizationFingerprint } from '#shared/finance-categorization';

import { applyFinanceCategorization } from './categorization';

vi.mock('#server/db', () => ({
  first: vi.fn(),
  getAccounts: vi.fn(),
  getCategoriesGrouped: vi.fn(),
  getPayees: vi.fn(),
  getTransaction: vi.fn(),
}));

vi.mock('#server/transactions', () => ({
  batchUpdateTransactions: vi.fn(),
}));

describe('applyFinanceCategorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.first).mockResolvedValue({
      value: JSON.stringify({ categoryIds: ['groceries'] }),
    });
    vi.mocked(db.getCategoriesGrouped).mockResolvedValue([
      {
        id: 'expenses',
        name: 'Expenses',
        is_income: 0,
        sort_order: 0,
        hidden: 0,
        tombstone: 0,
        categories: [
          {
            id: 'groceries',
            name: 'Groceries',
            is_income: 0,
            cat_group: 'expenses',
            sort_order: 0,
            hidden: 0,
            tombstone: 0,
          },
        ],
      },
    ]);
    vi.mocked(db.getAccounts).mockResolvedValue([
      {
        id: 'checking',
        name: 'Checking',
        offbudget: 0,
        closed: 0,
        tombstone: 0,
        sort_order: 0,
        bankName: '',
        bankId: '',
      },
    ]);
    vi.mocked(db.getPayees).mockResolvedValue([
      {
        id: 'market',
        name: 'Market',
        favorite: 0,
        learn_categories: 0,
        tombstone: 0,
      },
    ]);
  });

  it('revalidates and applies all accepted categories in one batch update', async () => {
    const firstTransaction = {
      id: 'one',
      account: 'checking',
      amount: -1_000,
      category: null,
      date: '2026-08-01',
      imported_payee: 'MARKET',
      payee: 'market',
      is_child: false,
      is_parent: false,
      parent_id: null,
      transfer_id: null,
      reconciled: false,
      tombstone: false,
    };
    const secondTransaction = {
      ...firstTransaction,
      id: 'two',
      amount: -2_000,
    };
    vi.mocked(db.getTransaction).mockImplementation(async id =>
      id === 'one' ? firstTransaction : secondTransaction,
    );

    const result = await applyFinanceCategorization({
      includeCategorized: false,
      proposals: [firstTransaction, secondTransaction].map(transaction => ({
        categoryId: 'groceries',
        fingerprint: categorizationFingerprint({
          accountId: transaction.account,
          accountName: 'Checking',
          amount: transaction.amount,
          categoryId: transaction.category,
          date: transaction.date,
          importedPayee: transaction.imported_payee,
          payeeId: transaction.payee,
          payeeName: 'Market',
          transactionId: transaction.id,
        }),
        transactionId: transaction.id,
      })),
    });

    expect(batchUpdateTransactions).toHaveBeenCalledTimes(1);
    expect(batchUpdateTransactions).toHaveBeenCalledWith({
      updated: [
        { id: 'one', category: 'groceries' },
        { id: 'two', category: 'groceries' },
      ],
      runTransfers: false,
    });
    expect(result).toEqual({
      appliedTransactionIds: ['one', 'two'],
      skipped: [],
    });
  });
});
