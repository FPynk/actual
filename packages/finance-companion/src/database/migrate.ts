import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createGenerationZeroAnchor,
  readIntegrityAnchor,
  writeNewIntegrityAnchor,
} from '#integrity/anchor';
import { sha256 } from '#integrity/canonical-hash';

import { openCompanionDatabase, verifySqliteDatabase } from './connection.ts';
import type { CompanionDatabase } from './connection.ts';
import { withExclusiveMaintenanceLock } from './maintenance-lock.ts';
import {
  assertDistinctExistingFiles,
  assertDistinctPaths,
  assertNoSqliteSidecars,
  canonicalExistingRegularFile,
  canonicalUnusedFile,
} from './path-safety.ts';

type Migration = Readonly<{
  version: number;
  name: string;
  sql: string;
  checksum: string;
}>;

export type InitializeCompanionDatabaseRequest = Readonly<{
  databasePath: string;
  migrationsDirectory: string;
  anchorPath: string;
  anchorMacKey: Buffer;
  budgetKeyHash: string;
  budgetCurrencyCode: string;
  createOwnerCredentialHash: () => Promise<string>;
}>;

export type MigrationResult = Readonly<{
  schemaVersion: number;
  instanceId: string;
  writeCapabilityState: 'disabled' | 'enabled' | 'recovery_required';
}>;

export async function initializeCompanionDatabase(
  request: InitializeCompanionDatabaseRequest,
): Promise<MigrationResult> {
  return initializeCompanionDatabaseAndAnchor(request);
}

export async function initializeCompanionDatabaseAndAnchor(
  request: InitializeCompanionDatabaseRequest,
): Promise<MigrationResult> {
  const migrations = await loadMigrations(request.migrationsDirectory);
  const initialPaths = await inspectInitializationPaths(request);
  return withExclusiveMaintenanceLock(initialPaths.databasePath, async () => {
    const paths = await inspectInitializationPaths(request);
    if (
      paths.databaseExists !== initialPaths.databaseExists ||
      paths.anchorExists !== initialPaths.anchorExists
    ) {
      throw new Error(
        'Companion initialization paths changed during maintenance.',
      );
    }
    if (paths.databaseExists !== paths.anchorExists) {
      throw new Error('Companion database and anchor state is incomplete.');
    }
    await assertNoSqliteSidecars(paths.databasePath);
    if (paths.databaseExists) {
      const database = openCompanionDatabase(paths.databasePath, true);
      try {
        verifyAppliedMigrationHistory(database, migrations);
        await verifyExistingGenerationZeroState(
          database,
          paths.anchorPath,
          request,
        );
        applyVerifiedMigrations(database, migrations);
        verifySqliteDatabase(database);
        return initializeOrReadInstance(database, request);
      } finally {
        database.close();
      }
    }
    const ownerCredentialHash = await request.createOwnerCredentialHash();
    if (ownerCredentialHash.length === 0) {
      throw new Error('An owner credential must be configured before startup.');
    }
    const database = openCompanionDatabase(paths.databasePath);
    try {
      const result = applyInitialMigrationsAndInitialize(database, migrations, {
        ...request,
        ownerCredentialHash,
      });
      await writeNewIntegrityAnchor(
        paths.anchorPath,
        createGenerationZeroAnchor(request.budgetKeyHash),
        request.anchorMacKey,
      );
      return result;
    } finally {
      database.close();
    }
  });
}

function applyInitialMigrationsAndInitialize(
  database: CompanionDatabase,
  migrations: readonly Migration[],
  request: InitializeCompanionDatabaseRequest &
    Readonly<{ ownerCredentialHash: string }>,
): MigrationResult {
  return database
    .transaction(() => {
      const firstMigration = migrations[0];
      if (firstMigration === undefined || firstMigration.version !== 1) {
        throw new Error('Companion initialization requires migration 001.');
      }
      applyMigration(database, firstMigration);
      const result = initializeOrReadInstance(database, request);
      for (const migration of migrations.slice(1)) {
        applyMigration(database, migration);
      }
      verifySqliteDatabase(database);
      return { ...result, schemaVersion: schemaVersion(database) };
    })
    .immediate();
}

