import {
  createFinanceMetadata,
  findFinanceReviewDecision,
  parseFinanceMetadata,
  withFinanceReviewDecision,
  withoutFinanceReviewDecision,
} from './finance-metadata';

describe('native finance metadata', () => {
  test('starts empty and records one deterministic decision per candidate', () => {
    const deferred = withFinanceReviewDecision(createFinanceMetadata(), {
      candidateKey: 'recurring:streaming:monthly',
      decision: 'deferred',
      feature: 'recurring',
      updatedAt: '2026-08-01T12:00:00.000Z',
    });
    const applied = withFinanceReviewDecision(deferred, {
      candidateKey: 'recurring:streaming:monthly',
      decision: 'applied',
      feature: 'recurring',
      updatedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(applied.reviewDecisions).toEqual([
      {
        candidateKey: 'recurring:streaming:monthly',
        decision: 'applied',
        feature: 'recurring',
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
    ]);
    expect(
      findFinanceReviewDecision(
        applied,
        'recurring',
        'recurring:streaming:monthly',
      ),
    ).toMatchObject({ decision: 'applied' });
    expect(applied.amazonOrders).toEqual([]);
  });

  test('reopens only the requested feature and candidate', () => {
    const recurring = withFinanceReviewDecision(createFinanceMetadata(), {
      candidateKey: 'shared-key',
      decision: 'deferred',
      feature: 'recurring',
      updatedAt: '2026-08-01T12:00:00.000Z',
    });
    const withAmazon = withFinanceReviewDecision(recurring, {
      candidateKey: 'shared-key',
      decision: 'rejected',
      feature: 'amazon',
      updatedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(
      withoutFinanceReviewDecision(withAmazon, 'recurring', 'shared-key')
        .reviewDecisions,
    ).toEqual([
      {
        candidateKey: 'shared-key',
        decision: 'rejected',
        feature: 'amazon',
        updatedAt: '2026-08-01T12:00:00.000Z',
      },
    ]);
  });

  test('normalizes persisted decisions and drops unknown fields', () => {
    expect(
      parseFinanceMetadata({
        reviewDecisions: [
          {
            candidateKey: 'amazon:order-2',
            decision: 'deferred',
            feature: 'amazon',
            rawEmail: 'must not survive',
            updatedAt: '2026-08-01T12:00:00.000Z',
          },
          {
            candidateKey: 'reconciliation:pair-1',
            decision: 'keep-both',
            feature: 'reconciliation',
            updatedAt: '2026-08-01T12:00:00.000Z',
          },
        ],
        version: 1,
      }),
    ).toEqual({
      amazonOrders: [],
      reviewDecisions: [
        {
          candidateKey: 'amazon:order-2',
          decision: 'deferred',
          feature: 'amazon',
          updatedAt: '2026-08-01T12:00:00.000Z',
        },
        {
          candidateKey: 'reconciliation:pair-1',
          decision: 'keep-both',
          feature: 'reconciliation',
          updatedAt: '2026-08-01T12:00:00.000Z',
        },
      ],
      version: 1,
    });
  });

  test('keeps only bounded normalized Amazon review data', () => {
    const metadata = parseFinanceMetadata({
      amazonOrders: [
        {
          currency: 'USD',
          date: '2026-08-01',
          discountTotal: 0,
          giftCardTotal: 0,
          itemSubtotal: 1299,
          items: [
            {
              discountAmount: 0,
              id: 'item-1',
              quantity: 1,
              refundAmount: 0,
              shipmentId: null,
              shippingAmount: 0,
              taxAmount: 0,
              title: 'Synthetic item',
              unitAmount: 1299,
              uploadedEmailBody: 'must not survive',
            },
          ],
          marketplace: 'amazon.com',
          orderId: '111-2222222-3333333',
          orderTotal: 1299,
          rawUploadedBytes: 'must not survive',
          refundTotal: 0,
          refunds: [],
          shipments: [],
          shippingTotal: 0,
          taxTotal: 0,
        },
      ],
      reviewDecisions: [],
      version: 1,
    });

    expect(metadata.amazonOrders).toEqual([
      expect.objectContaining({
        orderId: '111-2222222-3333333',
        items: [
          expect.not.objectContaining({ uploadedEmailBody: expect.anything() }),
        ],
      }),
    ]);
    expect(JSON.stringify(metadata).includes('must not survive')).toBe(false);
  });

  test('rejects malformed metadata instead of silently changing a decision', () => {
    expect(() =>
      parseFinanceMetadata({ reviewDecisions: [], version: 2 }),
    ).toThrow('unsupported version');
    expect(() =>
      parseFinanceMetadata({
        amazonOrders: null,
        reviewDecisions: [],
        version: 1,
      }),
    ).toThrow('review orders are invalid');
    expect(() =>
      parseFinanceMetadata({
        reviewDecisions: [
          {
            candidateKey: '',
            decision: 'keep-both',
            feature: 'reconciliation',
            updatedAt: '2026-08-01T12:00:00.000Z',
          },
        ],
        version: 1,
      }),
    ).toThrow('review decision is invalid');
  });
});
