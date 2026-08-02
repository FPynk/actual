import * as db from '#server/db';
import { runHandler, runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { clearUndo, undo } from '#server/undo';
import { categorizationFingerprint } from '#shared/finance-categorization';
import { withFinanceReviewDecision } from '#shared/finance-metadata';
import { detectRecurringPayments } from '#shared/finance/recurring-detector';
import { financeCategorizationPreferenceId } from '#types/finance';

import {
  app,
  isReconciliationDecision,
  isRecurringReviewDecision,
  reopenRecurringReviewDecision,
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
    await db.insertAccount({ id: 'categorization-checking', name: 'Checking' });
    await db.insertPayee({ id: 'categorization-market', name: 'Market' });
    await db.insertTransaction({
      id: 'categorization-transaction',
      account: 'categorization-checking',
      amount: -2499,
      category: null,
      date: '2026-08-02',
      imported_payee: 'MARKET 123',
      payee: 'categorization-market',
    });
    db.runQuery('INSERT INTO preferences (id, value) VALUES (?, ?)', [
      financeCategorizationPreferenceId,
      JSON.stringify({ categoryIds: ['categorization-groceries'] }),
    ]);
  });

  afterEach(async () => {
    prefs.unloadPrefs();
    clearUndo();
    await global.emptyDatabase()();
  });

  it('applies one category batch and restores it with one undo', async () => {
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
        ],
      },
    );

    expect(result).toEqual({
      appliedTransactionIds: ['categorization-transaction'],
      skipped: [],
    });
    expect(
      (await db.getTransaction('categorization-transaction'))?.category,
    ).toBe('categorization-groceries');

    await runMutator(() => undo());

    expect(
      (await db.getTransaction('categorization-transaction'))?.category,
    ).toBeNull();
  });
});
