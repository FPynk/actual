import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import {
  createSqliteSourceIdentityRepository,
  SourceCurrencyMismatchError,
} from '#database/source-identity-repository';
import type { SourceObservation } from '#database/source-identity-repository';

describe('FIN-18 source identities and immutable observations', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let sourceNamespaceId: string;
  let importBatchId: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-source-identities-'),
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
    const repository = createSqliteSourceIdentityRepository(databasePath);
    sourceNamespaceId = repository.createSourceNamespace({
      kind: 'statement',
      namespace: 'bank-a',
      displayName: 'Bank A',
      createdAt: '2026-01-01T00:00:00.000Z',
    }).id;
    importBatchId = createStatementImportBatch(databasePath, sourceNamespaceId);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates the complete frozen migration-003 table group during fresh initialization', () => {
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('source_namespaces', 'import_batches', 'source_transactions', 'source_transaction_observations') ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: 'import_batches' },
        { name: 'source_namespaces' },
        { name: 'source_transaction_observations' },
        { name: 'source_transactions' },
      ]);
      expect(
        database
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get(),
      ).toEqual({ version: 3 });
    } finally {
      database.close();
    }
  });

  it('enforces source identity, date, and immutable-observation constraints without fingerprint deduplication', () => {
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(() =>
        database
          .prepare(
            'INSERT INTO source_namespaces (id, kind, namespace, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            'statement',
            'invalid-date',
            'Invalid date',
            'not-a-timestamp',
          ),
      ).toThrow();
      const firstSourceTransactionId = randomUUID();
      insertSourceTransaction(databasePath, {
        id: firstSourceTransactionId,
        sourceNamespaceId,
        externalTransactionId: 'stable-id',
        fingerprint: 'f'.repeat(64),
      });
      expect(() =>
        insertSourceTransaction(databasePath, {
          id: randomUUID(),
          sourceNamespaceId,
          externalTransactionId: 'stable-id',
          fingerprint: 'f'.repeat(64),
        }),
      ).toThrow();
      expect(() =>
        insertSourceTransaction(databasePath, {
          id: randomUUID(),
          sourceNamespaceId,
          externalTransactionId: 'another-id',
          fingerprint: 'f'.repeat(64),
          transactionDate: '2026-02-30',
        }),
      ).toThrow();
      const nullExternalFirstId = randomUUID();
      const nullExternalSecondId = randomUUID();
      insertSourceTransaction(databasePath, {
        id: nullExternalFirstId,
        sourceNamespaceId,
        externalTransactionId: null,
        fingerprint: 'f'.repeat(64),
      });
      insertSourceTransaction(databasePath, {
        id: nullExternalSecondId,
        sourceNamespaceId,
        externalTransactionId: null,
        fingerprint: 'f'.repeat(64),
      });
      insertObservation(
        databasePath,
        firstSourceTransactionId,
        importBatchId,
        0,
      );
      expect(() =>
        database
          .prepare(
            'UPDATE source_transaction_observations SET amount = ? WHERE import_batch_id = ? AND source_row_index = ?',
          )
          .run(999, importBatchId, 0),
      ).toThrow('immutable');
      expect(() =>
        database
          .prepare(
            'DELETE FROM source_transaction_observations WHERE import_batch_id = ? AND source_row_index = ?',
          )
          .run(importBatchId, 0),
      ).toThrow('immutable');
    } finally {
      database.close();
    }
  });

  it('promotes pending observations to posted, never demotes posted, and records incompatible observations for review', () => {
    const repository = createSqliteSourceIdentityRepository(databasePath);
    const pending = createObservation({
      sourceNamespaceId,
      importBatchId,
      sourceRowIndex: 0,
      externalTransactionId: 'provider-1',
      bookingStatus: 'pending',
      observedAt: '2026-01-01T00:00:00.000Z',
    });
    const created = repository.recordObservation(pending);
    expect(created.kind).toBe('created');
    const posted = repository.recordObservation({
      ...pending,
      importBatchId: createStatementImportBatch(
        databasePath,
        sourceNamespaceId,
      ),
      sourceRowIndex: 0,
      bookingStatus: 'posted',
      postedDate: '2026-01-02',
      transactionDate: '2026-01-02',
      importedPayee: 'Posted merchant',
      observedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(posted).toMatchObject({
      kind: 'promoted',
      sourceTransactionId: created.sourceTransactionId,
    });
    const replayedPending = repository.recordObservation({
      ...pending,
      importBatchId: createStatementImportBatch(
        databasePath,
        sourceNamespaceId,
      ),
      sourceRowIndex: 0,
      transactionDate: '2026-01-03',
      importedPayee: 'Pending merchant',
      observedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(replayedPending).toMatchObject({ kind: 'observed' });
    const conflict = repository.recordObservation({
      ...pending,
      importBatchId: createStatementImportBatch(
        databasePath,
        sourceNamespaceId,
      ),
      sourceRowIndex: 0,
      amount: 7500,
      observedAt: '2026-01-04T00:00:00.000Z',
    });
    expect(conflict).toMatchObject({
      kind: 'conflict',
      sourceTransactionId: created.sourceTransactionId,
      requiresReview: true,
    });
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT amount, transaction_date, booking_status, posted_date, imported_payee FROM source_transactions WHERE id = ?',
          )
          .get(created.sourceTransactionId),
      ).toEqual({
        amount: 5000,
        transaction_date: '2026-01-02',
        booking_status: 'posted',
        posted_date: '2026-01-02',
        imported_payee: 'Posted merchant',
      });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM source_transaction_observations WHERE source_transaction_id = ?',
          )
          .get(created.sourceTransactionId),
      ).toEqual({ count: 4 });
    } finally {
      database.close();
    }
  });

  it('rejects a currency mismatch before recording observations or candidate state', () => {
    const repository = createSqliteSourceIdentityRepository(databasePath);
    expect(() =>
      repository.recordObservation(
        createObservation({
          sourceNamespaceId,
          importBatchId,
          sourceRowIndex: 0,
          externalTransactionId: 'currency-mismatch',
          currencyCode: 'EUR',
        }),
      ),
    ).toThrow(SourceCurrencyMismatchError);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM source_transactions')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM source_transaction_observations',
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('never deduplicates observations without an external ID and remains durable after restart', () => {
    const repository = createSqliteSourceIdentityRepository(databasePath);
    const first = repository.recordObservation(
      createObservation({
        sourceNamespaceId,
        importBatchId,
        sourceRowIndex: 0,
        externalTransactionId: null,
      }),
    );
    const second = repository.recordObservation(
      createObservation({
        sourceNamespaceId,
        importBatchId: createStatementImportBatch(
          databasePath,
          sourceNamespaceId,
        ),
        sourceRowIndex: 0,
        externalTransactionId: null,
      }),
    );
    expect(first).toMatchObject({ kind: 'created' });
    expect(second).toMatchObject({ kind: 'created' });
    expect(second.sourceTransactionId).not.toBe(first.sourceTransactionId);

    const restartedRepository =
      createSqliteSourceIdentityRepository(databasePath);
    const durable = restartedRepository.recordObservation(
      createObservation({
        sourceNamespaceId,
        importBatchId: createStatementImportBatch(
          databasePath,
          sourceNamespaceId,
        ),
        sourceRowIndex: 0,
        externalTransactionId: 'restart-stable-id',
      }),
    );
    const rereadAfterRestart = createSqliteSourceIdentityRepository(
      databasePath,
    ).recordObservation({
      ...createObservation({
        sourceNamespaceId,
        importBatchId: createStatementImportBatch(
          databasePath,
          sourceNamespaceId,
        ),
        sourceRowIndex: 0,
        externalTransactionId: 'restart-stable-id',
      }),
      observedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(rereadAfterRestart).toMatchObject({
      kind: 'observed',
      sourceTransactionId: durable.sourceTransactionId,
    });
  });

  it('rolls back a new canonical identity when its immutable observation cannot be inserted', () => {
    const repository = createSqliteSourceIdentityRepository(databasePath);
    repository.recordObservation(
      createObservation({
        sourceNamespaceId,
        importBatchId,
        sourceRowIndex: 0,
        externalTransactionId: 'already-used-row',
      }),
    );
    expect(() =>
      repository.recordObservation(
        createObservation({
          sourceNamespaceId,
          importBatchId,
          sourceRowIndex: 0,
          externalTransactionId: 'rolled-back-identity',
        }),
      ),
    ).toThrow();
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM source_transactions WHERE external_transaction_id = 'rolled-back-identity'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

function createStatementImportBatch(
  databasePath: string,
  sourceNamespaceId: string,
): string {
  const id = randomUUID();
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(
        'INSERT INTO import_batches (id, source_namespace_id, actual_account_id, source_kind, content_sha256, parser_name, parser_version, source_display_name, started_at, completed_at, status, row_count, accepted_count, rejected_count, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        sourceNamespaceId,
        'account-1',
        'statement',
        randomBytes(32).toString('hex'),
        'test-parser',
        1,
        'test.csv',
        '2026-01-01T00:00:00.000Z',
        null,
        'parsing',
        0,
        0,
        0,
        null,
      );
    return id;
  } finally {
    database.close();
  }
}

function createObservation(
  overrides: Partial<SourceObservation> &
    Pick<
      SourceObservation,
      | 'sourceNamespaceId'
      | 'importBatchId'
      | 'sourceRowIndex'
      | 'externalTransactionId'
    >,
): SourceObservation {
  const {
    sourceNamespaceId,
    importBatchId,
    sourceRowIndex,
    externalTransactionId,
    ...optionalOverrides
  } = overrides;
  return {
    sourceNamespaceId,
    importBatchId,
    sourceRowIndex,
    actualAccountId: 'account-1',
    externalTransactionId,
    currencyCode: 'USD',
    amount: 5000,
    transactionDate: '2026-01-01',
    postedDate: null,
    bookingStatus: 'pending',
    importedPayee: 'Merchant',
    normalizedPayeeKey: 'merchant-v1',
    fingerprintVersion: 1,
    fingerprint: 'f'.repeat(64),
    sourcePayloadHash: 'a'.repeat(64),
    observedAt: '2026-01-01T00:00:00.000Z',
    ...optionalOverrides,
  };
}

function insertSourceTransaction(
  databasePath: string,
  values: Readonly<{
    id: string;
    sourceNamespaceId: string;
    externalTransactionId: string | null;
    fingerprint: string;
    transactionDate?: string;
  }>,
): void {
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(
        'INSERT INTO source_transactions (id, source_namespace_id, actual_account_id, actual_transaction_id, external_transaction_id, currency_code, amount, transaction_date, posted_date, booking_status, imported_payee, normalized_payee_key, fingerprint_version, fingerprint, state, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        values.id,
        values.sourceNamespaceId,
        'account-1',
        null,
        values.externalTransactionId,
        'USD',
        5000,
        values.transactionDate ?? '2026-01-01',
        null,
        'pending',
        null,
        null,
        1,
        values.fingerprint,
        'unmatched',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
  } finally {
    database.close();
  }
}

function insertObservation(
  databasePath: string,
  sourceTransactionId: string,
  importBatchId: string,
  sourceRowIndex: number,
): void {
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(
        'INSERT INTO source_transaction_observations (id, source_transaction_id, import_batch_id, source_row_index, currency_code, amount, transaction_date, posted_date, booking_status, imported_payee, source_payload_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        sourceTransactionId,
        importBatchId,
        sourceRowIndex,
        'USD',
        5000,
        '2026-01-01',
        null,
        'pending',
        null,
        'a'.repeat(64),
        '2026-01-01T00:00:00.000Z',
      );
  } finally {
    database.close();
  }
}