export async function loadMigrations(
  migrationsDirectory: string,
): Promise<readonly Migration[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = await Promise.all(
    entries
      .filter(entry => entry.isFile())
      .map(async entry => {
        const match = /^(\d{3})-([a-z0-9-]+)\.sql$/.exec(entry.name);
        if (match === null) {
          throw new Error('The migration directory contains an invalid file.');
        }
        const sql = await readFile(
          path.join(migrationsDirectory, entry.name),
          'utf8',
        );
        return {
          version: Number(match[1]),
          name: entry.name,
          sql,
          checksum: sha256(Buffer.from(sql, 'utf8')),
        };
      }),
  );
  migrations.sort((left, right) => left.version - right.version);
  if (
    migrations.length === 0 ||
    migrations.some((migration, index) => migration.version !== index + 1)
  ) {
    throw new Error(
      'Companion migrations must be contiguous and start at 001.',
    );
  }
  return migrations;
}

function applyVerifiedMigrations(
  database: CompanionDatabase,
  migrations: readonly Migration[],
): void {
  const appliedVersions = verifyAppliedMigrationHistory(database, migrations);
  database
    .transaction(() => {
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue;
        applyMigration(database, migration);
      }
      verifySqliteDatabase(database);
    })
    .immediate();
}

function applyMigration(
  database: CompanionDatabase,
  migration: Migration,
): void {
  database.exec(migration.sql);
  database
    .prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
    )
    .run(
      migration.version,
      migration.name,
      new Date().toISOString(),
      migration.checksum,
    );
}

