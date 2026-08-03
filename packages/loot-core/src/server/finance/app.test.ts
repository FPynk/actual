import * as db from '#server/db';
import { runHandler, runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { clearUndo, undo } from '#server/undo';
import { categorizationFingerprint } from '#shared/finance-categorization';
import { withFinanceReviewDecision } from '#shared/finance-metadata';
import {
  buildAmazonPaymentSources,
  matchAmazonPayments,
} from '#shared/finance/amazon';
import { detectRecurringPayments } from '#shared/finance/recurring-detector';
import { financeCategorizationPreferenceId } from '#types/finance';

import {
  app,
  getAmazonReviewDecisions,
  getAmazonReviewOrders,
  isReconciliationDecision,
  isRecurringReviewDecision,
  reopenAmazonReviewDecision,
  reopenRecurringReviewDecision,
  saveAmazonReviewDecision,
  saveAmazonReviewOrders,
  saveRecurringReviewDecision,
} from './app';

async function prepareDuplicatePair() {
  await db.insertCategoryGroup({
    id: 'expenses',
    name: 'Expenses',
    is_income: 0,
  });
  await db.insertCategory({
    id: 'provider-category',
    name: 'Provider category',
    cat_group: 'expenses',
    is_income: 0,
  });
  await db.insertCategory({
    id: 'manual-category',
    name: 'Manual category',
    cat_group: 'expenses',
    is_income: 0,
  });
  await db.insertAccount({ id: 'checking', name: 'Checking' });
  await db.insertPayee({ id: 'provider-payee', name: 'Corner Shop' });
  await db.insertPayee({ id: 'manual-payee', name: 'Corner Shop' });

  await db.insertTransaction({
    id: 'provider',
    account: 'checking',
    amount: -1299,
    category: 'provider-category',
    date: '2026-07-10',
    imported_id: 'bank-123',
    imported_payee: 'CORNER SHOP',
    notes: 'Provider note',
    payee: 'provider-payee',
  });
  await db.insertTransaction({
    id: 'manual',
    account: 'checking',
    amount: -1299,
    category: 'manual-category',
    date: '2026-07-10',
    notes: 'User note',
    payee: 'manual-payee',
  });
}

async function currentTransactions() {
  return db.all<db.DbViewTransaction>(
    'SELECT * FROM v_transactions WHERE tombstone = 0 ORDER BY id',
  );
}

test('runtime-validates every native reconciliation decision value', () => {
  expect(isReconciliationDecision('merge')).toBe(true);
  expect(isReconciliationDecision('keep-both')).toBe(true);
  expect(isReconciliationDecision('deferred')).toBe(true);
  expect(isReconciliationDecision('unknown')).toBe(false);
});

describe('native reconciliation ledger decisions', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    prefs.unloadPrefs();
    await prefs.loadPrefs();
    clearUndo();
    await prepareDuplicatePair();
  });

  afterEach(async () => {
    prefs.unloadPrefs();
    clearUndo();
    await global.emptyDatabase()();
  });

  test('merges through one undoable action while preserving manual fields', async () => {
    const [candidate] = await app.handlers['finance/reconciliation-list']();

    const result = await runHandler(
      app.handlers['finance/reconciliation-decide'],
      {
        candidateKey: candidate.candidateKey,
        decision: 'merge',
        fingerprint: candidate.fingerprint,
      },
    );

    expect(result).toEqual({
      keptTransactionId: 'provider',
      status: 'merged',
    });
    expect(await currentTransactions()).toMatchObject([
      {
        id: 'provider',
        category: 'manual-category',
        imported_id: 'bank-123',
        notes: 'User note',
        payee: 'manual-payee',
      },
    ]);

    await runMutator(() => undo());

    expect(await currentTransactions()).toHaveLength(2);
  });

  test('returns stale and changes nothing after reviewed evidence changes', async () => {
    const [candidate] = await app.handlers['finance/reconciliation-list']();
    await db.updateTransaction({ id: 'manual', notes: 'Changed after review' });
    const beforeDecision = await currentTransactions();

    const result = await runHandler(
      app.handlers['finance/reconciliation-decide'],
      {
        candidateKey: candidate.candidateKey,
        decision: 'merge',
        fingerprint: candidate.fingerprint,
      },
    );

    expect(result).toEqual({ status: 'stale' });
    expect(await currentTransactions()).toEqual(beforeDecision);
  });

  test('keeps an explicit keep-both choice through later undo actions', async () => {
    const [candidate] = await app.handlers['finance/reconciliation-list']();

    await runHandler(app.handlers['finance/reconciliation-decide'], {
      candidateKey: candidate.candidateKey,
      decision: 'keep-both',
      fingerprint: candidate.fingerprint,
    });
    await runMutator(() => undo());

    expect(await currentTransactions()).toHaveLength(2);
    expect(await app.handlers['finance/reconciliation-list']()).toEqual([]);
  });
});

