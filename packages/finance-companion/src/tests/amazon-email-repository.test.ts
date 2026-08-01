import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import { sha256 } from '#integrity/canonical-hash';
import { createRfc5322AmazonEmailParser } from '#service/amazon-email-parser';
import {
  AmazonExportInterruptedError,
  createJsonAmazonExportParser,
  createSqliteAmazonExportRepository,
  sha256Parts,
} from '#service/amazon-export-repository';
import type {
  AmazonExportRecord,
  AmazonItemRecord,
  AmazonOrderRecord,
} from '#service/amazon-export-repository';

describe('FIN-39 Amazon RFC5322 email normalization', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let sourceNamespaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-amazon-email-'),
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
      namespace: 'amazon-profile/v1/22222222-2222-2222-2222-222222222222',
      displayName: 'Synthetic email profile',
      createdAt: '2026-01-01T00:00:00.000Z',
    }).id;
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('parses confirmation, multipart shipment, and refund fixtures with exact redacted positions', async () => {
    const repository = createSqliteAmazonExportRepository(databasePath);
    const order = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: await fixture('amazon-order.eml'),
      parser: createRfc5322AmazonEmailParser(),
    });
    const shipmentBytes = await fixture('amazon-shipment.eml');
    const shipment = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: shipmentBytes,
      parser: createRfc5322AmazonEmailParser(),
    });
    const refund = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: await fixture('amazon-refund.eml'),
      parser: createRfc5322AmazonEmailParser(),
    });

    expect(order).toMatchObject({
      result: 'completed',
      receipt: { rowCount: 2, acceptedCount: 2, rejectedCount: 0 },
    });
    expect(shipment).toMatchObject({
      result: 'completed',
      receipt: { rowCount: 3, acceptedCount: 3, rejectedCount: 0 },
    });
    expect(refund).toMatchObject({
      result: 'completed',
      receipt: { rowCount: 1, acceptedCount: 1, rejectedCount: 0 },
    });
    expect(entityCounts()).toEqual({
      orders: 2,
      shipments: 1,
      items: 2,
      refunds: 1,
      observations: 6,
    });
    const shipmentHash = sha256Parts([
      '<synthetic-shipment-1@example.invalid>',
    ]);
    expect(observationKeys(shipment.receipt.id)).toEqual([
      `eml/${shipmentHash}/item/1.4`,
      `eml/${shipmentHash}/order/1.2`,
      `eml/${shipmentHash}/shipment/1.3`,
    ]);
    expect(
      repository.parseAmazonEmail({
        sourceNamespaceId,
        bytes: shipmentBytes,
        parser: createRfc5322AmazonEmailParser(),
      }),
    ).toMatchObject({
      replayed: true,
      receipt: { id: shipment.receipt.id },
    });
  });

  it('uses the content hash when Message-ID is absent without retaining private email material', async () => {
    const original = await fixture('amazon-order.eml');
    const bytes = Buffer.from(
      original
        .toString('utf8')
        .replace('Message-ID: <synthetic-order-1@example.invalid>\n', '')
        .replaceAll('ORDER-EMAIL-1', 'ORDER-NO-MESSAGE-ID'),
    );
    const expectedMessageHash = sha256Parts([sha256(bytes)]);
    const result = createSqliteAmazonExportRepository(
      databasePath,
    ).parseAmazonEmail({
      sourceNamespaceId,
      bytes,
      parser: createRfc5322AmazonEmailParser(),
    });

    expect(observationKeys(result.receipt.id)).toEqual([
      `eml/${expectedMessageHash}/item/1.3`,
      `eml/${expectedMessageHash}/order/1.2`,
    ]);
    const persistedText = databaseText();
    expect(persistedText).not.toContain('synthetic-order-1@example.invalid');
    expect(persistedText).not.toContain('orders@example.invalid');
    expect(persistedText).not.toContain('user@example.invalid');
    expect(persistedText).not.toContain('This message contains');
    expect(persistedText).not.toContain('amazon-order.eml');
  });

  it('converges export and email identities, then adds observations only on a versioned reparse', async () => {
    const exportBytes = await fixture('amazon-export-one-order.json');
    const emailBytes = await fixture('amazon-shipment.eml');
    const repository = createSqliteAmazonExportRepository(databasePath);
    repository.parseAmazonExport({
      sourceNamespaceId,
      bytes: exportBytes,
      parser: createJsonAmazonExportParser(),
    });
    const email = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: emailBytes,
      parser: createRfc5322AmazonEmailParser(1),
    });

    expect(email).toMatchObject({
      result: 'completed',
      receipt: { acceptedCount: 3, rejectedCount: 0 },
    });
    expect(entityCounts()).toEqual({
      orders: 1,
      shipments: 1,
      items: 1,
      refunds: 0,
      observations: 6,
    });
    expect(
      repository.parseAmazonEmail({
        sourceNamespaceId,
        bytes: emailBytes,
        parser: createRfc5322AmazonEmailParser(2),
      }),
    ).toMatchObject({ replayed: false, result: 'completed' });
    expect(entityCounts().observations).toBe(9);
  });

  it('assigns fallback occurrences by visible position and reports ambiguous keyless identity', async () => {
    const duplicateItem = syntheticItem({
      externalItemId: null,
      externalOrderId: 'ORDER-DUPLICATE-EMAIL',
      title: 'Synthetic duplicate item',
    });
    const duplicateMessage = syntheticEmail('confirmation', [
      syntheticOrder('ORDER-DUPLICATE-EMAIL'),
      duplicateItem,
      duplicateItem,
    ]);
    createSqliteAmazonExportRepository(databasePath).parseAmazonEmail({
      sourceNamespaceId,
      bytes: duplicateMessage,
      parser: createRfc5322AmazonEmailParser(),
    });
    expect(canonicalItemKeys()).toEqual([
      expect.stringMatching(/\/1$/),
      expect.stringMatching(/\/2$/),
    ]);

    const exportBytes = await fixture('amazon-export-convergence.json');
    const repository = createSqliteAmazonExportRepository(databasePath);
    repository.parseAmazonExport({
      sourceNamespaceId,
      bytes: exportBytes,
      parser: createJsonAmazonExportParser(),
    });
    repository.parseAmazonExport({
      sourceNamespaceId,
      bytes: Buffer.from(
        exportBytes
          .toString('utf8')
          .replaceAll('ITEM-CONVERGE', 'ITEM-CONVERGE-2'),
      ),
      parser: createJsonAmazonExportParser(),
    });
    const ambiguous = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: syntheticEmail('confirmation', [
        syntheticConvergenceOrder(),
        syntheticItem({
          externalItemId: null,
          externalOrderId: 'ORDER-CONVERGE',
          shipmentKey: 'shipment/SHIP-CONVERGE',
          asin: 'ASIN-CONVERGE',
          seller: 'Synthetic seller',
          title: 'Synthetic converging item',
          unitAmount: 1500,
          taxAmount: 120,
          refundAmount: 500,
        }),
      ]),
      parser: createRfc5322AmazonEmailParser(),
    });
    expect(ambiguous).toMatchObject({
      result: 'completed-with-conflicts',
      conflictReason: 'ambiguous_identity',
      receipt: {
        acceptedCount: 1,
        rejectedCount: 1,
        errorCode: 'ambiguous_identity',
      },
    });
  });

  it('rejects conflicting, malformed, and unsupported email input before canonical writes', async () => {
    const repository = createSqliteAmazonExportRepository(databasePath);
    const exportBytes = await fixture('amazon-export-one-order.json');
    repository.parseAmazonExport({
      sourceNamespaceId,
      bytes: exportBytes,
      parser: createJsonAmazonExportParser(),
    });
    const changedShipment = Buffer.from(
      (await fixture('amazon-shipment.eml'))
        .toString('utf8')
        .replace('"shipmentTotal":1080', '"shipmentTotal":1079'),
    );
    expect(
      repository.parseAmazonEmail({
        sourceNamespaceId,
        bytes: changedShipment,
        parser: createRfc5322AmazonEmailParser(),
      }),
    ).toMatchObject({
      result: 'completed-with-conflicts',
      conflictReason: 'conflicting_observation',
      receipt: { acceptedCount: 2, rejectedCount: 1 },
    });

    const malformedLateRecord = syntheticEmail('confirmation', [
      syntheticOrder('ORDER-MALFORMED-EMAIL'),
      { ...syntheticItem(), unitAmount: 1.5 } as AmazonItemRecord,
    ]);
    const malformedResult = repository.parseAmazonEmail({
      sourceNamespaceId,
      bytes: malformedLateRecord,
      parser: createRfc5322AmazonEmailParser(),
    });
    expect(malformedResult).toMatchObject({
      result: 'failed',
      receipt: { status: 'failed', rowCount: 0, errorCode: 'parser_failed' },
    });
    expect(findOrder('ORDER-MALFORMED-EMAIL')).toBeUndefined();

    for (const invalid of [
      syntheticEmail('confirmation', [syntheticOrder()], {
        contentType: 'text/plain; charset=windows-1252',
      }),
      Buffer.from(
        syntheticEmail('confirmation', [syntheticOrder()])
          .toString('utf8')
          .replace(
            'Content-Transfer-Encoding: 7bit',
            'Content-Transfer-Encoding: base64',
          ),
      ),
      Buffer.from(
        syntheticEmail('confirmation', [syntheticOrder()])
          .toString('utf8')
          .replace(
            'Subject: Synthetic fixture',
            'Message-ID: <duplicate@example.invalid>',
          ),
      ),
    ]) {
      expect(
        repository.parseAmazonEmail({
          sourceNamespaceId,
          bytes: invalid,
          parser: createRfc5322AmazonEmailParser(),
        }),
      ).toMatchObject({ result: 'failed', receipt: { status: 'failed' } });
    }
  });

  it('recovers receipt-only and transaction crashes and replays a committed result', async () => {
    const bytes = await fixture('amazon-shipment.eml');
    const request = {
      sourceNamespaceId,
      bytes,
      parser: createRfc5322AmazonEmailParser(),
    };
    expect(() =>
      createSqliteAmazonExportRepository(databasePath, undefined, {
        afterReceiptPersisted: () => {
          throw new AmazonExportInterruptedError();
        },
      }).parseAmazonEmail(request),
    ).toThrow(AmazonExportInterruptedError);
    expect(entityCounts().orders).toBe(0);

    expect(() =>
      createSqliteAmazonExportRepository(databasePath, undefined, {
        duringNormalization: () => {
          throw new AmazonExportInterruptedError();
        },
      }).parseAmazonEmail(request),
    ).toThrow(AmazonExportInterruptedError);
    expect(entityCounts().orders).toBe(0);

    expect(() =>
      createSqliteAmazonExportRepository(databasePath, undefined, {
        afterNormalizationCommitted: () => {
          throw new AmazonExportInterruptedError();
        },
      }).parseAmazonEmail(request),
    ).toThrow(AmazonExportInterruptedError);
    expect(entityCounts()).toEqual({
      orders: 1,
      shipments: 1,
      items: 1,
      refunds: 0,
      observations: 3,
    });
    expect(
      createSqliteAmazonExportRepository(databasePath).parseAmazonEmail(
        request,
      ),
    ).toMatchObject({ replayed: true, receipt: { status: 'parsed' } });
  });

  async function fixture(name: string): Promise<Buffer> {
    return readFile(path.join(import.meta.dirname, 'fixtures', name));
  }

  function entityCounts() {
    return withDatabase(database => ({
      orders: count(database, 'amazon_orders'),
      shipments: count(database, 'amazon_shipments'),
      items: count(database, 'amazon_items'),
      refunds: count(database, 'amazon_refunds'),
      observations: count(database, 'amazon_source_observations'),
    }));
  }

  function observationKeys(receiptId: string): readonly string[] {
    return withDatabase(database =>
      database
        .prepare(
          'SELECT source_row_key FROM amazon_source_observations WHERE import_batch_id = ? ORDER BY source_row_key',
        )
        .all(receiptId)
        .map(row => (row as { source_row_key: string }).source_row_key),
    );
  }

  function canonicalItemKeys(): readonly string[] {
    return withDatabase(database =>
      database
        .prepare(
          "SELECT source_item_key FROM amazon_items WHERE source_item_key LIKE 'item-fallback/%' ORDER BY source_item_key",
        )
        .all()
        .map(row => (row as { source_item_key: string }).source_item_key),
    );
  }

  function findOrder(externalOrderId: string): unknown {
    return withDatabase(database =>
      database
        .prepare('SELECT id FROM amazon_orders WHERE external_order_id = ?')
        .get(externalOrderId),
    );
  }

  function databaseText(): string {
    return withDatabase(database =>
      JSON.stringify({
        batches: database.prepare('SELECT * FROM import_batches').all(),
        orders: database.prepare('SELECT * FROM amazon_orders').all(),
        shipments: database.prepare('SELECT * FROM amazon_shipments').all(),
        items: database.prepare('SELECT * FROM amazon_items').all(),
        refunds: database.prepare('SELECT * FROM amazon_refunds').all(),
        observations: database
          .prepare('SELECT * FROM amazon_source_observations')
          .all(),
      }),
    );
  }

  function withDatabase<Result>(
    operation: (database: ReturnType<typeof openCompanionDatabase>) => Result,
  ): Result {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }
});

