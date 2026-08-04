import * as db from '#server/db';
import * as prefs from '#server/prefs';
import type { ReceiptReviewedDraft } from '#types/receipts';

import { app } from './app';

const draft: ReceiptReviewedDraft = {
  currency: 'USD',
  fieldConfidence: { total: 0.95 },
  lineItems: [{ amount: 1_299, label: 'Milk' }],
  merchant: 'Corner Shop',
  ocrRevision: 'ocr-v1',
  parserRevision: 'parser-v1',
  paymentHint: null,
  purchaseDate: '2026-08-01',
  purchaseTime: null,
  sourceHash: 'a'.repeat(64),
  subtotal: 1_199,
  tax: 100,
  tip: null,
  total: 1_299,
  transcript: 'Milk 12.99',
  warnings: [],
};

beforeEach(async () => {
  await global.emptyDatabase()();
  await prefs.loadPrefs();
});

describe('receipt handlers', () => {
  test('saves reviewed data, detects duplicate source hashes, and links safely', async () => {
    expect(
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'receipts'",
      ),
    ).toEqual([{ name: 'receipts' }]);
    const saved = await app.handlers['receipts/save-reviewed']({
      expectedBudgetId: 'test',
      receipt: draft,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') {
      throw new Error('Expected a saved receipt.');
    }

    const duplicate = await app.handlers['receipts/save-reviewed']({
      expectedBudgetId: 'test',
      receipt: draft,
    });
    expect(duplicate).toMatchObject({
      receipt: { id: saved.receipt.id },
      status: 'duplicate',
    });

    await db.insertAccount({ id: 'account-1', name: 'Checking' });
    await db.insertTransaction({
      account: 'account-1',
      amount: -1_299,
      date: '2026-08-01',
      id: 'transaction-1',
    });
    const matches = await app.handlers['receipts/match-candidates']({
      expectedBudgetId: 'test',
      id: saved.receipt.id,
    });
    expect('status' in matches).toBe(false);
    if ('status' in matches) {
      throw new Error('Expected matching candidates.');
    }
    const candidate = matches.candidates[0];
    expect(candidate?.transactionId).toBe('transaction-1');
    if (!candidate) {
      throw new Error('Expected a matching candidate.');
    }

    await expect(
      app.handlers['receipts/link']({
        candidateFingerprint: candidate.candidateFingerprint,
        expectedBudgetId: 'test',
        expectedReceiptFingerprint: saved.receipt.fingerprint,
        expectedTransactionId: null,
        id: saved.receipt.id,
        transactionId: candidate.transactionId,
      }),
    ).resolves.toMatchObject({
      receipt: { transactionId: 'transaction-1' },
      status: 'linked',
    });

    expect(await app.handlers['receipts/list']()).toMatchObject([
      { linkConflict: false, transactionId: 'transaction-1' },
    ]);
  });

  test('rejects a mutation for a different active budget', async () => {
    await expect(
      app.handlers['receipts/save-reviewed']({
        expectedBudgetId: 'budget-2',
        receipt: draft,
      }),
    ).resolves.toEqual({ status: 'stale' });
    expect(await app.handlers['receipts/list']()).toEqual([]);
  });
});