describe('recurring finance review decisions', () => {
  beforeEach(async () => {
    await prefs.loadPrefs();
  });

  afterEach(() => {
    prefs.unloadPrefs();
  });

  it('persists deferred, rejected, and applied decisions by full candidate key', async () => {
    await saveRecurringReviewDecision({
      candidateKey: '["account-1","payee-1","monthly"]',
      decision: 'deferred',
    });
    await saveRecurringReviewDecision({
      candidateKey: '["account-2","payee-1","monthly"]',
      decision: 'rejected',
    });
    await saveRecurringReviewDecision({
      candidateKey: '["account-3","payee-1","monthly"]',
      decision: 'applied',
    });

    expect(
      prefs.getFinanceMetadata().reviewDecisions.map(record => ({
        candidateKey: record.candidateKey,
        decision: record.decision,
      })),
    ).toEqual([
      {
        candidateKey: '["account-1","payee-1","monthly"]',
        decision: 'deferred',
      },
      {
        candidateKey: '["account-2","payee-1","monthly"]',
        decision: 'rejected',
      },
      {
        candidateKey: '["account-3","payee-1","monthly"]',
        decision: 'applied',
      },
    ]);
  });

  it('reopens only the matching recurring decision', async () => {
    await prefs.saveFinanceMetadata(
      withFinanceReviewDecision(prefs.getFinanceMetadata(), {
        candidateKey: 'amazon-order-1',
        decision: 'applied',
        feature: 'amazon',
        updatedAt: '2026-08-02T12:00:00.000Z',
      }),
    );
    await saveRecurringReviewDecision({
      candidateKey: '["account","payee","monthly"]',
      decision: 'deferred',
    });

    await reopenRecurringReviewDecision({
      candidateKey: '["account","payee","monthly"]',
    });

    expect(prefs.getFinanceMetadata().reviewDecisions).toEqual([
      {
        candidateKey: 'amazon-order-1',
        decision: 'applied',
        feature: 'amazon',
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
    ]);
  });

  it('rejects decisions that belong to other finance workflows', () => {
    expect(isRecurringReviewDecision('deferred')).toBe(true);
    expect(isRecurringReviewDecision('keep-both')).toBe(false);
  });
});

describe('Amazon review persistence', () => {
  const syntheticOrder = {
    currency: 'USD',
    date: '2026-08-01',
    discountTotal: 0,
    giftCardTotal: 0,
    itemSubtotal: 1299,
    items: [
      {
        discountAmount: 0,
        id: 'synthetic-item',
        quantity: 1,
        refundAmount: 0,
        shipmentId: null,
        shippingAmount: 0,
        taxAmount: 0,
        title: 'Synthetic test item',
        unitAmount: 1299,
      },
    ],
    marketplace: 'amazon.com',
    orderId: '111-2222222-3333333',
    orderTotal: 1299,
    refundTotal: 0,
    refunds: [],
    shipments: [],
    shippingTotal: 0,
    taxTotal: 0,
  };

  beforeEach(async () => {
    await global.emptyDatabase()();
    prefs.unloadPrefs();
    await prefs.loadPrefs();
    clearUndo();
  });

  afterEach(async () => {
    prefs.unloadPrefs();
    clearUndo();
    await global.emptyDatabase()();
  });

  it('deduplicates normalized data and persists a reopenable decision without ledger writes', async () => {
    expect(
      await saveAmazonReviewOrders({ orders: [syntheticOrder] }),
    ).toMatchObject({
      status: 'saved',
    });
    expect(
      await saveAmazonReviewOrders({ orders: [syntheticOrder] }),
    ).toMatchObject({
      status: 'saved',
    });
    const changedOrder = {
      ...syntheticOrder,
      items: [{ ...syntheticOrder.items[0], title: 'Updated synthetic item' }],
    };
    expect(await saveAmazonReviewOrders({ orders: [changedOrder] })).toEqual({
      conflictingOrderIds: ['111-2222222-3333333'],
      status: 'conflict',
    });
    expect(await getAmazonReviewOrders()).toEqual([syntheticOrder]);
    expect(await currentTransactions()).toEqual([]);
    expect(
      await saveAmazonReviewOrders({
        orders: [changedOrder],
        replaceExistingOrderIds: ['111-2222222-3333333'],
      }),
    ).toMatchObject({ status: 'saved' });
    expect(await getAmazonReviewOrders()).toEqual([changedOrder]);
    expect(await currentTransactions()).toEqual([]);
    await saveAmazonReviewDecision({
      candidateKey: 'amazon:charge:111-2222222-3333333',
      decision: 'deferred',
    });

    expect(await getAmazonReviewOrders()).toEqual([changedOrder]);
    expect(await getAmazonReviewDecisions()).toMatchObject([
      {
        candidateKey: 'amazon:charge:111-2222222-3333333',
        decision: 'deferred',
      },
    ]);
    expect(await currentTransactions()).toEqual([]);

    await reopenAmazonReviewDecision({
      candidateKey: 'amazon:charge:111-2222222-3333333',
    });

    expect(await getAmazonReviewOrders()).toEqual([changedOrder]);
    expect(await getAmazonReviewDecisions()).toEqual([]);
    expect(await currentTransactions()).toEqual([]);
  });

  it('applies approved Amazon allocations as one balanced native split and one undo', async () => {
    const splitOrder = {
      ...syntheticOrder,
      items: [
        { ...syntheticOrder.items[0], unitAmount: 700 },
        {
          ...syntheticOrder.items[0],
          id: 'second-synthetic-item',
          title: 'Second synthetic item',
          unitAmount: 599,
        },
      ],
      orderId: '222-3333333-4444444',
    };
    await db.insertCategoryGroup({
      id: 'amazon-expenses',
      name: 'Amazon expenses',
      is_income: 0,
    });
    await db.insertCategory({
      id: 'amazon-household',
      name: 'Household',
      cat_group: 'amazon-expenses',
      is_income: 0,
    });
    await db.insertCategory({
      id: 'amazon-groceries',
      name: 'Groceries',
      cat_group: 'amazon-expenses',
      is_income: 0,
    });
    await db.insertAccount({ id: 'amazon-checking', name: 'Checking' });
    await db.insertPayee({ id: 'amazon-payee', name: 'Amazon' });
    await db.insertTransaction({
      id: 'amazon-transaction',
      account: 'amazon-checking',
      amount: -1299,
      category: null,
      cleared: true,
      date: '2026-08-01',
      imported_payee: 'AMZN MKTP',
      notes: 'Existing note',
      payee: 'amazon-payee',
    });
    db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [
      'defaultCurrencyCode',
      'USD',
    ]);
    await saveAmazonReviewOrders({ orders: [splitOrder] });
    const [match] = matchAmazonPayments(
      buildAmazonPaymentSources([splitOrder]),
      [
        {
          ...(await db.getTransaction('amazon-transaction'))!,
          payee_name: 'Amazon',
        },
      ],
      'USD',
    );

    const result = await runHandler(app.handlers['finance/amazon/apply'], {
      applyNote: true,
      applySplit: true,
      candidateKey: match.candidateKey,
      categoryIdsByAllocationId: {
        'second-synthetic-item:merchandise': 'amazon-groceries',
        'synthetic-item:merchandise': 'amazon-household',
      },
      evidenceFingerprint: match.evidenceFingerprint,
      transactionId: 'amazon-transaction',
    });

    expect(result).toEqual({
      status: 'applied',
      appliedFields: ['note', 'split'],
    });
    expect(await db.getTransaction('amazon-transaction')).toMatchObject({
      category: null,
      is_parent: true,
      notes: 'Existing note\nAmazon 222-3333333-4444444',
      payee: null,
    });
    expect(
      await db.all(
        'SELECT amount, category, notes FROM v_transactions WHERE parent_id = ? ORDER BY amount',
        ['amazon-transaction'],
      ),
    ).toEqual([
      {
        amount: -700,
        category: 'amazon-household',
        notes: 'Synthetic test item',
      },
      {
        amount: -599,
        category: 'amazon-groceries',
        notes: 'Second synthetic item',
      },
    ]);
    expect(await getAmazonReviewDecisions()).toMatchObject([
      { candidateKey: match.candidateKey, decision: 'applied' },
    ]);

    await runMutator(() => undo());

    expect(await db.getTransaction('amazon-transaction')).toMatchObject({
      category: null,
      is_parent: false,
      notes: 'Existing note',
      payee: 'amazon-payee',
    });
    expect(
      await db.all('SELECT id FROM v_transactions WHERE parent_id = ?', [
        'amazon-transaction',
      ]),
    ).toEqual([]);
    expect(await getAmazonReviewDecisions()).toMatchObject([
      { candidateKey: match.candidateKey, decision: 'applied' },
    ]);
  });

  it('applies a selected category directly for a one-allocation Amazon charge', async () => {
    await db.insertCategoryGroup({
      id: 'amazon-expenses',
      name: 'Amazon expenses',
      is_income: 0,
    });
    await db.insertCategory({
      id: 'amazon-household',
      name: 'Household',
      cat_group: 'amazon-expenses',
      is_income: 0,
    });
    await db.insertCategoryGroup({
      id: 'amazon-income',
      name: 'Income',
      is_income: 1,
    });
    await db.insertCategory({
      id: 'amazon-income-category',
      name: 'Income category',
      cat_group: 'amazon-income',
      is_income: 1,
    });
    await db.insertAccount({ id: 'amazon-checking', name: 'Checking' });
    await db.insertPayee({ id: 'amazon-payee', name: 'Amazon' });
    await db.insertTransaction({
      id: 'amazon-transaction',
      account: 'amazon-checking',
      amount: -1299,
      category: null,
      date: '2026-08-01',
      payee: 'amazon-payee',
    });
    db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [
      'defaultCurrencyCode',
      'USD',
    ]);
    await saveAmazonReviewOrders({ orders: [syntheticOrder] });
    const [match] = matchAmazonPayments(
      buildAmazonPaymentSources([syntheticOrder]),
      [
        {
          ...(await db.getTransaction('amazon-transaction'))!,
          payee_name: 'Amazon',
        },
      ],
      'USD',
    );

    await expect(
      runHandler(app.handlers['finance/amazon/apply'], {
        applyNote: false,
        applySplit: false,
        candidateKey: match.candidateKey,
        categoryIdsByAllocationId: {
          'synthetic-item:merchandise': 'amazon-income-category',
        },
        evidenceFingerprint: match.evidenceFingerprint,
        transactionId: 'amazon-transaction',
      }),
    ).rejects.toThrow('Amazon allocation category does not exist.');
    expect(
      (await db.getTransaction('amazon-transaction'))?.category,
    ).toBeNull();

    const result = await runHandler(app.handlers['finance/amazon/apply'], {
      applyNote: false,
      applySplit: false,
      candidateKey: match.candidateKey,
      categoryIdsByAllocationId: {
        'synthetic-item:merchandise': 'amazon-household',
      },
      evidenceFingerprint: match.evidenceFingerprint,
      transactionId: 'amazon-transaction',
    });

    expect(result).toEqual({
      status: 'applied',
      appliedFields: ['category'],
    });
    expect(await db.getTransaction('amazon-transaction')).toMatchObject({
      category: 'amazon-household',
      is_parent: false,
    });
  });

  it('does not write when a reviewed target becomes unsafe', async () => {
    await db.insertAccount({ id: 'amazon-checking', name: 'Checking' });
    await db.insertPayee({ id: 'amazon-payee', name: 'Amazon' });
    await db.insertTransaction({
      id: 'amazon-transaction',
      account: 'amazon-checking',
      amount: -1299,
      category: null,
      date: '2026-08-01',
      payee: 'amazon-payee',
    });
    db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [
      'defaultCurrencyCode',
      'USD',
    ]);
    await saveAmazonReviewOrders({ orders: [syntheticOrder] });
    const [match] = matchAmazonPayments(
      buildAmazonPaymentSources([syntheticOrder]),
      [
        {
          ...(await db.getTransaction('amazon-transaction'))!,
          payee_name: 'Amazon',
        },
      ],
      'USD',
    );
    for (const update of [
      { label: 'reconciled', values: { reconciled: true } },
      { label: 'transfer', values: { transfer_id: 'other-transaction' } },
      { label: 'split parent', values: { is_parent: true } },
    ]) {
      await db.updateTransaction({
        id: 'amazon-transaction',
        ...update.values,
      });
      await expect(
        runHandler(app.handlers['finance/amazon/apply'], {
          applyNote: true,
          applySplit: false,
          candidateKey: match.candidateKey,
          categoryIdsByAllocationId: {},
          evidenceFingerprint: match.evidenceFingerprint,
          transactionId: 'amazon-transaction',
        }),
        update.label,
      ).resolves.toEqual({ status: 'stale', appliedFields: [] });
      await db.updateTransaction({
        id: 'amazon-transaction',
        is_parent: false,
        reconciled: false,
        transfer_id: null,
      });
    }
    expect(await db.getTransaction('amazon-transaction')).toMatchObject({
      notes: null,
    });
    expect(await getAmazonReviewDecisions()).toEqual([]);
  });
});