function syntheticEmail(
  type: 'confirmation' | 'shipment' | 'refund',
  records: readonly (AmazonExportRecord | Record<string, unknown>)[],
  options: Readonly<{ contentType?: string }> = {},
): Buffer {
  return Buffer.from(
    [
      'From: Synthetic Sender <sender@example.invalid>',
      'To: Synthetic User <user@example.invalid>',
      'Message-ID: <synthetic-generated@example.invalid>',
      'Subject: Synthetic fixture',
      'MIME-Version: 1.0',
      'X-Actual-Amazon-Adapter: v1',
      `X-Actual-Amazon-Type: ${type}`,
      `Content-Type: ${options.contentType ?? 'text/plain; charset=utf-8'}`,
      'Content-Transfer-Encoding: 7bit',
      '',
      'Synthetic fixture body.',
      ...records.map(
        record =>
          `Actual-Amazon-Record-V1: ${JSON.stringify(stripSourcePosition(record))}`,
      ),
    ].join('\r\n'),
    'utf8',
  );
}

function stripSourcePosition(
  record: AmazonExportRecord | Record<string, unknown>,
): Record<string, unknown> {
  const {
    sectionName: _sectionName,
    recordNumber: _recordNumber,
    sourceRowKey: _sourceRowKey,
    ...value
  } = record;
  return value;
}

