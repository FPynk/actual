import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import {
  AmazonExportInterruptedError,
  createJsonAmazonExportParser,
  createSqliteAmazonExportRepository,
  sha256Parts,
} from '#service/amazon-export-repository';
import type {
  AmazonExportParser,
  AmazonOrderRecord,
} from '#service/amazon-export-repository';

describe('FIN-38 Amazon export normalization', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let sourceNamespaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-amazon-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
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
    sourceNamespaceId = createSqliteSourceIdentityRepository(
      databasePath,
    ).createSourceNamespace({
      kind: 'amazon_profile',
      namespace: 'amazon-profile/v1/11111111-1111-1111-1111-111111111111',
      displayName: 'Synthetic profile',
      createdAt: '2026-01-01T00:00:00.000Z',
    }).id;
  });
  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('normalizes one order and replays exact input without retaining it', async () => {
    const bytes = await fixture('amazon-export-one-order.json');
    const repository = createSqliteAmazonExportRepository(databasePath);
    const first = repository.parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(),
    });
    const replay = repository.parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(),
    });
    expect(first).toMatchObject({
      replayed: false,
      receipt: { status: 'parsed', rowCount: 3, acceptedCount: 3 },
    });
    expect(replay).toMatchObject({
      replayed: true,
      receipt: { id: first.receipt.id },
    });
    expect(counts()).toEqual({
      orders: 1,
      shipments: 1,
      items: 1,
      observations: 3,
    });
  });

  it('uses deterministic occurrence suffixes for duplicate fallback lines and does not duplicate canonical children on reparse', async () => {
    const bytes = await fixture('amazon-export-duplicate-fallback-lines.json');
    const first = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(1),
    });
    const reparsed = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(2),
    });
    expect(first.replayed).toBe(false);
    expect(reparsed.replayed).toBe(false);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT source_item_key FROM amazon_items ORDER BY source_item_key',
          )
          .all(),
      ).toEqual([
        { source_item_key: expect.stringMatching(/\/1$/) },
        { source_item_key: expect.stringMatching(/\/2$/) },
      ]);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_source_observations')
          .get(),
      ).toEqual({ count: 6 });
    } finally {
      database.close();
    }
  });

  it('rolls normalization back and resumes a parsing receipt after interruptions', async () => {
    const bytes = await fixture('amazon-export-two-shipments.json');
    const interruptedAfterReceipt = createSqliteAmazonExportRepository(
      databasePath,
      undefined,
      {
        afterReceiptPersisted: () => {
          throw new AmazonExportInterruptedError();
        },
      },
    );
    expect(() =>
      interruptedAfterReceipt.parseAmazonExport({
        sourceNamespaceId,
        bytes,
        parser: createJsonAmazonExportParser(),
      }),
    ).toThrow(AmazonExportInterruptedError);
    expect(counts()).toEqual({
      orders: 0,
      shipments: 0,
      items: 0,
      observations: 0,
    });
    createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(),
    });
    const duringBytes = Buffer.from(
      (await fixture('amazon-export-one-order.json'))
        .toString('utf8')
        .replaceAll('ORDER-1', 'ORDER-DURING'),
    );
    const interrupted = createSqliteAmazonExportRepository(
      databasePath,
      undefined,
      {
        duringNormalization: () => {
          throw new AmazonExportInterruptedError();
        },
      },
    );
    expect(() =>
      interrupted.parseAmazonExport({
        sourceNamespaceId,
        bytes: duringBytes,
        parser: createJsonAmazonExportParser(),
      }),
    ).toThrow(AmazonExportInterruptedError);
    expect(counts()).toEqual({
      orders: 1,
      shipments: 2,
      items: 0,
      observations: 3,
    });
    const resumed = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes: duringBytes,
      parser: createJsonAmazonExportParser(),
    });
    expect(resumed).toMatchObject({
      replayed: false,
      receipt: { status: 'parsed', acceptedCount: 3 },
    });
  });

  it('reports immutable conflicts, rejects malformed money, and replays work committed before a response interruption', async () => {
    const first = await fixture('amazon-export-one-order.json');
    createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
      sourceNamespaceId,
      bytes: first,
      parser: createJsonAmazonExportParser(),
    });
    const conflict = Buffer.from(
      first
        .toString('utf8')
        .replace('"orderTotal": 1080', '"orderTotal": 1081'),
    );
    const conflictResult = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes: conflict,
      parser: createJsonAmazonExportParser(),
    });
    expect(conflictResult.receipt).toMatchObject({
      status: 'parsed',
      acceptedCount: 2,
      rejectedCount: 1,
      errorCode: 'conflicting_observation',
    });
    expect(conflictResult).toMatchObject({
      result: 'completed-with-conflicts',
      conflictReason: 'conflicting_observation',
    });
    expect(
      createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
        sourceNamespaceId,
        bytes: conflict,
        parser: createJsonAmazonExportParser(),
      }),
    ).toMatchObject({
      replayed: true,
      result: 'completed-with-conflicts',
      conflictReason: 'conflicting_observation',
    });
    const malformed = Buffer.from(
      first
        .toString('utf8')
        .replace('"unitAmount": 1000', '"unitAmount": 10.5'),
    );
    expect(
      createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
        sourceNamespaceId,
        bytes: malformed,
        parser: createJsonAmazonExportParser(),
      }).receipt,
    ).toMatchObject({ status: 'failed', errorCode: 'parser_failed' });
    const committed = await fixture('amazon-export-two-shipments.json');
    const interrupted = createSqliteAmazonExportRepository(
      databasePath,
      undefined,
      {
        afterNormalizationCommitted: () => {
          throw new AmazonExportInterruptedError();
        },
      },
    );
    expect(() =>
      interrupted.parseAmazonExport({
        sourceNamespaceId,
        bytes: committed,
        parser: createJsonAmazonExportParser(),
      }),
    ).toThrow(AmazonExportInterruptedError);
    expect(
      createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
        sourceNamespaceId,
        bytes: committed,
        parser: createJsonAmazonExportParser(),
      }),
    ).toMatchObject({ replayed: true, receipt: { status: 'parsed' } });
  });

  it('converges unique compatible keyless children onto external-ID entities', async () => {
    const externalBytes = await fixture('amazon-export-convergence.json');
    createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
      sourceNamespaceId,
      bytes: externalBytes,
      parser: createJsonAmazonExportParser(),
    });
    const shipmentFallbackKey = `shipment-fallback/${sha256Parts([
      'order/amazon.com/ORDER-CONVERGE',
      '2026-02-02',
      1620,
      'ASIN-CONVERGE',
    ])}/1`;
    const itemFallbackKey = `item-fallback/${sha256Parts([
      'order/amazon.com/ORDER-CONVERGE',
      shipmentFallbackKey,
      'ASIN-CONVERGE',
      'Synthetic seller',
      'Synthetic converging item',
      1,
      1500,
      120,
      0,
      0,
      'USD',
    ])}/1`;
    const keylessBytes = Buffer.from(
      externalBytes
        .toString('utf8')
        .replace(
          '"externalShipmentId": "SHIP-CONVERGE"',
          '"externalShipmentId": null',
        )
        .replace('"externalItemId": "ITEM-CONVERGE"', '"externalItemId": null')
        .replace(
          '"shipmentKey": "shipment/SHIP-CONVERGE"',
          `"shipmentKey": "${shipmentFallbackKey}"`,
        )
        .replace(
          '"externalRefundId": "REFUND-CONVERGE"',
          '"externalRefundId": null',
        )
        .replace(
          '"itemKey": "item/ITEM-CONVERGE"',
          `"itemKey": "${itemFallbackKey}"`,
        ),
    );
    const result = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes: keylessBytes,
      parser: createJsonAmazonExportParser(),
    });

    expect(result).toMatchObject({
      result: 'completed',
      conflictReason: null,
      receipt: { acceptedCount: 4, rejectedCount: 0, errorCode: null },
    });
    expect(entityCounts()).toEqual({ shipments: 1, items: 1, refunds: 1 });
    expect(countObservations()).toBe(8);
  });

  it.each([
    [
      'shipment signatures',
      '"orderedItemSignatures": ["ASIN-CONVERGE"]',
      '"orderedItemSignatures": ["ASIN-CHANGED"]',
    ],
    ['item ASIN', '"asin": "ASIN-CONVERGE"', '"asin": "ASIN-CHANGED"'],
    ['item SKU', '"sku": null', '"sku": "SKU-CHANGED"'],
    [
      'item seller',
      '"seller": "Synthetic seller"',
      '"seller": "Changed seller"',
    ],
    [
      'refund reason',
      '"reason": "Synthetic return"',
      '"reason": "Changed reason"',
    ],
  ])(
    'treats changed %s as a conflicting observation without persisting it',
    async (_label, before, after) => {
      const original = await fixture('amazon-export-convergence.json');
      createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
        sourceNamespaceId,
        bytes: original,
        parser: createJsonAmazonExportParser(),
      });
      const changed = Buffer.from(
        original.toString('utf8').replace(before, after),
      );

      const result = createSqliteAmazonExportRepository(
        databasePath,
      ).parseAmazonExport({
        sourceNamespaceId,
        bytes: changed,
        parser: createJsonAmazonExportParser(),
      });

      expect(result).toMatchObject({
        result: 'completed-with-conflicts',
        conflictReason: 'conflicting_observation',
        receipt: {
          acceptedCount: 3,
          rejectedCount: 1,
          errorCode: 'conflicting_observation',
        },
      });
      expect(countObservations()).toBe(7);
    },
  );

  it('trims and collapses every ASCII whitespace character during normalization', async () => {
    const original = await fixture('amazon-export-convergence.json');
    const whitespace = '\\t\\n\\u000b\\f\\r ';
    const bytes = Buffer.from(
      original
        .toString('utf8')
        .replaceAll(
          '"externalOrderId": "ORDER-CONVERGE"',
          `"externalOrderId": "${whitespace}ORDER-WHITESPACE${whitespace}"`,
        )
        .replace(
          '"externalShipmentId": "SHIP-CONVERGE"',
          `"externalShipmentId": "${whitespace}SHIP-WHITESPACE${whitespace}"`,
        )
        .replace(
          '"shipmentKey": "shipment/SHIP-CONVERGE"',
          `"shipmentKey": "${whitespace}shipment/SHIP-WHITESPACE${whitespace}"`,
        )
        .replace(
          '"externalItemId": "ITEM-CONVERGE"',
          `"externalItemId": "${whitespace}ITEM-WHITESPACE${whitespace}"`,
        )
        .replace(
          '"itemKey": "item/ITEM-CONVERGE"',
          `"itemKey": "${whitespace}item/ITEM-WHITESPACE${whitespace}"`,
        )
        .replace(
          '"externalRefundId": "REFUND-CONVERGE"',
          `"externalRefundId": "${whitespace}REFUND-WHITESPACE${whitespace}"`,
        )
        .replace(
          'Synthetic converging item',
          'Synthetic\\t\\n\\u000b\\f\\r item',
        ),
    );

    const result = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes,
      parser: createJsonAmazonExportParser(),
    });

    expect(result.result).toBe('completed');
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT external_order_id FROM amazon_orders WHERE source_namespace_id = ?',
          )
          .get(sourceNamespaceId),
      ).toEqual({ external_order_id: 'ORDER-WHITESPACE' });
      expect(
        database
          .prepare('SELECT external_shipment_id FROM amazon_shipments')
          .get(),
      ).toEqual({ external_shipment_id: 'SHIP-WHITESPACE' });
      expect(
        database
          .prepare('SELECT external_item_id, title FROM amazon_items')
          .get(),
      ).toEqual({
        external_item_id: 'ITEM-WHITESPACE',
        title: 'Synthetic item',
      });
      expect(
        database.prepare('SELECT external_refund_id FROM amazon_refunds').get(),
      ).toEqual({ external_refund_id: 'REFUND-WHITESPACE' });
    } finally {
      database.close();
    }
  });

  it('rejects noncanonical 36-character UUIDs in the fresh Amazon schema', () => {
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(() =>
        database
          .prepare(
            'INSERT INTO amazon_orders (id, source_namespace_id, marketplace, external_order_id, order_date, currency_code, item_subtotal, tax_total, shipping_total, discount_total, gift_card_total, refund_total, order_total, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            '-'.repeat(36),
            sourceNamespaceId,
            'amazon.com',
            'ORDER-BAD-UUID',
            '2026-04-01',
            'USD',
            100,
            0,
            0,
            0,
            0,
            0,
            100,
            '2026-04-01T00:00:00.000Z',
            '2026-04-01T00:00:00.000Z',
          ),
      ).toThrow();
      expect(count(database, 'amazon_orders')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('fails closed with ambiguous_identity when two external entities are structurally compatible', async () => {
    const firstExternal = await fixture('amazon-export-convergence.json');
    createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
      sourceNamespaceId,
      bytes: firstExternal,
      parser: createJsonAmazonExportParser(),
    });
    const secondExternal = Buffer.from(
      firstExternal
        .toString('utf8')
        .replaceAll('ITEM-CONVERGE', 'ITEM-CONVERGE-2'),
    );
    createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
      sourceNamespaceId,
      bytes: secondExternal,
      parser: createJsonAmazonExportParser(),
    });
    const keyless = Buffer.from(
      firstExternal
        .toString('utf8')
        .replace('"externalItemId": "ITEM-CONVERGE"', '"externalItemId": null'),
    );
    const result = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes: keyless,
      parser: createJsonAmazonExportParser(),
    });

    expect(result).toMatchObject({
      result: 'completed-with-conflicts',
      conflictReason: 'ambiguous_identity',
      receipt: {
        acceptedCount: 3,
        rejectedCount: 1,
        errorCode: 'ambiguous_identity',
      },
    });
    expect(entityCounts().items).toBe(2);
    expect(
      createSqliteAmazonExportRepository(databasePath).parseAmazonExport({
        sourceNamespaceId,
        bytes: keyless,
        parser: createJsonAmazonExportParser(),
      }),
    ).toMatchObject({
      replayed: true,
      result: 'completed-with-conflicts',
      conflictReason: 'ambiguous_identity',
    });
  });

  it('validates every custom-parser DTO before writes and rolls back a corrupt late row', () => {
    const valid = createSyntheticOrder('ORDER-VALID');
    const corrupt = createSyntheticOrder('ORDER-CORRUPT');
    Object.defineProperty(corrupt, 'orderTotal', { value: 'corrupt' });
    const parser: AmazonExportParser = {
      name: 'synthetic-corrupt-parser',
      version: 1,
      parse: () => [valid, corrupt],
    };

    const result = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonExport({
      sourceNamespaceId,
      bytes: Buffer.from('synthetic corrupt late row'),
      parser,
    });

    expect(result).toMatchObject({
      result: 'failed',
      conflictReason: null,
      receipt: {
        status: 'failed',
        rowCount: 0,
        errorCode: 'parser_failed',
      },
    });
    expect(counts()).toEqual({
      orders: 0,
      shipments: 0,
      items: 0,
      observations: 0,
    });
  });

  async function fixture(name: string) {
    return readFile(path.join(import.meta.dirname, 'fixtures', name));
  }
  function counts() {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return {
        orders: count(database, 'amazon_orders'),
        shipments: count(database, 'amazon_shipments'),
        items: count(database, 'amazon_items'),
        observations: count(database, 'amazon_source_observations'),
      };
    } finally {
      database.close();
    }
  }
  function entityCounts() {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return {
        shipments: count(database, 'amazon_shipments'),
        items: count(database, 'amazon_items'),
        refunds: count(database, 'amazon_refunds'),
      };
    } finally {
      database.close();
    }
  }
  function countObservations() {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return count(database, 'amazon_source_observations');
    } finally {
      database.close();
    }
  }
});

function createSyntheticOrder(externalOrderId: string): AmazonOrderRecord {
  return {
    kind: 'order',
    sectionName: 'orders',
    recordNumber: externalOrderId === 'ORDER-VALID' ? 1 : 2,
    marketplace: 'amazon.com',
    externalOrderId,
    orderDate: '2026-03-01',
    currencyCode: 'USD',
    itemSubtotal: 100,
    taxTotal: 0,
    shippingTotal: 0,
    discountTotal: 0,
    giftCardTotal: 0,
    refundTotal: 0,
    orderTotal: 100,
  };
}

function count(
  database: ReturnType<typeof openCompanionDatabase>,
  table: string,
): number {
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}
