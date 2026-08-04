import {
  createReceiptMatchConfirmation,
  matchReceiptToTransactions,
  receiptTransactionMatchFingerprint,
  scoreReceiptMatchCandidate,
  validateReceiptMatchConfirmation,
} from './receipt-matcher';
import type {
  ReceiptMatchReceiptSnapshot,
  ReceiptMatchTransactionSnapshot,
} from './receipt-matcher';

function receipt(
  overrides: Partial<ReceiptMatchReceiptSnapshot> = {},
): ReceiptMatchReceiptSnapshot {
  return {
    budgetId: 'budget-1',
    currency: 'USD',
    fingerprint: 'receipt-fingerprint',
    id: 'receipt-1',
    merchant: 'Corner Shop 123',
    paymentSourceHint: 'Visa 1234',
    purchaseDate: '2026-08-01',
    total: 1_299,
    totalConfidence: 0.95,
    ...overrides,
  };
}

function transaction(
  id: string,
  overrides: Partial<ReceiptMatchTransactionSnapshot> = {},
): ReceiptMatchTransactionSnapshot {
  return {
    accountId: 'checking',
    accountPaymentSource: 'Visa 1234',
    amount: -1_299,
    budgetId: 'budget-1',
    currency: 'USD',
    date: '2026-08-01',
    id,
    importedPayee: 'CORNER SHOP 123',
    ...overrides,
  };
}

