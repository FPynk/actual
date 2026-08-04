import {
  fingerprintReceipt,
  redactReceiptSensitiveNumbers,
  validateReceiptReviewedDraft,
} from './receipts';

const draft = {
  currency: 'usd',
  fieldConfidence: { total: 0.9 },
  lineItems: [{ amount: 1_299, label: 'Milk' }],
  merchant: ' Corner   Shop ',
  ocrRevision: 'ocr-v1',
  parserRevision: 'parser-v1',
  paymentHint: 'Visa 1234 5678 9012 3456',
  purchaseDate: '2026-08-01',
  purchaseTime: null,
  sourceHash: 'a'.repeat(64),
  subtotal: 1_199,
  tax: 100,
  tip: null,
  total: 1_299,
  transcript: 'Visa 1234 5678 9012 3456\nMilk 12.99',
  warnings: [],
};

describe('receipt persistence validation', () => {
  test('normalizes bounded reviewed fields and redacts sensitive numbers', () => {
    expect(validateReceiptReviewedDraft(draft)).toMatchObject({
      currency: 'USD',
      merchant: 'Corner Shop',
      paymentHint: 'Visa •••• 3456',
      transcript: 'Visa [redacted]\nMilk 12.99',
    });
  });

  test('makes equivalent reviewed receipts fingerprint identically', async () => {
    const reviewed = validateReceiptReviewedDraft(draft);
    await expect(fingerprintReceipt(reviewed)).resolves.toBe(
      await fingerprintReceipt({ ...reviewed, merchant: 'Corner Shop' }),
    );
  });

  test('does not keep card digits in general receipt text', () => {
    expect(redactReceiptSensitiveNumbers('Account 1234 5678 9012 3456')).toBe(
      'Account [redacted]',
    );
  });
});
