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
  test('serializes only bounded reviewed merchant and transcript for OpenAI', () => {
    const privateReceipt = {
      fingerprint: 'receipt-fingerprint',
      id: 'actual-receipt-id',
      merchant: 'Corner Shop',
      transcriptRevision: 2,
      imageData: 'data:image/png;base64,synthetic-private-image',
      ocrBoxes: [{ text: 'Apples', polygon: [[0, 0]] }],
      paymentHint: 'Visa 1234',
      transcript:
        'Reviewed apples\nVISA 1234\nCARD ending 5678\nDebit 9012\nOrder ID: ORD-3456\nReceipt #: 445566\nMember No. 778899\n07/10/2026 07:53 PM\nAugust 4, 2026\nshop@example.com\nand milk receipt transcript',
    } as CategorizationReceiptSource;

    const payload = toCategorizationGatewayCandidate(
      withCategorizationReceiptEvidence(candidate, privateReceipt),
    );
    const serializedPayload = JSON.stringify(payload);

    expect(payload).toMatchObject({
      receipt: {
        merchant: 'Corner Shop',
        transcript: expect.stringContaining('Reviewed apples'),
      },
    });
    expect(payload.receipt?.transcript).toContain('milk receipt transcript');
    expect(serializedPayload).not.toContain('synthetic-private-image');
    expect(serializedPayload).not.toContain('Visa 1234');
    expect(serializedPayload).not.toContain('VISA 1234');
    expect(serializedPayload).not.toContain('CARD ending 5678');
    expect(serializedPayload).not.toContain('Debit 9012');
    expect(serializedPayload).not.toContain('ORD-3456');
    expect(serializedPayload).not.toContain('445566');
    expect(serializedPayload).not.toContain('778899');
    expect(serializedPayload).not.toContain('07/10/2026');
    expect(serializedPayload).not.toContain('August 4, 2026');
    expect(serializedPayload).not.toContain('shop@example.com');
    expect(serializedPayload).not.toContain('actual-receipt-id');
    expect(serializedPayload).not.toContain('receipt-fingerprint');
  });
});