function verifyAppliedMigrationHistory(
  database: CompanionDatabase,
  migrations: readonly Migration[],
): ReadonlySet<number> {
  const hasMigrationTable = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (hasMigrationTable) {
    const applied = database
      .prepare(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
      .all() as readonly Readonly<{
      version: number;
      name: string;
      checksum: string;
    }>[];
    for (const [index, row] of applied.entries()) {
      if (row.version !== index + 1) {
        throw new Error('The applied migration history is not contiguous.');
      }
      const migration = migrations.find(
        candidate => candidate.version === row.version,
      );
      if (
        migration === undefined ||
        migration.name !== row.name ||
        migration.checksum !== row.checksum
      ) {
        throw new Error('The applied migration history is not verified.');
      }
    }
    if (applied.length > migrations.length) {
      throw new Error('The companion database is newer than this executable.');
    }
  }
  return new Set(
    hasMigrationTable
      ? (
          database
            .prepare('SELECT version FROM schema_migrations')
            .all() as readonly Readonly<{ version: number }>[]
        ).map(row => row.version)
      : [],
  );
}

async function inspectInitializationPaths(
  request: InitializeCompanionDatabaseRequest,
): Promise<
  Readonly<{
    databasePath: string;
    databaseExists: boolean;
    anchorPath: string;
    anchorExists: boolean;
  }>
> {
  const database = await inspectFilePath(request.databasePath);
  const anchor = await inspectFilePath(request.anchorPath);
  assertDistinctPaths([database.path, anchor.path]);
  if (database.exists && anchor.exists) {
    await assertDistinctExistingFiles([database.path, anchor.path]);
  }
  return {
    databasePath: database.path,
    databaseExists: database.exists,
    anchorPath: anchor.path,
    anchorExists: anchor.exists,
  };
}

async function inspectFilePath(
  filePath: string,
): Promise<Readonly<{ path: string; exists: boolean }>> {
  try {
    return { path: await canonicalExistingRegularFile(filePath), exists: true };
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return { path: await canonicalUnusedFile(filePath), exists: false };
  }
}

async function verifyExistingGenerationZeroState(
  database: CompanionDatabase,
  anchorPath: string,
  request: InitializeCompanionDatabaseRequest,
): Promise<void> {
  try {
    verifySqliteDatabase(database);
    const instance = database
      .prepare(
        'SELECT instance_id, budget_key_hash, budget_currency_code, write_capability_state, write_capability_generation, write_capability_event_hash FROM companion_instance WHERE singleton_key = ?',
      )
      .get('main') as
      | Readonly<{
          instance_id: string;
          budget_key_hash: string;
          budget_currency_code: string;
          write_capability_state: string;
          write_capability_generation: number;
          write_capability_event_hash: string | null;
        }>
      | undefined;
    const eventCount = (
      database
        .prepare('SELECT COUNT(*) AS count FROM write_capability_events')
        .get() as Readonly<{ count: number }>
    ).count;
    const principalCount = (
      database
        .prepare('SELECT COUNT(*) AS count FROM local_principals')
        .get() as Readonly<{ count: number }>
    ).count;
    const anchor = await readIntegrityAnchor(anchorPath, request.anchorMacKey);
    if (
      instance === undefined ||
      instance.budget_key_hash !== request.budgetKeyHash ||
      instance.budget_currency_code !== request.budgetCurrencyCode ||
      instance.write_capability_state !== 'disabled' ||
      instance.write_capability_generation !== 0 ||
      instance.write_capability_event_hash !== null ||
      eventCount !== 0 ||
      principalCount !== 1 ||
      anchor.budgetKeyHash !== request.budgetKeyHash ||
      anchor.writeCapabilityGeneration !== 0 ||
      anchor.writeCapabilityEventHash !== null ||
      anchor.highestIssuedIntentSequence !== 0 ||
      anchor.highestIssuedIntentHash !== null ||
      anchor.highestAppliedReceiptSequence !== 0 ||
      anchor.highestAppliedReceiptHash !== null ||
      anchor.lastVerifiedPairedBackupManifestHash !== null
    ) {
      throw new Error(
        'Existing companion integrity state is not generation zero.',
      );
    }
  } catch (error) {
    try {
      database
        .prepare(
          "UPDATE companion_instance SET write_capability_state = 'recovery_required' WHERE singleton_key = 'main'",
        )
        .run();
    } catch {
      // An unreadable partial database is already fail-closed.
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function initializeOrReadInstance(
  database: CompanionDatabase,
  request: InitializeCompanionDatabaseRequest &
    Readonly<{ ownerCredentialHash?: string }>,
): MigrationResult {
  const existing = database
    .prepare(
      'SELECT instance_id, budget_key_hash, budget_currency_code, write_capability_state FROM companion_instance WHERE singleton_key = ?',
    )
    .get('main') as
    | Readonly<{
        instance_id: string;
        budget_key_hash: string;
        budget_currency_code: string;
        write_capability_state: MigrationResult['writeCapabilityState'];
      }>
    | undefined;
  if (existing !== undefined) {
    if (
      existing.budget_key_hash !== request.budgetKeyHash ||
      existing.budget_currency_code !== request.budgetCurrencyCode
    ) {
      throw new Error(
        'The configured budget binding does not match this companion database.',
      );
    }
    return {
      schemaVersion: schemaVersion(database),
      instanceId: existing.instance_id,
      writeCapabilityState: existing.write_capability_state,
    };
  }
  const instanceId = randomUUID();
  const principalId = randomUUID();
  if (request.ownerCredentialHash === undefined) {
    throw new Error('An owner credential must be configured before startup.');
  }
  const createdAt = new Date().toISOString();
  database
    .prepare(
      'INSERT INTO companion_instance (singleton_key, instance_id, budget_key_hash, budget_currency_code, write_capability_state, write_capability_generation, write_capability_event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'main',
      instanceId,
      request.budgetKeyHash,
      request.budgetCurrencyCode,
      'disabled',
      0,
      null,
      createdAt,
    );
  database
    .prepare(
      'INSERT INTO local_principals (id, credential_hash, created_at, rotated_at) VALUES (?, ?, ?, ?)',
    )
    .run(principalId, request.ownerCredentialHash, createdAt, null);
  return {
    schemaVersion: schemaVersion(database),
    instanceId,
    writeCapabilityState: 'disabled',
  };
}

function schemaVersion(database: CompanionDatabase): number {
  const row = database
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as Readonly<{ version: number }>;
  return row.version;
}
