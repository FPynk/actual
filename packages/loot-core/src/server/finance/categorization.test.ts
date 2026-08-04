import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import {
  categorizationFingerprint,
  createCategorizationReceiptEvidence,
} from '#shared/finance-categorization';

import { applyFinanceCategorization } from './categorization';

vi.mock('#server/db', () => ({
  first: vi.fn(),
  getAccounts: vi.fn(),
  getActiveReceiptsByTransactionId: vi.fn(),
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
      value: JSON.stringify({ categoryIds: ['groceries', 'salary'] }),
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
      {
        id: 'income',
        name: 'Income',
        is_income: 1,
        sort_order: 1,
        hidden: 0,
        tombstone: 0,
        categories: [
          {
            id: 'salary',
            name: 'Salary',
            is_income: 1,
            cat_group: 'income',
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
    vi.mocked(db.getActiveReceiptsByTransactionId).mockResolvedValue([]);
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

  it('applies a configured income category to a positive Capital One-style credit', async () => {
    const credit = {
      id: 'credit',
      account: 'checking',
      amount: 125_000,
      category: null,
      date: '2026-08-01',
      imported_payee: 'CAPITAL ONE PAYMENT',
      payee: 'market',
      is_child: false,
      is_parent: false,
      parent_id: null,
      transfer_id: null,
      reconciled: false,
      tombstone: false,
    };
    vi.mocked(db.getTransaction).mockResolvedValue(credit);

    const result = await applyFinanceCategorization({
      includeCategorized: false,
      proposals: [
        {
          categoryId: 'salary',
          fingerprint: categorizationFingerprint({
            accountId: credit.account,
            accountName: 'Checking',
            amount: credit.amount,
            categoryId: credit.category,
            date: credit.date,
            importedPayee: credit.imported_payee,
            payeeId: credit.payee,
            payeeName: 'Market',
            transactionId: credit.id,
          }),
          transactionId: credit.id,
        },
      ],
    });

    expect(batchUpdateTransactions).toHaveBeenCalledWith({
      updated: [{ id: 'credit', category: 'salary' }],
      runTransfers: false,
    });
    expect(result).toEqual({
      appliedTransactionIds: ['credit'],
      skipped: [],
    });
  });

  it('skips a preview when the linked receipt changed before apply', async () => {
    const transaction = {
      id: 'receipt-transaction',
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
    vi.mocked(db.getTransaction).mockResolvedValue(transaction);
    vi.mocked(db.getActiveReceiptsByTransactionId).mockResolvedValue([
      {
        fingerprint: 'changed-receipt',
        id: 'receipt-id',
        line_items: JSON.stringify([{ label: 'Milk', amount: 500 }]),
        merchant: 'Market',
        transcript_revision: 2,
      } as never,
    ]);
    const originalEvidence = createCategorizationReceiptEvidence({
      fingerprint: 'original-receipt',
      id: 'receipt-id',
      lineItems: [{ amount: 500, label: 'Milk' }],
      merchant: 'Market',
      transcriptRevision: 1,
    });
    if (!originalEvidence) throw new Error('Expected receipt evidence');

    const result = await applyFinanceCategorization({
      includeCategorized: false,
      proposals: [
        {
          categoryId: 'groceries',
          fingerprint: categorizationFingerprint(
            {
              accountId: transaction.account,
              accountName: 'Checking',
              amount: transaction.amount,
              categoryId: transaction.category,
              date: transaction.date,
              importedPayee: transaction.imported_payee,
              payeeId: transaction.payee,
              payeeName: 'Market',
              transactionId: transaction.id,
            },
            originalEvidence.fingerprint,
          ),
          transactionId: transaction.id,
        },
      ],
    });

    expect(batchUpdateTransactions).not.toHaveBeenCalled();
    expect(result).toEqual({
      appliedTransactionIds: [],
      skipped: [{ reason: 'stale', transactionId: 'receipt-transaction' }],
    });
  });
});