describe('receipt transaction matcher', () => {
  test.each([
    {
      expected: {
        amountScore: 50,
        dateScore: 20,
        reasons: [
          'exact-total',
          'same-date',
          'merchant-exact',
          'source-agreement',
        ],
        score: 100,
      },
      name: 'scores exact total, date, merchant, and payment-source evidence',
      receiptOverrides: {},
      transactionOverrides: {},
    },
    {
      expected: {
        amountScore: 18,
        dateScore: 12,
        reasons: [
          'near-total',
          'one-day-date',
          'merchant-similar',
          'source-different',
        ],
        score: 46,
      },
      name: 'scores a near amount without allowing it to receive the exact amount score',
      receiptOverrides: {},
      transactionOverrides: {
        accountPaymentSource: 'Mastercard 9876',
        amount: -1_309,
        date: '2026-08-02',
        importedPayee: 'Corner Shop',
      },
    },
    {
      expected: {
        amountScore: 50,
        dateScore: 2,
        reasons: [
          'exact-total',
          'four-to-seven-day-date',
          'merchant-conflict',
          'source-missing',
        ],
        score: 52,
      },
      name: 'keeps conflicting merchant evidence visible for manual review',
      receiptOverrides: { paymentSourceHint: null },
      transactionOverrides: {
        accountPaymentSource: null,
        date: '2026-08-06',
        importedPayee: 'Airport Parking',
      },
    },
  ] satisfies Array<{
    expected: {
      amountScore: number;
      dateScore: number;
      reasons: string[];
      score: number;
    };
    name: string;
    receiptOverrides: Partial<ReceiptMatchReceiptSnapshot>;
    transactionOverrides: Partial<ReceiptMatchTransactionSnapshot>;
  }>)('$name', ({ expected, receiptOverrides, transactionOverrides }) => {
    const candidate = scoreReceiptMatchCandidate(
      receipt(receiptOverrides),
      transaction('transaction-1', transactionOverrides),
    );

    expect(candidate).toMatchObject(expected);
  });

  test.each([
    ['deleted', { deleted: true }, 'deleted-target'],
    ['transfer', { transferId: 'transfer-1' }, 'transfer-target'],
    ['starting balance', { startingBalance: true }, 'starting-balance-target'],
    ['split parent', { isParent: true }, 'split-target'],
    ['split child', { isChild: true }, 'split-target'],
    ['split member', { parentId: 'parent-1' }, 'split-target'],
    ['income', { amount: 1_299 }, 'non-expense-target'],
    ['different currency', { currency: 'CAD' }, 'currency-mismatch'],
    ['outside date window', { date: '2026-08-09' }, 'date-outside-window'],
    ['amount outside tolerance', { amount: -1_500 }, 'amount-mismatch'],
    ['linked target', { linkedReceiptId: 'receipt-2' }, 'target-reused'],
  ] satisfies Array<
    [string, Partial<ReceiptMatchTransactionSnapshot>, string]
  >)('excludes unsafe %s targets', (_name, overrides, exclusionReason) => {
    const result = matchReceiptToTransactions({
      receipt: receipt(),
      transactions: [transaction('transaction-1', overrides)],
    });

    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([
      { reason: exclusionReason, transactionId: 'transaction-1' },
    ]);
  });

  test('limits deterministic rankings to 25 candidates', () => {
    const result = matchReceiptToTransactions({
      receipt: receipt({ merchant: null, paymentSourceHint: null }),
      transactions: Array.from({ length: 26 }, (_, index) =>
        transaction(`transaction-${String(index).padStart(2, '0')}`, {
          accountPaymentSource: null,
        }),
      ),
    });

    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[0]?.transactionId).toBe('transaction-00');
    expect(result.candidates.at(-1)?.transactionId).toBe('transaction-24');
  });

  test.each([
    {
      expected: 'transaction-1',
      name: 'preselects the unique exact match with a sufficient score and margin',
      receiptOverrides: {},
      transactions: [
        transaction('transaction-1'),
        transaction('transaction-2', {
          date: '2026-08-04',
          importedPayee: 'Unrelated Shop',
        }),
      ],
    },
    {
      expected: null,
      name: 'does not preselect a near total',
      receiptOverrides: {},
      transactions: [transaction('transaction-1', { amount: -1_300 })],
    },
    {
      expected: null,
      name: 'does not preselect a tied score',
      receiptOverrides: { merchant: null, paymentSourceHint: null },
      transactions: [
        transaction('transaction-1'),
        transaction('transaction-2'),
      ],
    },
    {
      expected: null,
      name: 'does not preselect an ambiguous date',
      receiptOverrides: { dateIsAmbiguous: true },
      transactions: [transaction('transaction-1')],
    },
    {
      expected: null,
      name: 'does not preselect a low-confidence total',
      receiptOverrides: { totalConfidence: 0.79 },
      transactions: [transaction('transaction-1')],
    },
    {
      expected: null,
      name: 'does not preselect split-tender evidence',
      receiptOverrides: { splitTender: true },
      transactions: [transaction('transaction-1')],
    },
    {
      expected: null,
      name: 'does not preselect a merchant conflict',
      receiptOverrides: {},
      transactions: [
        transaction('transaction-1', { importedPayee: 'Airport Parking' }),
      ],
    },
  ] satisfies Array<{
    expected: string | null;
    name: string;
    receiptOverrides: Partial<ReceiptMatchReceiptSnapshot>;
    transactions: ReceiptMatchTransactionSnapshot[];
  }>)('$name', ({ expected, receiptOverrides, transactions }) => {
    const result = matchReceiptToTransactions({
      receipt: receipt(receiptOverrides),
      transactions,
    });

    expect(result.preselectedTransactionId).toBe(expected);
  });

  test('marks a reused target as manual selection even though it cannot be a candidate', () => {
    const result = matchReceiptToTransactions({
      receipt: receipt(),
      transactions: [
        transaction('transaction-1', { linkedReceiptId: 'other-receipt' }),
      ],
    });

    expect(result.manualSelectionReasons).toEqual(
      expect.arrayContaining(['reused-target']),
    );
  });

  test('changes the candidate fingerprint for reviewed receipt and transaction evidence', () => {
    const currentReceipt = receipt();
    const currentTransaction = transaction('transaction-1');

    expect(
      receiptTransactionMatchFingerprint(currentReceipt, currentTransaction),
    ).not.toBe(
      receiptTransactionMatchFingerprint(
        receipt({ fingerprint: 'updated-receipt-fingerprint' }),
        currentTransaction,
      ),
    );
    expect(
      receiptTransactionMatchFingerprint(currentReceipt, currentTransaction),
    ).not.toBe(
      receiptTransactionMatchFingerprint(
        currentReceipt,
        transaction('transaction-1', { amount: -1_300 }),
      ),
    );
  });

  test.each([
    {
      expected: { isValid: true },
      mutate: () => ({
        receipt: receipt(),
        transaction: transaction('transaction-1'),
      }),
      name: 'accepts unchanged current records',
    },
    {
      expected: { isValid: false, reason: 'receipt-stale' },
      mutate: () => ({
        receipt: receipt({ fingerprint: 'changed' }),
        transaction: transaction('transaction-1'),
      }),
      name: 'rejects a changed receipt',
    },
    {
      expected: { isValid: false, reason: 'target-stale' },
      mutate: () => ({
        receipt: receipt(),
        transaction: transaction('transaction-1', { amount: -1_300 }),
      }),
      name: 'rejects a changed target',
    },
    {
      expected: { isValid: false, reason: 'target-deleted' },
      mutate: () => ({
        receipt: receipt(),
        transaction: transaction('transaction-1', { deleted: true }),
      }),
      name: 'rejects a deleted target',
    },
    {
      expected: { isValid: false, reason: 'target-reused' },
      mutate: () => ({
        receipt: receipt(),
        transaction: transaction('transaction-1', {
          linkedReceiptId: 'other-receipt',
        }),
      }),
      name: 'rejects a now-linked target',
    },
    {
      expected: { isValid: false, reason: 'wrong-budget' },
      mutate: () => ({
        receipt: receipt(),
        transaction: transaction('transaction-1', { budgetId: 'budget-2' }),
      }),
      name: 'rejects a target from a different budget',
    },
  ] satisfies Array<{
    expected: { isValid: boolean; reason?: string };
    mutate: () => {
      receipt: ReceiptMatchReceiptSnapshot;
      transaction: ReceiptMatchTransactionSnapshot;
    };
    name: string;
  }>)('$name', ({ expected, mutate }) => {
    const originalReceipt = receipt();
    const originalTransaction = transaction('transaction-1');
    const candidate = scoreReceiptMatchCandidate(
      originalReceipt,
      originalTransaction,
    );
    expect(candidate).not.toBeNull();
    const { receipt: currentReceipt, transaction: currentTransaction } =
      mutate();

    expect(
      validateReceiptMatchConfirmation({
        confirmation: createReceiptMatchConfirmation(
          originalReceipt,
          candidate!,
        ),
        receipt: currentReceipt,
        transaction: currentTransaction,
      }),
    ).toEqual(expected);
  });
});
