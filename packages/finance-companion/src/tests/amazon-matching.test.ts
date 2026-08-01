import { buildAmazonMatchCandidates } from '#service/amazon-matching';
import type {
  AmazonSourceComponent,
  AmazonTarget,
} from '#service/amazon-matching';

const targetHash = 'a'.repeat(64);

describe('FIN-40 signed Amazon matching', () => {
  it('creates exact, deterministic one-to-many and many-to-one charge graphs', () => {
    const sources = [
      source('item-a', 'merchandise', -100),
      source('item-b', 'merchandise', -50),
    ];
    const first = build({
      sources,
      targets: [
        target('many', -150),
        target('one-a', -100),
        target('one-b', -50),
      ],
    });
    const second = build({
      sources: [...sources].reverse(),
      targets: [
        target('one-b', -50),
        target('many', -150),
        target('one-a', -100),
      ],
    });

    expect(first).toEqual(second);
    expect(
      first.filter(candidate => candidate.status === 'pending'),
    ).toMatchObject([
      {
        target: { id: 'many' },
        allocations: [{ amount: -100 }, { amount: -50 }],
      },
      { target: { id: 'one-a' }, allocations: [{ amount: -100 }] },
      { target: { id: 'one-b' }, allocations: [{ amount: -50 }] },
    ]);
    for (const candidate of first.filter(
      candidate => candidate.status === 'pending',
    )) {
      expect(
        candidate.allocations.reduce(
          (sum, allocation) => sum + allocation.amount,
          0,
        ),
      ).toBe(candidate.target.amountMinorUnits);
      expect(candidate.reasonCodes).toContain('exact-parent-sum');
    }
  });

  it('uses explicit gift card, tax, shipping, discount, and rounding components without hidden remainders', () => {
    const candidates = build({
      sources: [
        source('item', 'merchandise', -1000),
        source('item', 'tax', -80),
        source('item', 'shipping', -20),
        source('item', 'discount', 50),
        source('order', 'gift_card', 100),
        source('order', 'rounding', 1),
      ],
      targets: [target('charge', -949)],
    });
    const candidate = candidates.find(value => value.allocations.length === 6);

    expect(candidate).toMatchObject({
      status: 'pending',
      target: { id: 'charge' },
    });
    expect(
      candidate?.allocations.map(allocation => allocation.sourceComponentKind),
    ).toEqual(
      expect.arrayContaining([
        'merchandise',
        'tax',
        'shipping',
        'discount',
        'gift_card',
        'rounding',
      ]),
    );
    expect(
      candidate?.allocations.reduce(
        (sum, allocation) => sum + allocation.amount,
        0,
      ),
    ).toBe(-949);
  });

  it('only assigns refunds to positive parents and supports several refund sources', () => {
    const candidates = build({
      sources: [
        source('refund-1', 'refund', 25),
        source('refund-2', 'refund', 75),
      ],
      targets: [target('refund', 100), target('charge', -100)],
    });

    expect(
      candidates.find(candidate => candidate.target.id === 'refund'),
    ).toMatchObject({
      status: 'pending',
      reasonCodes: expect.arrayContaining(['refund-sign-match']),
      allocations: [{ amount: 25 }, { amount: 75 }],
    });
    expect(
      candidates.find(candidate => candidate.target.id === 'charge'),
    ).toBeUndefined();
  });

  it('subtracts applied reservation tombstones and active holds before proposing capacity', () => {
    const sourceValue = source('reserved-item', 'merchandise', -100);
    const candidates = build({
      sources: [sourceValue],
      targets: [target('new-target', -100), target('already-used', -100)],
      capacityUses: [
        {
          sourceIdentityHash: sourceValue.sourceIdentityHash,
          sourceComponentKind: 'merchandise',
          actualTransactionId: 'purged-target',
          allocatedAmount: -100,
        },
        {
          sourceIdentityHash: 'other',
          sourceComponentKind: 'merchandise',
          actualTransactionId: 'already-used',
          allocatedAmount: -1,
        },
      ],
    });

    expect(candidates).toMatchObject([
      {
        target: { id: 'already-used' },
        status: 'stale',
        reasonCodes: ['target-capacity-exhausted'],
      },
    ]);
    expect(
      candidates.some(candidate => candidate.target.id === 'new-target'),
    ).toBe(false);
  });

  it('keeps currency mismatch, reconciled targets, and distinct competing source groups review-only', () => {
    const candidates = build({
      budgetCurrencyCode: 'USD',
      sources: [
        source('usd-a', 'merchandise', -100),
        source('usd-b', 'merchandise', -100),
        { ...source('eur', 'merchandise', -100), currencyCode: 'EUR' },
      ],
      targets: [
        target('competing', -100),
        { ...target('reconciled', -100), reconciled: true },
      ],
    });

    const competing = candidates.filter(
      candidate => candidate.target.id === 'competing',
    );
    expect(competing).toHaveLength(2);
    expect(new Set(competing.map(candidate => candidate.id)).size).toBe(2);
    expect(
      candidates.find(candidate => candidate.target.id === 'reconciled'),
    ).toMatchObject({
      status: 'stale',
      reasonCodes: ['target-reconciled'],
    });
  });
});

function build(
  request: Partial<Parameters<typeof buildAmazonMatchCandidates>[0]> &
    Pick<
      Parameters<typeof buildAmazonMatchCandidates>[0],
      'sources' | 'targets'
    >,
) {
  return buildAmazonMatchCandidates({
    budgetCurrencyCode: 'USD',
    capacityUses: [],
    ...request,
  });
}

function target(id: string, amountMinorUnits: number): AmazonTarget {
  return {
    id,
    amountMinorUnits,
    date: '2026-01-02',
    reconciled: false,
    targetVersionHash: targetHash,
  };
}

function source(
  identity: string,
  sourceComponentKind: AmazonSourceComponent['sourceComponentKind'],
  amount: number,
): AmazonSourceComponent {
  return {
    amazonItemId:
      sourceComponentKind === 'refund' ||
      sourceComponentKind === 'gift_card' ||
      sourceComponentKind === 'rounding'
        ? null
        : identity,
    amazonOrderId: `order-${identity}`,
    amazonRefundId: sourceComponentKind === 'refund' ? identity : null,
    amount,
    currencyCode: 'USD',
    date: '2026-01-01',
    sourceComponentKind,
    sourceIdentityHash: identity.padEnd(64, '0'),
  };
}