describe('native recurring schedule apply', () => {
  const recurringTransactions = [
    { date: '2026-05-05', id: 'subscription-may' },
    { date: '2026-06-05', id: 'subscription-june' },
    { date: '2026-07-05', id: 'subscription-july' },
  ] as const;

  beforeEach(async () => {
    await global.emptyDatabase()();
    prefs.unloadPrefs();
    await prefs.loadPrefs();
    clearUndo();
    await db.insertAccount({ id: 'recurring-checking', name: 'Checking' });
    await db.insertPayee({ id: 'streaming-payee', name: 'Example Streaming' });
    for (const transaction of recurringTransactions) {
      await db.insertTransaction({
        ...transaction,
        account: 'recurring-checking',
        amount: -1299,
        payee: 'streaming-payee',
      });
    }
  });

  afterEach(async () => {
    prefs.unloadPrefs();
    clearUndo();
    await global.emptyDatabase()();
  });

  it('creates one native schedule and removes it with one undo', async () => {
    const [candidate] = detectRecurringPayments(
      recurringTransactions.map(transaction => ({
        accountId: 'recurring-checking',
        amount: -1299,
        date: transaction.date,
        id: transaction.id,
        isReconciled: false,
        isSplitParent: false,
        isStartingBalance: false,
        isTombstone: false,
        isTransfer: false,
        payeeId: 'streaming-payee',
        payeeName: 'Example Streaming',
      })),
    );

    const result = await runHandler(app.handlers['finance/recurring/apply'], {
      candidateKey: candidate.candidateKey,
      evidenceFingerprint: candidate.evidenceFingerprint,
    });

    expect(result).toMatchObject({ status: 'created' });
    if (result.status !== 'created') {
      throw new Error('Expected the recurring review to create a schedule.');
    }
    expect(
      await db.all<{ id: string }>(
        'SELECT id FROM schedules WHERE tombstone = 0',
      ),
    ).toEqual([{ id: result.scheduleId }]);

    await runMutator(() => undo());

    expect(
      await db.all('SELECT id FROM schedules WHERE tombstone = 0'),
    ).toEqual([]);
  });
});

