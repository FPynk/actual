import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  createCompanionOnlyBackup,
  verifyCompanionOnlyBackup,
} from '#database/backup';
import type { CompanionBackupRequest } from '#database/backup';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import type { InitializeCompanionDatabaseRequest } from '#database/migrate';
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

  it('refuses an existing migration-001-only database instead of forward migrating it', async () => {
    const migration = await readFile(
      path.join(
        initialization.migrationsDirectory,
        '001-instance-and-principal.sql',
      ),
      'utf8',
    );
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
          new Date().toISOString(),
          sha256(Buffer.from(migration, 'utf8')),
        );
    } finally {
      database.close();
    }
    await writeFile(initialization.anchorPath, 'existing-anchor');

    await expect(
      initializeCompanionDatabaseAndAnchor(initialization),
    ).rejects.toThrow('migration state is incomplete');
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
        schemaVersion: 2,
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
