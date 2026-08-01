import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  createCompanionOnlyBackup,
  restoreCompanionOnlyBackup,
  verifyCompanionOnlyBackup,
} from '#database/backup';
import type { CompanionBackupRequest } from '#database/backup';
import { runDatabaseLifecycleCommand } from '#database/lifecycle-cli';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import {
  initializeCompanionDatabaseAndAnchor,
  initializeCompanionDatabaseAndAnchorDuringMaintenance,
} from '#database/migrate';
import type { InitializeCompanionDatabaseRequest } from '#database/migrate';
import { readIntegrityAnchor, writeIntegrityAnchor } from '#integrity/anchor';
import { sha256 } from '#integrity/canonical-hash';
import { verifyCompanionIntegrity } from '#integrity/verify';

describe('FIN-11 database safety gates', () => {
  let temporaryDirectory: string;
  let initialization: InitializeCompanionDatabaseRequest;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-safety-'),
    );
    initialization = {
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

  it.each(['database', 'anchor'] as const)(
    'rejects a partial preexisting %s before migration',
    async existingMember => {
      const existingPath =
        existingMember === 'database'
          ? initialization.databasePath
          : initialization.anchorPath;
      const absentPath =
        existingMember === 'database'
          ? initialization.anchorPath
          : initialization.databasePath;
      await writeFile(existingPath, 'preexisting');

      await expect(
        initializeCompanionDatabaseAndAnchor(initialization),
      ).rejects.toThrow('state is incomplete');
      expect(await readFile(existingPath, 'utf8')).toBe('preexisting');
      expect(existsSync(absentPath)).toBe(false);
    },
  );

  it('rolls back migration 001 and instance initialization together', async () => {
    await expect(
      initializeCompanionDatabaseAndAnchor({
        ...initialization,
        createOwnerCredentialHash: async () => '',
      }),
    ).rejects.toThrow();
    const database = new Database(initialization.databasePath);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    expect(existsSync(initialization.anchorPath)).toBe(false);
  });

  it('requires an exclusive maintenance lock before initialization', async () => {
    await writeFile(`${initialization.databasePath}.maintenance.lock`, 'held');
    await expect(
      initializeCompanionDatabaseAndAnchor(initialization),
    ).rejects.toThrow('Exclusive maintenance is required');
    expect(existsSync(initialization.databasePath)).toBe(false);
    expect(existsSync(initialization.anchorPath)).toBe(false);
  });

  it('forwards an existing generation-zero migration-001 database transactionally', async () => {
    const migration = await readFile(
      path.join(
        initialization.migrationsDirectory,
        '001-instance-and-principal.sql',
      ),
      'utf8',
    );
    const instanceId = randomUUID();
    const createdAt = new Date().toISOString();
    const database = new Database(initialization.databasePath);
    try {
      database.exec(migration);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
        )
        .run(
          1,
          '001-instance-and-principal.sql',
          createdAt,
          sha256(Buffer.from(migration, 'utf8')),
        );
      database
        .prepare(
          'INSERT INTO companion_instance (singleton_key, instance_id, budget_key_hash, budget_currency_code, write_capability_state, write_capability_generation, write_capability_event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'main',
          instanceId,
          initialization.budgetKeyHash,
          initialization.budgetCurrencyCode,
          'disabled',
          0,
          null,
          createdAt,
        );
      database
        .prepare(
          'INSERT INTO local_principals (id, credential_hash, created_at, rotated_at) VALUES (?, ?, ?, ?)',
        )
        .run(randomUUID(), 'test-owner-hash', createdAt, null);
    } finally {
      database.close();
    }
    await writeIntegrityAnchor(
      initialization.anchorPath,
      {
        formatVersion: 1,
        budgetKeyHash: initialization.budgetKeyHash,
        writeCapabilityGeneration: 0,
        writeCapabilityEventHash: null,
        highestIssuedIntentSequence: 0,
        highestIssuedIntentHash: null,
        highestAppliedReceiptSequence: 0,
        highestAppliedReceiptHash: null,
        lastVerifiedPairedBackupManifestHash: null,
      },
      initialization.anchorMacKey,
    );

    await expect(
      initializeCompanionDatabaseAndAnchorDuringMaintenance(initialization),
    ).resolves.toMatchObject({
      instanceId,
      schemaVersion: 7,
    });
  });

  it.each([
    [
      'changed migration checksum',
      "UPDATE schema_migrations SET checksum = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE version = 1",
    ],
    [
      'newer schema version',
      "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (8, '008-future.sql', '2026-01-01T00:00:00.000Z', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')",
    ],
  ])('refuses a %s without changing the bound database', async (_, sql) => {
    await initializeCompanionDatabaseAndAnchor(initialization);
    const database = new Database(initialization.databasePath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }

    await expect(
      initializeCompanionDatabaseAndAnchor(initialization),
    ).rejects.toThrow();
  });

  it.each([
    [
      'binding',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        expectedBudgetKeyHash: 'b'.repeat(64),
      }),
    ],
    [
      'anchor key',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        anchorMacKey: randomBytes(32),
      }),
    ],
    [
      'instance',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        expectedInstanceId: randomUUID(),
      }),
    ],
    [
      'currency',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        expectedCurrencyCode: 'EUR',
      }),
    ],
    [
      'encryption key',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        encryptionKey: randomBytes(32),
      }),
    ],
  ] as const)(
    'rejects backup verification with the wrong %s',
    async (_, change) => {
      const backup = await createBackupRequest();
      await createCompanionOnlyBackup(backup);
      await expect(verifyCompanionOnlyBackup(change(backup))).rejects.toThrow();
    },
  );

  it('rejects a backup destination equal to the live database', async () => {
    const backup = await createBackupRequest();
    await expect(
      createCompanionOnlyBackup({
        ...backup,
        backupPath: initialization.databasePath,
      }),
    ).rejects.toThrow();
  });

  it('never overwrites an existing backup destination', async () => {
    const backup = await createBackupRequest();
    await writeFile(backup.backupPath, 'published-backup');
    await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
      'destination already exists',
    );
    expect(await readFile(backup.backupPath, 'utf8')).toBe('published-backup');
  });

  it('refuses a generation-zero anchor with a stale paired backup manifest', async () => {
    const backup = await createBackupRequest();
    const anchor = await readIntegrityAnchor(
      initialization.anchorPath,
      initialization.anchorMacKey,
    );
    await writeIntegrityAnchor(
      initialization.anchorPath,
      {
        ...anchor,
        lastVerifiedPairedBackupManifestHash: 'b'.repeat(64),
      },
      initialization.anchorMacKey,
    );

    await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
      'generation-zero integrity anchor',
    );
    await expect(
      verifyCompanionIntegrity({
        databasePath: initialization.databasePath,
        anchorPath: initialization.anchorPath,
        anchorMacKey: initialization.anchorMacKey,
        expectedBudgetKeyHash: initialization.budgetKeyHash,
        expectedCurrencyCode: initialization.budgetCurrencyCode,
      }),
    ).resolves.toMatchObject({ writeCapabilityState: 'recovery_required' });
  });

  it('refuses backup and migration while interrupted restore artifacts remain', async () => {
    const backup = await createBackupRequest();
    const intentPath = path.join(
      path.dirname(initialization.anchorPath),
      `.finance-companion-restore-intent-${randomUUID()}.json`,
    );
    await writeFile(intentPath, 'retained');

    await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
      'requires recovery',
    );
    await expect(
      initializeCompanionDatabaseAndAnchor(initialization),
    ).rejects.toThrow('requires recovery');
  });

  it('keeps one maintenance lock across backup and existing-database migration', async () => {
    await initializeCompanionDatabaseAndAnchor(initialization);
    const backupEncryptionKeyPath = path.join(temporaryDirectory, 'backup.key');
    await writeFile(backupEncryptionKeyPath, randomBytes(32), { mode: 0o600 });
    let observedExclusiveLock = false;

    await expect(
      runDatabaseLifecycleCommand(
        'db:migrate',
        {
          bindAddress: '127.0.0.1',
          port: 4100,
          origin: 'http://127.0.0.1:4100',
          dataDirectory: temporaryDirectory,
          databasePath: initialization.databasePath,
          integrityAnchorPath: initialization.anchorPath,
          integrityMacKeyFile: undefined,
          integrityMacKey: initialization.anchorMacKey.toString('base64url'),
          backupEncryptionKeyFile: backupEncryptionKeyPath,
          budgetKeyHash: initialization.budgetKeyHash,
          budgetCurrencyCode: initialization.budgetCurrencyCode,
          ownerBootstrapCredential: undefined,
          ownerBootstrapCredentialFile: undefined,
        },
        ['--backup-path', path.join(temporaryDirectory, 'companion.backup')],
        {
          afterBackupBeforeMigration: async () => {
            await expect(
              withExclusiveMaintenanceLock(
                initialization.databasePath,
                async () => undefined,
              ),
            ).rejects.toThrow('Exclusive maintenance is required');
            observedExclusiveLock = true;
          },
        },
      ),
    ).resolves.toMatchObject({ ok: true, schemaVersion: 7 });
    expect(observedExclusiveLock).toBe(true);
  });

  it.each([
    [
      'wrong budget',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        expectedBudgetKeyHash: 'b'.repeat(64),
      }),
    ],
    [
      'wrong currency',
      (backup: CompanionBackupRequest) => ({
        ...backup,
        expectedCurrencyCode: 'EUR',
      }),
    ],
  ] as const)(
    'leaves the current pair untouched when restore has a %s',
    async (_, change) => {
      const backup = await createBackupRequest();
      await createCompanionOnlyBackup(backup);
      const originalDatabase = await readFile(initialization.databasePath);
      const originalAnchor = await readFile(initialization.anchorPath);

      await expect(
        restoreCompanionOnlyBackup(change(backup)),
      ).rejects.toThrow();
      expect(await readFile(initialization.databasePath)).toEqual(
        originalDatabase,
      );
      expect(await readFile(initialization.anchorPath)).toEqual(originalAnchor);
    },
  );

  it('leaves the database untouched when the current anchor is missing', async () => {
    const backup = await createBackupRequest();
    await createCompanionOnlyBackup(backup);
    const originalDatabase = await readFile(initialization.databasePath);
    await rm(initialization.anchorPath);

    await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow();
    expect(await readFile(initialization.databasePath)).toEqual(
      originalDatabase,
    );
  });

  it('leaves the current pair untouched when the encrypted backup is tampered', async () => {
    const backup = await createBackupRequest();
    await createCompanionOnlyBackup(backup);
    const originalDatabase = await readFile(initialization.databasePath);
    const originalAnchor = await readFile(initialization.anchorPath);
    const bytes = await readFile(backup.backupPath);
    bytes[bytes.length - 2] ^= 1;
    await writeFile(backup.backupPath, bytes);

    await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow();
    expect(await readFile(initialization.databasePath)).toEqual(
      originalDatabase,
    );
    expect(await readFile(initialization.anchorPath)).toEqual(originalAnchor);
  });

  it('rejects a hard-link alias of a protected live file', async () => {
    const backup = await createBackupRequest();
    const aliasPath = path.join(temporaryDirectory, 'database-alias');
    await link(initialization.databasePath, aliasPath);
    await expect(
      verifyCompanionOnlyBackup({ ...backup, backupPath: aliasPath }),
    ).rejects.toThrow('must not alias');
  });

  it('rejects unresolved SQLite sidecars', async () => {
    const backup = await createBackupRequest();
    await writeFile(`${initialization.databasePath}-wal`, 'unresolved');
    await expect(createCompanionOnlyBackup(backup)).rejects.toThrow(
      'SQLite sidecars',
    );
  });

  it.each([
    'journal',
    'database-stage',
    'database-rollback',
    'anchor-stage',
    'anchor-rollback',
  ] as const)(
    'detects retained restore state at the %s crash point',
    async retainedArtifact => {
      await initializeCompanionDatabaseAndAnchor(initialization);
      const operationId = randomUUID();
      const artifactPath =
        retainedArtifact === 'journal'
          ? path.join(
              path.dirname(initialization.anchorPath),
              `.finance-companion-restore-intent-${operationId}.json`,
            )
          : retainedArtifact.startsWith('database-')
            ? path.join(
                path.dirname(initialization.databasePath),
                `.${path.basename(initialization.databasePath)}.restore-${operationId}.${retainedArtifact.endsWith('stage') ? 'stage' : 'rollback'}`,
              )
            : path.join(
                path.dirname(initialization.anchorPath),
                `.${path.basename(initialization.anchorPath)}.restore-${operationId}.${retainedArtifact.endsWith('stage') ? 'stage' : 'rollback'}`,
              );
      await writeFile(artifactPath, 'retained');

      await expect(
        verifyCompanionIntegrity({
          databasePath: initialization.databasePath,
          anchorPath: initialization.anchorPath,
          anchorMacKey: initialization.anchorMacKey,
          expectedBudgetKeyHash: initialization.budgetKeyHash,
          expectedCurrencyCode: initialization.budgetCurrencyCode,
        }),
      ).resolves.toEqual({
        schemaVersion: 7,
        writeCapabilityState: 'recovery_required',
      });
    },
  );

  it('rejects positive write generation with disabled state', async () => {
    const migration = await readFile(
      path.join(
        initialization.migrationsDirectory,
        '001-instance-and-principal.sql',
      ),
      'utf8',
    );
    const database = new Database(':memory:');
    try {
      database.exec(migration);
      expect(() =>
        database
          .prepare(
            'INSERT INTO companion_instance (singleton_key, instance_id, budget_key_hash, budget_currency_code, write_capability_state, write_capability_generation, write_capability_event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            'main',
            randomUUID(),
            'c'.repeat(64),
            'USD',
            'disabled',
            1,
            'd'.repeat(64),
            new Date().toISOString(),
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  async function createBackupRequest(): Promise<CompanionBackupRequest> {
    const initialized =
      await initializeCompanionDatabaseAndAnchor(initialization);
    return {
      databasePath: initialization.databasePath,
      anchorPath: initialization.anchorPath,
      anchorMacKey: initialization.anchorMacKey,
      backupPath: path.join(temporaryDirectory, 'companion.backup'),
      encryptionKey: randomBytes(32),
      expectedInstanceId: initialized.instanceId,
      expectedBudgetKeyHash: initialization.budgetKeyHash,
      expectedCurrencyCode: initialization.budgetCurrencyCode,
    };
  }
});
