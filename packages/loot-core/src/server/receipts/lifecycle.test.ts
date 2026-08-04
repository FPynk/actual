import * as db from '#server/db';
import * as prefs from '#server/prefs';
import type {
  Receipt,
  ReceiptMatchCandidate,
  ReceiptReviewedDraft,
} from '#types/receipts';

import { app } from './app';

function receiptDraft(sourceHash: string): ReceiptReviewedDraft {
  return {
    currency: 'USD',
    fieldConfidence: { total: 0.95 },
    lineItems: [{ amount: 1_299, label: 'Milk' }],
    merchant: 'Corner Shop',
    ocrRevision: 'ocr-v1',
    parserRevision: 'parser-v1',
    paymentHint: null,
    purchaseDate: '2026-08-01',
    purchaseTime: null,
    sourceHash,
    subtotal: 1_199,
    tax: 100,
    tip: null,
    total: 1_299,
    transcript: 'Milk 12.99',
    warnings: [],
  };
}

beforeEach(async () => {
  await global.emptyDatabase()();
  await prefs.loadPrefs();
  await db.insertAccount({ id: 'account-1', name: 'Checking' });
  await db.insertTransaction({
    account: 'account-1',
    amount: -1_299,
    date: '2026-08-01',
    id: 'transaction-1',
    imported_payee: 'Corner Shop',
  });
  await db.insertTransaction({
    account: 'account-1',
    amount: -1_299,
    date: '2026-08-02',
    id: 'transaction-2',
    imported_payee: 'Corner Shop',
  });
});

describe('receipt handler lifecycle', () => {
  test('guards edits and links against stale snapshots and supports the explicit lifecycle', async () => {
    const initial = await save(receiptDraft('1'.repeat(64)));
    const edited = await save(
      { ...receiptDraft('1'.repeat(64)), merchant: 'Corner Shop Market' },
      initial,
    );
    await expect(
      app.handlers['receipts/save-reviewed']({
        expectedBudgetId: 'test',
        expectedFingerprint: initial.fingerprint,
        receipt: receiptDraft('1'.repeat(64)),
        receiptId: initial.id,
      }),
    ).resolves.toEqual({ status: 'stale' });
    expect(edited.transcriptRevision).toBe(initial.transcriptRevision + 1);
    expect(edited.fingerprint).not.toBe(initial.fingerprint);

    const staleCandidate = await matchCandidate(edited, 'transaction-1');
    await db.updateTransaction({
      id: 'transaction-1',
      imported_payee: 'Corner Shop Updated',
    });
    await expect(
      app.handlers['receipts/link']({
        candidateFingerprint: staleCandidate.candidateFingerprint,
        expectedBudgetId: 'test',
        expectedReceiptFingerprint: edited.fingerprint,
        expectedTransactionId: null,
        id: edited.id,
        transactionId: 'transaction-1',
      }),
    ).resolves.toEqual({ status: 'stale' });

    await db.updateTransaction({
      id: 'transaction-1',
      imported_payee: 'Corner Shop Market',
    });
    const linked = await link(
      edited,
      await matchCandidate(edited, 'transaction-1'),
    );
    expect(linked.transactionId).toBe('transaction-1');

    const secondReceipt = await save(receiptDraft('2'.repeat(64)));
    await expect(
      app.handlers['receipts/link']({
        candidateFingerprint: 'irrelevant-after-conflict-check',
        expectedBudgetId: 'test',
        expectedReceiptFingerprint: secondReceipt.fingerprint,
        expectedTransactionId: null,
        id: secondReceipt.id,
        transactionId: 'transaction-1',
      }),
    ).resolves.toMatchObject({
      conflictingReceiptId: edited.id,
      status: 'conflict',
    });

    const reassignmentCandidate = await matchCandidate(linked, 'transaction-2');
    const reassigned = await app.handlers['receipts/reassign']({
      candidateFingerprint: reassignmentCandidate.candidateFingerprint,
      expectedBudgetId: 'test',
      expectedReceiptFingerprint: linked.fingerprint,
      expectedTransactionId: 'transaction-1',
      id: linked.id,
      transactionId: 'transaction-2',
    });
    expect(reassigned).toMatchObject({
      receipt: { transactionId: 'transaction-2' },
      status: 'reassigned',
    });
    if (!('receipt' in reassigned)) throw new Error('Expected reassignment.');

    const unlinked = await app.handlers['receipts/unlink']({
      expectedBudgetId: 'test',
      expectedReceiptFingerprint: reassigned.receipt.fingerprint,
      expectedTransactionId: 'transaction-2',
      id: reassigned.receipt.id,
    });
    expect(unlinked).toMatchObject({
      receipt: { transactionId: null },
      status: 'unlinked',
    });
    if (!('receipt' in unlinked)) throw new Error('Expected unlink.');

    await expect(
      app.handlers['receipts/delete']({
        expectedBudgetId: 'test',
        expectedFingerprint: unlinked.receipt.fingerprint,
        id: unlinked.receipt.id,
      }),
    ).resolves.toEqual({ status: 'deleted' });
    await expect(
      app.handlers['receipts/get']({ id: unlinked.receipt.id }),
    ).resolves.toBeNull();
    await expect(db.getReceipt(unlinked.receipt.id)).resolves.toMatchObject({
      tombstone: 1,
    });
  });
});

async function save(
  receipt: ReceiptReviewedDraft,
  existingReceipt?: Receipt,
): Promise<Receipt> {
  const result = await app.handlers['receipts/save-reviewed']({
    expectedBudgetId: 'test',
    expectedFingerprint: existingReceipt?.fingerprint,
    receipt,
    receiptId: existingReceipt?.id,
  });
  if (result.status !== 'saved') throw new Error('Expected a saved receipt.');
  return result.receipt;
}

async function matchCandidate(
  receipt: Receipt,
  transactionId: string,
): Promise<ReceiptMatchCandidate> {
  const result = await app.handlers['receipts/match-candidates']({
    expectedBudgetId: 'test',
    id: receipt.id,
  });
  if ('status' in result) throw new Error('Expected candidates.');
  const candidate = result.candidates.find(
    current => current.transactionId === transactionId,
  );
  if (!candidate) throw new Error(`Missing ${transactionId} candidate.`);
  return candidate;
}

async function link(
  receipt: Receipt,
  candidate: ReceiptMatchCandidate,
): Promise<Receipt> {
  const result = await app.handlers['receipts/link']({
    candidateFingerprint: candidate.candidateFingerprint,
    expectedBudgetId: 'test',
    expectedReceiptFingerprint: receipt.fingerprint,
    expectedTransactionId: null,
    id: receipt.id,
    transactionId: candidate.transactionId,
  });
  if (!('receipt' in result) || result.status !== 'linked') {
    throw new Error('Expected linked receipt.');
  }
  return result.receipt;
}
