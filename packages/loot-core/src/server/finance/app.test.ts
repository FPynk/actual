import * as db from '#server/db';
import { runHandler, runMutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { clearUndo, undo } from '#server/undo';

import { app, isReconciliationDecision } from './app';

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
