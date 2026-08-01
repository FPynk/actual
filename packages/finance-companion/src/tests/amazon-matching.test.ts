import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import {
  buildAmazonMatchCandidates,
  createSqliteAmazonMatchingRepository,
} from '#service/amazon-matching';
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

  it('never treats a refund as a charge component even when it can make an exact charge sum', () => {
    const candidates = build({
      sources: [
        source('purchase', 'merchandise', -100),
        source('discount', 'discount', 50),
        source('refund', 'refund', 50),
      ],
      targets: [target('charge', -50)],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceComponentKind: 'merchandise' }),
        expect.objectContaining({ sourceComponentKind: 'discount' }),
      ]),
    );
    expect(candidates[0]?.allocations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceComponentKind: 'refund' }),
      ]),
    );
  });

  it('uses the remaining source capacity for a partial prior reservation', () => {
    const sourceValue = source('partially-used', 'merchandise', -100);
    const candidates = build({
      sources: [sourceValue],
      targets: [target('remaining', -60), target('full', -100)],
      capacityUses: [
        {
          sourceIdentityHash: sourceValue.sourceIdentityHash,
          sourceComponentKind: 'merchandise',
          actualTransactionId: 'prior-parent',
          allocatedAmount: -40,
        },
      ],
    });

    expect(candidates).toMatchObject([
      {
        target: { id: 'remaining' },
        allocations: [{ amount: -60 }],
      },
    ]);
    expect(candidates.some(candidate => candidate.target.id === 'full')).toBe(
      false,
    );
  });

  it('returns every competing exact candidate instead of truncating the set', () => {
    const candidates = build({
      sources: Array.from({ length: 101 }, (_, index) =>
        source(`item-${index}`, 'merchandise', -1),
      ),
      targets: [target('charge', -1)],
    });

    expect(candidates).toHaveLength(101);
    expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(101);
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

  it('makes unassigned order tax and shipping explicit instead of hiding them in rounding', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-amazon-match-'),
    );
    const databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    try {
      await initializeCompanionDatabaseAndAnchor({
        databasePath,
        migrationsDirectory: path.resolve(
          import.meta.dirname,
          '../../migrations',
        ),
        anchorPath: path.join(temporaryDirectory, 'anchor.json'),
        anchorMacKey: randomBytes(32),
        budgetKeyHash: 'a'.repeat(64),
        budgetCurrencyCode: 'USD',
        createOwnerCredentialHash: async () => 'owner',
      });
      const sourceNamespaceId = createSqliteSourceIdentityRepository(
        databasePath,
      ).createSourceNamespace({
        kind: 'amazon_profile',
        namespace: 'amazon-profile/v1/11111111-1111-1111-1111-111111111111',
        displayName: 'Synthetic profile',
        createdAt: '2026-01-01T00:00:00.000Z',
      }).id;
      insertOrderWithUnassignedTaxAndShipping(databasePath, sourceNamespaceId);

      const components =
        createSqliteAmazonMatchingRepository(
          databasePath,
        ).readSourceComponents();

      expect(
        components
          .filter(component => component.amazonItemId === null)
          .map(component => [component.sourceComponentKind, component.amount]),
      ).toEqual(
        expect.arrayContaining([
          ['gift_card', 200],
          ['tax', -20],
          ['shipping', -30],
        ]),
      );
      expect(
        components.some(
          component => component.sourceComponentKind === 'rounding',
        ),
      ).toBe(false);
      expect(
        components.reduce((sum, component) => sum + component.amount, 0),
      ).toBe(-950);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
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
    sourceIdentityHash: identity.padEnd(64, 'x'),
  };
}

function insertOrderWithUnassignedTaxAndShipping(
  databasePath: string,
  sourceNamespaceId: string,
) {
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(`INSERT INTO amazon_orders
        (id, source_namespace_id, marketplace, external_order_id, order_date, currency_code,
         item_subtotal, tax_total, shipping_total, discount_total, gift_card_total, refund_total,
         order_total, first_observed_at, last_observed_at)
        VALUES (?, ?, 'amazon.com', 'order-1', '2026-01-01', 'USD',
                1000, 100, 50, 0, 200, 0, 1150,
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
      .run('11111111-1111-1111-1111-111111111111', sourceNamespaceId);
    database
      .prepare(`INSERT INTO amazon_items
        (id, amazon_order_id, amazon_shipment_id, source_item_key, external_item_id, title,
         quantity, unit_amount, tax_amount, shipping_amount, discount_amount, refund_amount)
        VALUES (?, ?, NULL, 'item/item-1', 'item-1', 'Synthetic item',
                1, 1000, 80, 20, 0, 0)`)
      .run(
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
      );
  } finally {
    database.close();
  }
}