function syntheticOrder(
  externalOrderId = 'ORDER-SYNTHETIC',
): AmazonOrderRecord {
  return {
    kind: 'order',
    sectionName: 'orders',
    recordNumber: 1,
    marketplace: 'amazon.com',
    externalOrderId,
    orderDate: '2026-03-01',
    currencyCode: 'USD',
    itemSubtotal: 1000,
    taxTotal: 80,
    shippingTotal: 0,
    discountTotal: 0,
    giftCardTotal: 0,
    refundTotal: 0,
    orderTotal: 1080,
  };
}

function syntheticConvergenceOrder(): AmazonOrderRecord {
  return {
    ...syntheticOrder('ORDER-CONVERGE'),
    orderDate: '2026-02-01',
    itemSubtotal: 1500,
    taxTotal: 120,
    refundTotal: 500,
    orderTotal: 1620,
  };
}

function syntheticItem(
  overrides: Partial<AmazonItemRecord> = {},
): AmazonItemRecord {
  return {
    kind: 'item',
    sectionName: 'items',
    recordNumber: 1,
    marketplace: 'amazon.com',
    externalOrderId: 'ORDER-SYNTHETIC',
    shipmentKey: null,
    externalItemId: 'ITEM-SYNTHETIC',
    asin: 'ASIN-SYNTHETIC',
    sku: null,
    seller: 'Synthetic seller',
    title: 'Synthetic item',
    quantity: 1,
    unitAmount: 1000,
    taxAmount: 80,
    shippingAmount: 0,
    discountAmount: 0,
    refundAmount: 0,
    currencyCode: 'USD',
    ...overrides,
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
