import * as db from '#server/db';
import * as prefs from '#server/prefs';
import type { ReceiptReviewedDraft } from '#types/receipts';

import { app } from './app';

const reviewedDraft: ReceiptReviewedDraft = {
  currency: 'USD',
  fieldConfidence: { total: 0.95 },
  lineItems: [{ amount: 499, label: 'Apples' }],
  merchant: 'Corner Shop',
  ocrRevision: 'ocr-v1',
  parserRevision: 'parser-v1',
  paymentHint: null,
  purchaseDate: '2026-08-01',
  purchaseTime: null,
  sourceHash: 'b'.repeat(64),
  subtotal: 449,
  tax: 50,
  tip: null,
  total: 499,
  transcript: 'Apples 4.99',
  warnings: [],
};

beforeEach(async () => {
  await global.emptyDatabase()();
  await prefs.loadPrefs();
});

describe('receipt persistence privacy boundary', () => {
  test('drops raw-image and browser-preview fields before persistence', async () => {
    const rawImageMarker = 'data:image/png;base64,synthetic-private-image';
    const previewMarker = 'blob:synthetic-private-preview';
    const saved = await app.handlers['receipts/save-reviewed']({
      expectedBudgetId: 'test',
      receipt: {
        ...reviewedDraft,
        imageData: rawImageMarker,
        previewUrl: previewMarker,
      } as ReceiptReviewedDraft,
    });
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') throw new Error('Expected receipt save.');

    const storedReceipt = await db.getReceipt(saved.receipt.id);
    expect(storedReceipt).not.toBeNull();
    const storedJson = JSON.stringify(storedReceipt);
    expect(storedJson).not.toContain(rawImageMarker);
    expect(storedJson).not.toContain(previewMarker);
    expect(Object.keys(storedReceipt ?? {})).not.toEqual(
      expect.arrayContaining(['image', 'image_data', 'preview_url']),
    );
  });
});
