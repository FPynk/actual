import {
  toCategorizationGatewayCandidate,
  withCategorizationReceiptEvidence,
} from './finance-categorization';
import type {
  CategorizationReceiptSource,
  PreparedCategorizationCandidate,
} from './finance-categorization';

const candidate: PreparedCategorizationCandidate = {
  amount: '-4.99',
  amountInteger: -499,
  candidateId: 'opaque-candidate',
  currency: 'USD',
  date: '2026-08-01',
  direction: 'outflow',
  fingerprint: 'transaction-fingerprint',
  transactionId: 'actual-transaction-id',
  transactionFingerprint: 'transaction-fingerprint',
};

describe('receipt categorization privacy boundary', () => {
  test('serializes only bounded reviewed merchant and line items for OpenAI', () => {
    const privateReceipt = {
      fingerprint: 'receipt-fingerprint',
      id: 'actual-receipt-id',
      lineItems: [{ amount: 499, label: 'Apples' }],
      merchant: 'Corner Shop',
      transcriptRevision: 2,
      imageData: 'data:image/png;base64,synthetic-private-image',
      ocrBoxes: [{ text: 'Apples', polygon: [[0, 0]] }],
      paymentHint: 'Visa 1234',
      transcript: 'The full private receipt transcript',
    } as CategorizationReceiptSource;

    const payload = toCategorizationGatewayCandidate(
      withCategorizationReceiptEvidence(candidate, privateReceipt),
    );
    const serializedPayload = JSON.stringify(payload);

    expect(payload).toMatchObject({
      receipt: {
        line_items: [{ amount: 499, label: 'Apples' }],
        merchant: 'Corner Shop',
      },
    });
    expect(serializedPayload).not.toContain('synthetic-private-image');
    expect(serializedPayload).not.toContain('full private receipt transcript');
    expect(serializedPayload).not.toContain('Visa 1234');
    expect(serializedPayload).not.toContain('actual-receipt-id');
    expect(serializedPayload).not.toContain('receipt-fingerprint');
  });
});
