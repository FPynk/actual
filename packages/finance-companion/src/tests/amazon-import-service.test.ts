import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualAdapterRequest,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { targetVersionHash } from '#reviews/classification';
import { importAmazonUpload } from '#service/amazon-import-service';
import type { AmazonImportUpload } from '#service/amazon-import-service';

const budgetKeyHash = 'a'.repeat(64);

describe('FIN-41 Amazon import orchestration', () => {
  let temporaryDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-amazon-import-'),
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
      budgetKeyHash,
      budgetCurrencyCode: 'USD',
      createOwnerCredentialHash: async () => 'owner',
    });
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('imports JSON, discards caller bytes, reads bounded snapshots, and creates FIN-40 candidates using exact live targets', async () => {
    const fixture = await readFile(
      path.join(import.meta.dirname, 'fixtures/amazon-export-one-order.json'),
      'utf8',
    );
    const rawMarker = 'raw-only-marker-must-not-be-retained';
    const bytes = Buffer.from(
      fixture.replace(/}\s*$/, `,"privateRawMarker":"${rawMarker}"}`),
    );
    const requests: ActualAdapterRequest[] = [];
    const parent = transaction('actual-charge', -1_080, '2026-01-02');
    const graphWithoutHash = {
      contractVersion: 1 as const,
      parent,
      children: [],
    };
    const graph: ActualTransactionGraphV1 = {
      ...graphWithoutHash,
      targetVersionHash: targetVersionHash(graphWithoutHash),
    };
    const adapter = syntheticAdapter(requests, graph, [parent]);
    const upload = discardableUpload(bytes, 'amazon-export-json');

    const result = await importAmazonUpload(upload, {
      adapter,
      databasePath,
      budgetKeyHash,
      budgetCurrencyCode: 'USD',
      now: () => new Date('2026-01-10T00:00:00.000Z'),
    });

    expect(result).toMatchObject({
      status: 'completed',
      replayed: false,
      receipt: { acceptedCount: 3, rejectedCount: 0, rowCount: 3 },
      candidateCount: 1,
    });
    expect(bytes.every(byte => byte === 0)).toBe(true);
    const snapshotRequests = requests.filter(
      request => request.kind === 'read-budget-snapshot',
    );
    expect(snapshotRequests).toEqual([
      {
        kind: 'read-budget-snapshot',
        sections: [],
        transactionRange: {
          startDate: '2025-12-29',
          endDateExclusive: '2026-01-06',
        },
      },
    ]);
    expect(
      requests.filter(request => request.kind === 'read-actual-target'),
    ).toEqual([
      {
        kind: 'read-actual-target',
        target: { kind: 'transaction', id: 'actual-charge' },
      },
    ]);
    expect(
      requests.some(request => request.kind === 'run-account-bank-sync'),
    ).toBe(false);

    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM source_namespaces WHERE kind = 'amazon_profile'",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_charge_matches')
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_allocation_holds')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM amazon_applied_allocation_reservations',
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    expect((await readFile(databasePath)).includes(rawMarker)).toBe(false);
  });

  it('reuses one default profile and the canonical receipt for JSON and accepts EML through its closed parser', async () => {
    const jsonBytes = await readFile(
      path.join(import.meta.dirname, 'fixtures/amazon-export-one-order.json'),
    );
    const adapter = syntheticAdapter([], null, []);
    const first = await importAmazonUpload(
      discardableUpload(Buffer.from(jsonBytes), 'amazon-export-json'),
      dependencies(adapter),
    );
    const replay = await importAmazonUpload(
      discardableUpload(Buffer.from(jsonBytes), 'amazon-export-json'),
      dependencies(adapter),
    );
    const emailBytes = await readFile(
      path.join(import.meta.dirname, 'fixtures/amazon-order.eml'),
    );
    const email = await importAmazonUpload(
      discardableUpload(emailBytes, 'amazon-email-eml'),
      dependencies(adapter),
    );

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, status: 'completed' });
    expect(email.status).not.toBe('failed');
    expect(emailBytes.every(byte => byte === 0)).toBe(true);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM source_namespaces WHERE kind = 'amazon_profile'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('rejects an excessive source-date span before any Actual adapter call and still discards raw bytes', async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        orders: [order('OLD', '1000-01-01'), order('NEW', '9000-01-01')],
      }),
    );
    const requests: ActualAdapterRequest[] = [];
    const adapter = syntheticAdapter(requests, null, []);

    await expect(
      importAmazonUpload(
        discardableUpload(bytes, 'amazon-export-json'),
        dependencies(adapter),
      ),
    ).rejects.toThrow('source date range is too broad');
    expect(requests).toEqual([]);
    expect(bytes.every(byte => byte === 0)).toBe(true);
  });

  it('discards raw bytes when default profile setup fails', async () => {
    const bytes = Buffer.from('{"orders":[]}');
    const adapter = syntheticAdapter([], null, []);

    await expect(
      importAmazonUpload(discardableUpload(bytes, 'amazon-export-json'), {
        ...dependencies(adapter),
        databasePath: path.join(
          temporaryDirectory,
          'missing',
          'companion.sqlite',
        ),
      }),
    ).rejects.toThrow();
    expect(bytes.every(byte => byte === 0)).toBe(true);
  });

  function dependencies(adapter: ActualAdapter) {
    return {
      adapter,
      databasePath,
      budgetKeyHash,
      budgetCurrencyCode: 'USD',
      now: () => new Date('2026-01-10T00:00:00.000Z'),
    } as const;
  }
});

function discardableUpload(
  bytes: Buffer,
  mediaKind: AmazonImportUpload['mediaKind'],
): AmazonImportUpload {
  let discarded = false;
  return {
    adapterVersion: 'amazon-import/v1',
    byteHash: 'b'.repeat(64),
    mediaKind,
    bytes,
    discard: () => {
      if (discarded) return;
      discarded = true;
      bytes.fill(0);
    },
  };
}

function syntheticAdapter(
  requests: ActualAdapterRequest[],
  graph: ActualTransactionGraphV1 | null,
  transactions: readonly ActualTransactionV1[],
): ActualAdapter {
  return {
    execute: async request => {
      requests.push(request);
      if (request.kind === 'read-actual-target') {
        return {
          kind: 'read-actual-target',
          target: graph?.parent.id === request.target.id ? graph : null,
        };
      }
      if (request.kind !== 'read-budget-snapshot') {
        throw new Error('Amazon import attempted to mutate Actual.');
      }
      return {
        kind: 'read-budget-snapshot',
        snapshot: {
          contractVersion: 1,
          budget: {
            budgetKeyHash,
            currencyCode: 'USD',
            capturedAt: '2026-01-10T00:00:00.000Z',
          },
          transactions,
        },
      };
    },
    getHealth: () => 'healthy',
    getActiveOperationStatus: () => null,
  };
}

function transaction(
  id: string,
  amountMinorUnits: number,
  date: string,
): ActualTransactionV1 {
  return {
    id,
    accountId: 'card-account',
    parentId: null,
    transferId: null,
    date,
    amountMinorUnits,
    payeeId: 'amazon-payee',
    categoryId: null,
    notes: null,
    importedId: null,
    importedPayee: 'Amazon',
    cleared: true,
    reconciled: false,
    isParent: false,
    isChild: false,
    isStartingBalance: false,
    tombstone: false,
  };
}

function order(externalOrderId: string, orderDate: string) {
  return {
    marketplace: 'amazon.com',
    externalOrderId,
    orderDate,
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
