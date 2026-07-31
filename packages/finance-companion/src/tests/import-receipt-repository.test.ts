import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import {
  createSqliteImportReceiptRepository,
  ImportReceiptInterruptedError,
} from '#service/import-receipt-repository';
import type {
  ParsedStatementImportRow,
  StatementImportParser,
} from '#service/import-receipt-repository';

describe('FIN-19 import receipt parsing and replay', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let sourceNamespaceId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-import-receipts-'),
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
      createOwnerCredentialHash: async () => 'test-owner-hash',
    });
    sourceNamespaceId = createSqliteSourceIdentityRepository(
      databasePath,
    ).createSourceNamespace({
      kind: 'statement',
      namespace: 'synthetic-bank',
      displayName: 'Synthetic bank',
      createdAt: '2026-01-01T00:00:00.000Z',
    }).id;
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates one receipt for identical bytes and parser version without retaining input bytes', () => {
    let parseCount = 0;
    const parser = createSyntheticParser(1, () => {
      parseCount += 1;
      return [createRow('first'), createRow('second')];
    });
    const repository = createSqliteImportReceiptRepository(databasePath);
    const bytes = Buffer.from('synthetic receipt body that must not persist');

    const first = repository.parseStatementImport(createRequest(bytes, parser));
    const replay = repository.parseStatementImport(
      createRequest(bytes, parser),
    );

    expect(first).toMatchObject({
      replayed: false,
      receipt: {
        status: 'parsed',
        rowCount: 2,
        acceptedCount: 2,
        rejectedCount: 0,
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      receipt: { id: first.receipt.id },
    });
    expect(parseCount).toBe(1);
    expect(readCounts()).toEqual({
      receipts: 1,
      transactions: 2,
      observations: 2,
    });
    expect(databaseText()).not.toContain(bytes.toString('utf8'));
  });

  it('reparses a new parser version without duplicating canonical source rows', () => {
    const bytes = Buffer.from('same synthetic export');
    const first = createSqliteImportReceiptRepository(
      databasePath,
    ).parseStatementImport(
      createRequest(
        bytes,
        createSyntheticParser(1, () => [createRow('provider-1')]),
      ),
    );
    const reparsed = createSqliteImportReceiptRepository(
      databasePath,
    ).parseStatementImport(
      createRequest(
        bytes,
        createSyntheticParser(2, () => [createRow('provider-1')]),
      ),
    );

    expect(reparsed.receipt).toMatchObject({
      status: 'parsed',
      acceptedCount: 1,
    });
    expect(reparsed.receipt.id).not.toBe(first.receipt.id);
    expect(readCounts()).toEqual({
      receipts: 2,
      transactions: 1,
      observations: 2,
    });
  });

  it('records conflicts deterministically and fails currency mismatches without children', () => {
    const repository = createSqliteImportReceiptRepository(databasePath);
    repository.parseStatementImport(
      createRequest(
        Buffer.from('first'),
        createSyntheticParser(1, () => [createRow('provider-1')]),
      ),
    );
    const conflict = repository.parseStatementImport(
      createRequest(
        Buffer.from('second'),
        createSyntheticParser(1, () => [
          createRow('provider-1', { amount: 99 }),
        ]),
      ),
    );
    const mismatch = repository.parseStatementImport(
      createRequest(
        Buffer.from('mismatch'),
        createSyntheticParser(1, () => [
          createRow('provider-2', { currencyCode: 'EUR' }),
        ]),
      ),
    );

    expect(conflict.receipt).toMatchObject({
      status: 'parsed',
      rowCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
    });
    expect(mismatch.receipt).toMatchObject({
      status: 'failed',
      errorCode: 'currency_mismatch',
      rowCount: 0,
    });
    expect(readCounts()).toEqual({
      receipts: 3,
      transactions: 1,
      observations: 2,
    });
  });

  it('keeps parser failures redacted and stable on replay', () => {
    const bytes = Buffer.from('secret parser input');
    const repository = createSqliteImportReceiptRepository(databasePath);
    const failed = repository.parseStatementImport(
      createRequest(
        bytes,
        createSyntheticParser(1, () => {
          throw new Error('secret parser input and local path');
        }),
      ),
    );
    const replay = repository.parseStatementImport(
      createRequest(
        bytes,
        createSyntheticParser(1, () => [createRow('ignored')]),
      ),
    );

    expect(failed).toMatchObject({
      replayed: false,
      receipt: { status: 'failed', errorCode: 'parser_failed' },
    });
    expect(replay).toMatchObject({
      replayed: true,
      receipt: { id: failed.receipt.id, errorCode: 'parser_failed' },
    });
    expect(readCounts()).toEqual({
      receipts: 1,
      transactions: 0,
      observations: 0,
    });
    expect(databaseText()).not.toContain('secret parser input');
    expect(databaseText()).not.toContain('local path');
  });

  it('resumes after interruption before normalization with no normalized children', () => {
    const bytes = Buffer.from('resume-after-receipt');
    const parser = createSyntheticParser(1, () => [createRow('provider-1')]);
    const interrupted = createSqliteImportReceiptRepository(
      databasePath,
      undefined,
      { afterReceiptPersisted: interrupt },
    );

    expect(() =>
      interrupted.parseStatementImport(createRequest(bytes, parser)),
    ).toThrow(ImportReceiptInterruptedError);
    expect(readCounts()).toEqual({
      receipts: 1,
      transactions: 0,
      observations: 0,
    });
    const resumed = createSqliteImportReceiptRepository(
      databasePath,
    ).parseStatementImport(createRequest(bytes, parser));
    expect(resumed).toMatchObject({
      replayed: false,
      receipt: { status: 'parsed' },
    });
  });

  it('rolls normalization back on interruption and replays committed work after response interruption', () => {
    const rollbackBytes = Buffer.from('rollback-during-normalization');
    const parser = createSyntheticParser(1, () => [
      createRow('provider-1'),
      createRow('provider-2'),
    ]);
    const interruptedDuringNormalization = createSqliteImportReceiptRepository(
      databasePath,
      undefined,
      { duringNormalization: interrupt },
    );

    expect(() =>
      interruptedDuringNormalization.parseStatementImport(
        createRequest(rollbackBytes, parser),
      ),
    ).toThrow(ImportReceiptInterruptedError);
    expect(readCounts()).toEqual({
      receipts: 1,
      transactions: 0,
      observations: 0,
    });
    createSqliteImportReceiptRepository(databasePath).parseStatementImport(
      createRequest(rollbackBytes, parser),
    );

    const committedBytes = Buffer.from('commit-before-response');
    const interruptedAfterCommit = createSqliteImportReceiptRepository(
      databasePath,
      undefined,
      { afterNormalizationCommitted: interrupt },
    );
    expect(() =>
      interruptedAfterCommit.parseStatementImport(
        createRequest(committedBytes, parser),
      ),
    ).toThrow(ImportReceiptInterruptedError);
    const replay = createSqliteImportReceiptRepository(
      databasePath,
    ).parseStatementImport(createRequest(committedBytes, parser));
    expect(replay).toMatchObject({
      replayed: true,
      receipt: { status: 'parsed' },
    });
    expect(readCounts()).toEqual({
      receipts: 2,
      transactions: 2,
      observations: 4,
    });
  });

  function createRequest(bytes: Buffer, parser: StatementImportParser) {
    return {
      sourceNamespaceId,
      actualAccountId: 'account-1',
      parser,
      bytes,
    };
  }

  function readCounts() {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return {
        receipts: count(database, 'import_batches'),
        transactions: count(database, 'source_transactions'),
        observations: count(database, 'source_transaction_observations'),
      };
    } finally {
      database.close();
    }
  }

  function databaseText() {
    const database = openCompanionDatabase(databasePath, true);
    try {
      return JSON.stringify([
        database.prepare('SELECT * FROM import_batches').all(),
        database.prepare('SELECT * FROM source_transactions').all(),
        database.prepare('SELECT * FROM source_transaction_observations').all(),
      ]);
    } finally {
      database.close();
    }
  }
});

function createSyntheticParser(
  version: number,
  parse: () => readonly ParsedStatementImportRow[],
): StatementImportParser {
  return { name: 'synthetic-statement-parser', version, parse };
}

function createRow(
  externalTransactionId: string,
  overrides: Partial<ParsedStatementImportRow> = {},
): ParsedStatementImportRow {
  return {
    externalTransactionId,
    currencyCode: 'USD',
    amount: 5000,
    transactionDate: '2026-01-01',
    postedDate: null,
    bookingStatus: 'posted',
    importedPayee: 'Synthetic merchant',
    normalizedPayeeKey: 'synthetic-merchant',
    fingerprintVersion: 1,
    fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function interrupt(): never {
  throw new ImportReceiptInterruptedError();
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
