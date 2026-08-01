import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import {
  createCompanionOnlyBackup,
  restoreCompanionOnlyBackup,
  SimulatedRestoreInterruption,
  verifyCompanionOnlyBackup,
} from '#database/backup';
import { openCompanionDatabase } from '#database/connection';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { readIntegrityAnchor, writeIntegrityAnchor } from '#integrity/anchor';
import { verifyCompanionIntegrity } from '#integrity/verify';
import { createSqliteBankSyncJobRepository } from '#service/bank-sync';
import { runConfiguredBankSyncJob } from '#service/bank-sync-cli';

describe('FIN-11 companion database lifecycle', () => {
  let temporaryDirectory: string;
  let request: Readonly<{
    databasePath: string;
    migrationsDirectory: string;
    anchorPath: string;
    anchorMacKey: Buffer;
    budgetKeyHash: string;
    budgetCurrencyCode: string;
    createOwnerCredentialHash: () => Promise<string>;
  }>;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-'),
    );
    request = {
      databasePath: path.join(temporaryDirectory, 'companion.sqlite'),
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        '../../migrations',
      ),
      anchorPath: path.join(temporaryDirectory, 'anchor.json'),
      anchorMacKey: randomBytes(32),
      budgetKeyHash: 'a'.repeat(64),
      budgetCurrencyCode: 'USD',
      createOwnerCredentialHash: async () => 'test-owner-hash',
    };
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('initializes migrations 001 through 007, a stable principal, and a generation-zero anchor', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    expect(initialized).toMatchObject({
      schemaVersion: 7,
      writeCapabilityState: 'disabled',
    });

    const database = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM local_principals')
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            'SELECT version, checksum FROM schema_migrations ORDER BY version DESC',
          )
          .get(),
      ).toMatchObject({
        version: 7,
        checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      database.close();
    }
    await expect(
      verifyCompanionIntegrity({
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        anchorMacKey: request.anchorMacKey,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      }),
    ).resolves.toEqual({ schemaVersion: 7, writeCapabilityState: 'disabled' });
  });

  it('upgrades a valid 001-005 database through contiguous checksummed 006-007 history', async () => {
    const legacyMigrationsDirectory = path.join(
      temporaryDirectory,
      'legacy-migrations',
    );
    await mkdir(legacyMigrationsDirectory);
    const migrationNames = [
      '001-instance-and-principal.sql',
      '002-request-replay-and-job-runs.sql',
      '003-source-import-identities.sql',
      '004-review-candidates.sql',
      '005-amazon-enrichment.sql',
    ];
    for (const migrationName of migrationNames) {
      await copyFile(
        path.join(request.migrationsDirectory, migrationName),
        path.join(legacyMigrationsDirectory, migrationName),
      );
    }
    await initializeCompanionDatabaseAndAnchor({
      ...request,
      migrationsDirectory: legacyMigrationsDirectory,
    });
    const legacyDatabase = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        legacyDatabase
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all(),
      ).toEqual([1, 2, 3, 4, 5].map(version => ({ version })));
    } finally {
      legacyDatabase.close();
    }

    await expect(
      initializeCompanionDatabaseAndAnchor(request),
    ).resolves.toMatchObject({
      schemaVersion: 7,
      writeCapabilityState: 'disabled',
    });
    const upgradedDatabase = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        upgradedDatabase
          .prepare(
            'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
          )
          .all(),
      ).toEqual(
        expect.arrayContaining(
          Array.from({ length: 7 }, (_, index) => ({
            version: index + 1,
            name: expect.any(String),
            checksum: expect.stringMatching(/^[0-9a-f]{64}$/),
          })),
        ),
      );
    } finally {
      upgradedDatabase.close();
    }
  });

  it('keeps the 006 receipt parent empty and insert-blocked while allowing NULL candidate references', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      expect(() =>
        database
          .prepare('INSERT INTO application_receipts (id) VALUES (?)')
          .run(randomUUID()),
      ).toThrow('application receipts are not enabled');
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM application_receipts')
          .get(),
      ).toEqual({ count: 0 });
      expect(() =>
        database
          .prepare('INSERT OR IGNORE INTO application_receipts (id) VALUES (?)')
          .run(randomUUID()),
      ).toThrow('application receipts are not enabled');
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM application_receipts')
          .get(),
      ).toEqual({ count: 0 });

      database
        .prepare(
          `INSERT INTO amazon_charge_matches
           (id, matcher_version, currency_code, score, reason_codes_json, status, created_at, decided_at)
           VALUES ('migration-candidate', 2, 'USD', 100, '["exact-parent-sum"]', 'pending', '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `INSERT INTO amazon_match_transactions
             (match_id, actual_transaction_id, actual_target_version, allocated_amount, application_status, application_receipt_id)
             VALUES ('migration-candidate', 'actual-parent', ?, -100, 'pending', NULL)`,
          )
          .run('a'.repeat(64)),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            "UPDATE amazon_match_transactions SET application_status = 'applying', application_receipt_id = ? WHERE match_id = 'migration-candidate'",
          )
          .run(randomUUID()),
      ).toThrow('FOREIGN KEY constraint failed');
      expect(
        database
          .prepare("PRAGMA foreign_key_list('amazon_match_transactions')")
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'application_receipts',
            from: 'application_receipt_id',
            to: 'id',
          }),
        ]),
      );
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
      expect(
        database
          .prepare(
            "SELECT write_capability_state FROM companion_instance WHERE singleton_key = 'main'",
          )
          .get(),
      ).toEqual({ write_capability_state: 'disabled' });
    } finally {
      database.close();
    }
  });

  it('fails closed and records recovery_required when the anchor cannot be proven', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    await writeFile(request.anchorPath, '{"not":"an anchor"}');
    await expect(
      verifyCompanionIntegrity({
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        anchorMacKey: request.anchorMacKey,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      }),
    ).resolves.toEqual({
      schemaVersion: 7,
      writeCapabilityState: 'recovery_required',
    });
  });

  it('fails closed when a generation-zero anchor claims a paired backup', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    const anchor = await readIntegrityAnchor(
      request.anchorPath,
      request.anchorMacKey,
    );
    await writeIntegrityAnchor(
      request.anchorPath,
      {
        ...anchor,
        lastVerifiedPairedBackupManifestHash: 'b'.repeat(64),
      },
      request.anchorMacKey,
    );

    await expect(
      verifyCompanionIntegrity({
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        anchorMacKey: request.anchorMacKey,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      }),
    ).resolves.toEqual({
      schemaVersion: 7,
      writeCapabilityState: 'recovery_required',
    });
  });

  it('creates, verifies, and restores a paired generation-zero backup', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    const backup = {
      databasePath: request.databasePath,
      anchorPath: request.anchorPath,
      backupPath: path.join(temporaryDirectory, 'companion.backup'),
      encryptionKey: randomBytes(32),
      anchorMacKey: request.anchorMacKey,
      expectedInstanceId: initialized.instanceId,
      expectedBudgetKeyHash: request.budgetKeyHash,
      expectedCurrencyCode: request.budgetCurrencyCode,
    };
    await expect(createCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 7,
      budgetKeyHash: request.budgetKeyHash,
    });
    await expect(verifyCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 7,
    });
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      database
        .prepare(
          "UPDATE companion_instance SET write_capability_state = 'recovery_required' WHERE singleton_key = 'main'",
        )
        .run();
    } finally {
      database.close();
    }
    await writeFile(request.anchorPath, '{"synthetic":"damaged"}');
    await expect(restoreCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 7,
      budgetKeyHash: request.budgetKeyHash,
    });
    await expect(
      verifyCompanionIntegrity({
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        anchorMacKey: request.anchorMacKey,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      }),
    ).resolves.toEqual({ schemaVersion: 7, writeCapabilityState: 'disabled' });
    const restoredDatabase = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        restoredDatabase
          .prepare('SELECT COUNT(*) AS count FROM application_receipts')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        restoredDatabase
          .prepare(
            "SELECT write_capability_state FROM companion_instance WHERE singleton_key = 'main'",
          )
          .get(),
      ).toEqual({ write_capability_state: 'disabled' });
    } finally {
      restoredDatabase.close();
    }
    expect((await readFile(backup.backupPath)).length).toBeGreaterThan(0);
  });

  it.each(['queued', 'running', 'outcome_unknown'] as const)(
    'refuses a companion-only backup while a bank-sync job is %s',
    async status => {
      const initialized = await initializeCompanionDatabaseAndAnchor(request);
      insertSyntheticBankSyncEvidence(
        request.databasePath,
        request.budgetKeyHash,
        {
          parentStatus: status,
        },
      );
      const backup = {
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        backupPath: path.join(temporaryDirectory, 'companion.backup'),
        encryptionKey: randomBytes(32),
        anchorMacKey: request.anchorMacKey,
        expectedInstanceId: initialized.instanceId,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      };
      const databaseBefore = await readFile(request.databasePath);
      const anchorBefore = await readFile(request.anchorPath);

      await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
        'blocked by unresolved bank-sync evidence',
      );
      expect(existsSync(backup.backupPath)).toBe(false);
      expect(await readFile(request.databasePath)).toEqual(databaseBefore);
      expect(await readFile(request.anchorPath)).toEqual(anchorBefore);
    },
  );

  it('refuses to erase a later unknown bank-sync outcome during restore', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    const backup = {
      databasePath: request.databasePath,
      anchorPath: request.anchorPath,
      backupPath: path.join(temporaryDirectory, 'companion.backup'),
      encryptionKey: randomBytes(32),
      anchorMacKey: request.anchorMacKey,
      expectedInstanceId: initialized.instanceId,
      expectedBudgetKeyHash: request.budgetKeyHash,
      expectedCurrencyCode: request.budgetCurrencyCode,
    };
    await createCompanionOnlyBackup(backup);
    insertSyntheticBankSyncEvidence(
      request.databasePath,
      request.budgetKeyHash,
      {
        childStatus: 'outcome_unknown',
        parentStatus: 'outcome_unknown',
        quarantineBundleHash: 'd'.repeat(64),
      },
    );
    const databaseBefore = await readFile(request.databasePath);
    const anchorBefore = await readFile(request.anchorPath);
    const backupBefore = await readFile(backup.backupPath);

    await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow(
      'blocked by unresolved bank-sync evidence',
    );
    expect(await readFile(request.databasePath)).toEqual(databaseBefore);
    expect(await readFile(request.anchorPath)).toEqual(anchorBefore);
    expect(await readFile(backup.backupPath)).toEqual(backupBefore);
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM job_runs WHERE status = 'outcome_unknown'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('blocks unresolved child quarantine evidence but permits explicitly resolved evidence', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    const backup = {
      databasePath: request.databasePath,
      anchorPath: request.anchorPath,
      backupPath: path.join(temporaryDirectory, 'companion.backup'),
      encryptionKey: randomBytes(32),
      anchorMacKey: request.anchorMacKey,
      expectedInstanceId: initialized.instanceId,
      expectedBudgetKeyHash: request.budgetKeyHash,
      expectedCurrencyCode: request.budgetCurrencyCode,
    };
    const evidence = insertSyntheticBankSyncEvidence(
      request.databasePath,
      request.budgetKeyHash,
      {
        childStatus: 'failed',
        parentStatus: 'failed',
        quarantineBundleHash: 'e'.repeat(64),
      },
    );

    await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
      'blocked by unresolved bank-sync evidence',
    );
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      const resolvedAt = '2026-07-31T00:00:00.000Z';
      database
        .prepare(
          'UPDATE job_runs SET resolution_code = ?, resolved_at = ? WHERE id = ?',
        )
        .run(
          'authoritative-sync-completed-effects-unknown',
          resolvedAt,
          evidence.jobId,
        );
      database
        .prepare(
          'UPDATE job_run_account_operations SET status = ?, resolution_code = ?, resolved_at = ? WHERE worker_operation_id = ?',
        )
        .run(
          'outcome_unknown',
          'authoritative-sync-completed-effects-unknown',
          resolvedAt,
          evidence.workerOperationId,
        );
    } finally {
      database.close();
    }

    await expect(createCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 7,
    });
  });

  it.each([
    {
      name: 'child-only resolution',
      parentCode: null,
      parentResolvedAt: null,
      childCode: 'authoritative-sync-completed-effects-unknown',
      childResolvedAt: '2026-07-31T00:00:00.000Z',
    },
    {
      name: 'wrong child resolution code',
      parentCode: 'authoritative-sync-completed-effects-unknown',
      parentResolvedAt: '2026-07-31T00:00:00.000Z',
      childCode: 'unverified-resolution',
      childResolvedAt: '2026-07-31T00:00:00.000Z',
    },
    {
      name: 'mismatched resolution time',
      parentCode: 'authoritative-sync-completed-effects-unknown',
      parentResolvedAt: '2026-07-31T00:00:00.000Z',
      childCode: 'authoritative-sync-completed-effects-unknown',
      childResolvedAt: '2026-07-31T00:00:01.000Z',
    },
    {
      name: 'wrong parent resolution code',
      parentCode: 'unverified-resolution',
      parentResolvedAt: '2026-07-31T00:00:00.000Z',
      childCode: 'authoritative-sync-completed-effects-unknown',
      childResolvedAt: '2026-07-31T00:00:00.000Z',
    },
  ])('rejects $name as unresolved bank-sync evidence', async resolution => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    const evidence = insertSyntheticBankSyncEvidence(
      request.databasePath,
      request.budgetKeyHash,
      {
        childStatus: 'outcome_unknown',
        parentStatus: 'failed',
        quarantineBundleHash: 'e'.repeat(64),
      },
    );
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      database
        .prepare(
          'UPDATE job_runs SET resolution_code = ?, resolved_at = ? WHERE id = ?',
        )
        .run(
          resolution.parentCode,
          resolution.parentResolvedAt,
          evidence.jobId,
        );
      database
        .prepare(
          'UPDATE job_run_account_operations SET resolution_code = ?, resolved_at = ? WHERE worker_operation_id = ?',
        )
        .run(
          resolution.childCode,
          resolution.childResolvedAt,
          evidence.workerOperationId,
        );
    } finally {
      database.close();
    }

    await expect(
      createCompanionOnlyBackup({
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        backupPath: path.join(temporaryDirectory, 'companion.backup'),
        encryptionKey: randomBytes(32),
        anchorMacKey: request.anchorMacKey,
        expectedInstanceId: initialized.instanceId,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      }),
    ).rejects.toThrow('blocked by unresolved bank-sync evidence');
  });

  it('fails closed before migrating an existing database with unresolved bank-sync evidence', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    insertSyntheticBankSyncEvidence(
      request.databasePath,
      request.budgetKeyHash,
      {
        parentStatus: 'running',
      },
    );

    await expect(initializeCompanionDatabaseAndAnchor(request)).rejects.toThrow(
      'blocked by unresolved bank-sync evidence',
    );
    const database = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        database
          .prepare(
            "SELECT write_capability_state FROM companion_instance WHERE singleton_key = 'main'",
          )
          .get(),
      ).toEqual({ write_capability_state: 'recovery_required' });
      expect(
        database
          .prepare('SELECT MAX(version) AS version FROM schema_migrations')
          .get(),
      ).toEqual({ version: 7 });
    } finally {
      database.close();
    }
  });

  it('atomically refuses bank-sync job creation while maintenance owns the lifecycle lock', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    const database = openCompanionDatabase(request.databasePath, true);
    let principalId: string;
    try {
      principalId = (
        database.prepare('SELECT id FROM local_principals').get() as Readonly<{
          id: string;
        }>
      ).id;
    } finally {
      database.close();
    }
    const repository = createSqliteBankSyncJobRepository(request.databasePath);

    await withExclusiveMaintenanceLock(request.databasePath, async () => {
      expect(() =>
        repository.create(
          {
            budgetKeyHash: request.budgetKeyHash,
            idempotencyKey: 'synthetic-lock-race',
            invocationKind: 'scheduler',
            principalId,
            requestHash: 'f'.repeat(64),
          },
          ['account-1'],
        ),
      ).toThrow('Exclusive maintenance is required');
    });
    const verifiedDatabase = openCompanionDatabase(request.databasePath, true);
    try {
      expect(
        verifiedDatabase
          .prepare('SELECT COUNT(*) AS count FROM job_runs')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      verifiedDatabase.close();
    }
  });

  it('keeps recovery maintenance out until a configured bank-sync job is terminal', async () => {
    await initializeCompanionDatabaseAndAnchor(request);
    const database = openCompanionDatabase(request.databasePath, true);
    let principal: Readonly<{ id: string; credential_hash: string }>;
    try {
      principal = database
        .prepare('SELECT id, credential_hash FROM local_principals')
        .get() as Readonly<{ id: string; credential_hash: string }>;
    } finally {
      database.close();
    }
    const configuration: FinanceCompanionConfiguration = {
      bindAddress: '127.0.0.1',
      port: 4100,
      origin: 'http://127.0.0.1:4100',
      dataDirectory: temporaryDirectory,
      databasePath: request.databasePath,
      integrityAnchorPath: request.anchorPath,
      integrityMacKeyFile: undefined,
      integrityMacKey: request.anchorMacKey.toString('base64url'),
      budgetKeyHash: request.budgetKeyHash,
      budgetCurrencyCode: request.budgetCurrencyCode,
      ownerBootstrapCredential: undefined,
      ownerBootstrapCredentialFile: undefined,
    };
    let releaseAdapter: () => void = () => undefined;
    let notifyAdapterStarted: () => void = () => undefined;
    const adapterStarted = new Promise<void>(resolve => {
      notifyAdapterStarted = resolve;
    });
    const continueAdapter = new Promise<void>(resolve => {
      releaseAdapter = resolve;
    });
    const adapter: ActualAdapter = {
      getActiveOperationStatus: () => null,
      getHealth: () => 'healthy',
      execute: async operation => {
        if (operation.kind === 'read-budget-snapshot') {
          return {
            kind: operation.kind,
            snapshot: {
              accounts: [
                {
                  closed: false,
                  id: 'account-1',
                  lastSync: null,
                  name: 'Synthetic account',
                  offBudget: false,
                  syncSource: 'simpleFin',
                  syncStatus: null,
                },
              ],
              budget: {
                budgetKeyHash: request.budgetKeyHash,
                capturedAt: '2026-07-31T00:00:00.000Z',
                currencyCode: request.budgetCurrencyCode,
              },
              contractVersion: 1,
            },
          };
        }
        if (operation.kind !== 'run-account-bank-sync') {
          throw new Error('Unexpected synthetic adapter operation.');
        }
        notifyAdapterStarted();
        await continueAdapter;
        return {
          kind: operation.kind,
          result: {
            accountId: operation.accountId,
            completedAt: '2026-07-31T00:00:01.000Z',
            contractVersion: 1,
            finalSyncCode: 'succeeded',
            outcomeCode: 'succeeded',
            startedAt: '2026-07-31T00:00:00.000Z',
            transactionCounts: null,
          },
        };
      },
    };
    const job = runConfiguredBankSyncJob(
      configuration,
      {
        readOwner: async () => ({
          id: principal.id,
          credentialHash: principal.credential_hash,
        }),
        writeOwner: async () => undefined,
        replaceOwnerCredentialHash: async () => false,
      },
      {
        accountIds: null,
        idempotencyKey: 'synthetic-full-maintenance-lock',
        invocationKind: 'scheduler',
      },
      undefined,
      { createAdapter: async () => adapter },
    );
    await adapterStarted;

    try {
      await expect(
        initializeCompanionDatabaseAndAnchor(request),
      ).rejects.toThrow('Exclusive maintenance is required');
      const runningDatabase = openCompanionDatabase(request.databasePath, true);
      try {
        expect(
          runningDatabase
            .prepare(
              "SELECT write_capability_state FROM companion_instance WHERE singleton_key = 'main'",
            )
            .get(),
        ).toEqual({ write_capability_state: 'disabled' });
        expect(
          runningDatabase.prepare('SELECT status FROM job_runs').get(),
        ).toEqual({ status: 'running' });
      } finally {
        runningDatabase.close();
      }
    } finally {
      releaseAdapter();
    }

    await expect(job).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('does not import an Actual adapter or mutator during companion-only restore', async () => {
    const restoreSource = await readFile(
      path.resolve(import.meta.dirname, '../database/backup.ts'),
      'utf8',
    );

    expect(restoreSource).not.toMatch(
      /(?:#actual\/|@actual-app\/api|actual\/adapter|mutat(?:e|or))/i,
    );
  });

  it.each([
    'intent-written',
    'database-original-staged',
    'database-replaced',
    'anchor-original-staged',
    'anchor-replaced',
  ] as const)(
    'fails closed after a synthetic interruption at %s',
    async phase => {
      const initialized = await initializeCompanionDatabaseAndAnchor(request);
      const backup = {
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        backupPath: path.join(temporaryDirectory, 'companion.backup'),
        encryptionKey: randomBytes(32),
        anchorMacKey: request.anchorMacKey,
        expectedInstanceId: initialized.instanceId,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      };
      await createCompanionOnlyBackup(backup);
      const originalDatabase = await readFile(request.databasePath);
      const originalAnchor = await readFile(request.anchorPath);

      await expect(
        restoreCompanionOnlyBackup(backup, {
          afterPhase: reachedPhase => {
            if (reachedPhase === phase) {
              throw new SimulatedRestoreInterruption();
            }
          },
        }),
      ).rejects.toBeInstanceOf(SimulatedRestoreInterruption);
      await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow(
        'requires recovery',
      );
      await expectPreviousPairRemainsRecoverable(
        originalDatabase,
        originalAnchor,
      );
      if (phase === 'database-original-staged') {
        expect(existsSync(request.databasePath)).toBe(false);
      } else if (phase === 'anchor-original-staged') {
        expect(existsSync(request.databasePath)).toBe(true);
        expect(existsSync(request.anchorPath)).toBe(false);
      } else {
        await expect(
          verifyCompanionIntegrity({
            databasePath: request.databasePath,
            anchorPath: request.anchorPath,
            anchorMacKey: request.anchorMacKey,
            expectedBudgetKeyHash: request.budgetKeyHash,
            expectedCurrencyCode: request.budgetCurrencyCode,
          }),
        ).resolves.toMatchObject({ writeCapabilityState: 'recovery_required' });
      }
    },
  );

  async function expectPreviousPairRemainsRecoverable(
    originalDatabase: Buffer,
    originalAnchor: Buffer,
  ): Promise<void> {
    await expectOriginalMemberIsAvailable(
      request.databasePath,
      originalDatabase,
    );
    await expectOriginalMemberIsAvailable(request.anchorPath, originalAnchor);
  }

  async function expectOriginalMemberIsAvailable(
    livePath: string,
    originalBytes: Buffer,
  ): Promise<void> {
    const parentDirectory = path.dirname(livePath);
    const rollbackPrefix = `.${path.basename(livePath)}.restore-`;
    const candidates = [
      livePath,
      ...(await readdir(parentDirectory))
        .filter(
          entry =>
            entry.startsWith(rollbackPrefix) && entry.endsWith('.rollback'),
        )
        .map(entry => path.join(parentDirectory, entry)),
    ];
    const availableCandidates = candidates.filter(existsSync);

    expect(availableCandidates).not.toHaveLength(0);
    await expect(
      Promise.all(availableCandidates.map(candidate => readFile(candidate))),
    ).resolves.toContainEqual(originalBytes);
  }

  it('restores the original pair after a non-crash replacement failure', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    const backup = {
      databasePath: request.databasePath,
      anchorPath: request.anchorPath,
      backupPath: path.join(temporaryDirectory, 'companion.backup'),
      encryptionKey: randomBytes(32),
      anchorMacKey: request.anchorMacKey,
      expectedInstanceId: initialized.instanceId,
      expectedBudgetKeyHash: request.budgetKeyHash,
      expectedCurrencyCode: request.budgetCurrencyCode,
    };
    await createCompanionOnlyBackup(backup);
    const originalDatabase = await readFile(request.databasePath);
    const originalAnchor = await readFile(request.anchorPath);

    await expect(
      restoreCompanionOnlyBackup(backup, {
        afterPhase: phase => {
          if (phase === 'database-replaced') {
            throw new Error('synthetic failure');
          }
        },
      }),
    ).rejects.toThrow('synthetic failure');
    expect(await readFile(request.databasePath)).toEqual(originalDatabase);
    expect(await readFile(request.anchorPath)).toEqual(originalAnchor);
  });

  it.each(['database-rollback', 'anchor-rollback', 'intent'] as const)(
    'keeps the restored pair when cleanup cannot remove %s',
    async failedArtifact => {
      const initialized = await initializeCompanionDatabaseAndAnchor(request);
      const backup = {
        databasePath: request.databasePath,
        anchorPath: request.anchorPath,
        backupPath: path.join(temporaryDirectory, 'companion.backup'),
        encryptionKey: randomBytes(32),
        anchorMacKey: request.anchorMacKey,
        expectedInstanceId: initialized.instanceId,
        expectedBudgetKeyHash: request.budgetKeyHash,
        expectedCurrencyCode: request.budgetCurrencyCode,
      };
      await createCompanionOnlyBackup(backup);
      const database = openCompanionDatabase(request.databasePath, true);
      try {
        database
          .prepare(
            "UPDATE companion_instance SET write_capability_state = 'recovery_required' WHERE singleton_key = 'main'",
          )
          .run();
      } finally {
        database.close();
      }
      await writeFile(request.anchorPath, '{"synthetic":"damaged"}');

      await expect(
        restoreCompanionOnlyBackup(backup, {
          beforeCleanupArtifactRemoval: artifact => {
            if (artifact === failedArtifact) {
              throw new Error('synthetic cleanup failure');
            }
          },
        }),
      ).rejects.toThrow('completed but cleanup requires recovery');
      expect(existsSync(request.databasePath)).toBe(true);
      expect(existsSync(request.anchorPath)).toBe(true);
      const restoredDatabase = openCompanionDatabase(
        request.databasePath,
        true,
      );
      try {
        expect(
          restoredDatabase
            .prepare(
              'SELECT write_capability_state FROM companion_instance WHERE singleton_key = ?',
            )
            .get('main'),
        ).toEqual({ write_capability_state: 'disabled' });
      } finally {
        restoredDatabase.close();
      }
      await expect(
        readIntegrityAnchor(request.anchorPath, request.anchorMacKey),
      ).resolves.toMatchObject({
        budgetKeyHash: request.budgetKeyHash,
        writeCapabilityGeneration: 0,
      });
      await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow(
        'requires recovery',
      );
    },
  );
});

function insertSyntheticBankSyncEvidence(
  databasePath: string,
  budgetKeyHash: string,
  evidence: Readonly<{
    parentStatus: 'queued' | 'running' | 'failed' | 'outcome_unknown';
    childStatus?: 'queued' | 'running' | 'failed' | 'outcome_unknown';
    quarantineBundleHash?: string;
  }>,
): Readonly<{ jobId: string; workerOperationId: string }> {
  const database = openCompanionDatabase(databasePath, true);
  const jobId = randomUUID();
  const workerOperationId = randomUUID();
  try {
    const principal = database
      .prepare('SELECT id FROM local_principals')
      .get() as Readonly<{ id: string }> | undefined;
    if (principal === undefined)
      throw new Error('Synthetic principal missing.');
    database
      .prepare(
        `INSERT INTO job_runs
         (id, job_kind, budget_key_hash, invocation_kind, operation_id, principal_id,
          idempotency_key, request_hash, status, attempt, summary_json)
         VALUES (?, 'bank_sync', ?, 'scheduler', 'finance-companion/job:bank-sync/v1', ?,
          ?, ?, ?, 1, '{}')`,
      )
      .run(
        jobId,
        budgetKeyHash,
        principal.id,
        `synthetic-${jobId}`,
        'b'.repeat(64),
        evidence.parentStatus,
      );
    if (evidence.childStatus !== undefined) {
      database
        .prepare(
          `INSERT INTO job_run_account_operations
           (worker_operation_id, job_run_id, account_id, ordinal,
            expected_quarantine_root, status, quarantine_bundle_hash)
           VALUES (?, ?, 'account-1', 0, ?, ?, ?)`,
        )
        .run(
          workerOperationId,
          jobId,
          `bank-sync-${jobId}-${workerOperationId}`,
          evidence.childStatus,
          evidence.quarantineBundleHash ?? null,
        );
    }
  } finally {
    database.close();
  }
  return { jobId, workerOperationId };
}