describe('native categorization apply', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    prefs.unloadPrefs();
    await prefs.loadPrefs();
    clearUndo();
    await db.insertCategoryGroup({
      id: 'categorization-expenses',
      name: 'Expenses',
      is_income: 0,
    });
    await db.insertCategory({
      id: 'categorization-groceries',
      name: 'Groceries',
      cat_group: 'categorization-expenses',
      is_income: 0,
    });
    await db.insertCategoryGroup({
      id: 'categorization-income',
      name: 'Income',
      is_income: 1,
    });
    await db.insertCategory({
      id: 'categorization-salary',
      name: 'Salary',
      cat_group: 'categorization-income',
      is_income: 1,
    });
    await db.insertAccount({ id: 'categorization-checking', name: 'Checking' });
    await db.insertPayee({ id: 'categorization-market', name: 'Market' });
    await db.insertPayee({ id: 'categorization-employer', name: 'Employer' });
    await db.insertTransaction({
      id: 'categorization-transaction',
      account: 'categorization-checking',
      amount: -2499,
      category: null,
      date: '2026-08-02',
      imported_payee: 'MARKET 123',
      payee: 'categorization-market',
    });
    await db.insertTransaction({
      id: 'categorization-deposit',
      account: 'categorization-checking',
      amount: 250_000,
      category: null,
      date: '2026-08-03',
      imported_payee: 'PAYROLL DEPOSIT',
      payee: 'categorization-employer',
    });
    db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [
      financeCategorizationPreferenceId,
      JSON.stringify({
        categoryIds: ['categorization-groceries', 'categorization-salary'],
      }),
    ]);
  });

  afterEach(async () => {
    prefs.unloadPrefs();
    clearUndo();
    await global.emptyDatabase()();
  });

  it('applies a mixed outflow and inflow batch and restores both with one undo', async () => {
    const result = await runHandler(
      app.handlers['finance-categorization-apply'],
      {
        includeCategorized: false,
        proposals: [
          {
            categoryId: 'categorization-groceries',
            fingerprint: categorizationFingerprint({
              accountId: 'categorization-checking',
              accountName: 'Checking',
              amount: -2499,
              categoryId: null,
              date: '2026-08-02',
              importedPayee: 'MARKET 123',
              payeeId: 'categorization-market',
              payeeName: 'Market',
              transactionId: 'categorization-transaction',
            }),
            transactionId: 'categorization-transaction',
          },
          {
            categoryId: 'categorization-salary',
            fingerprint: categorizationFingerprint({
              accountId: 'categorization-checking',
              accountName: 'Checking',
              amount: 250_000,
              categoryId: null,
              date: '2026-08-03',
              importedPayee: 'PAYROLL DEPOSIT',
              payeeId: 'categorization-employer',
              payeeName: 'Employer',
              transactionId: 'categorization-deposit',
            }),
            transactionId: 'categorization-deposit',
          },
        ],
      },
    );

    expect(result).toEqual({
      appliedTransactionIds: [
        'categorization-transaction',
        'categorization-deposit',
      ],
      skipped: [],
    });
    expect(
      (await db.getTransaction('categorization-transaction'))?.category,
    ).toBe('categorization-groceries');
    expect((await db.getTransaction('categorization-deposit'))?.category).toBe(
      'categorization-salary',
    );

    await runMutator(() => undo());

    expect(
      (await db.getTransaction('categorization-transaction'))?.category,
    ).toBeNull();
    expect(
      (await db.getTransaction('categorization-deposit'))?.category,
    ).toBeNull();
  });
});
