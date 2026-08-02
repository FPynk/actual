import { existsSync } from 'node:fs';
import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  createActualApiOwner,
  prepareActualApiOwnerDirectory,
} from '#actual/api-root-owner';
import type { FinanceCompanionConfiguration } from '#config';
import {
  createCompanionOnlyBackup,
  createCompanionOnlyBackupDuringMaintenance,
  restoreCompanionOnlyBackup,
  verifyCompanionOnlyBackup,
} from '#database/backup';
import { openCompanionDatabase } from '#database/connection';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import { initializeCompanionDatabaseAndAnchorDuringMaintenance } from '#database/migrate';
import {
  canonicalExistingRegularFile,
  canonicalUnusedFile,
} from '#database/path-safety';
import { decodeIntegrityMacKey, readIntegrityMacKey } from '#integrity/anchor';
import { verifyCompanionIntegrity } from '#integrity/verify';
import { hashOwnerBootstrapCredential } from '#security/local-security';

type LifecycleCommand =
  | 'db:migrate'
  | 'backup:create'
  | 'backup:verify'
  | 'backup:restore'
  | 'integrity:verify';

export type DatabaseLifecycleTestHooks = Readonly<{
  afterBackupBeforeMigration?: () => void | Promise<void>;
  afterFreshMigrationBeforeOwner?: () => void | Promise<void>;
}>;

export async function runDatabaseLifecycleCommand(
  command: LifecycleCommand,
  configuration: FinanceCompanionConfiguration,
  arguments_: readonly string[],
  testHooks: DatabaseLifecycleTestHooks = {},
): Promise<Readonly<Record<string, unknown>>> {
  const anchorMacKey = await loadAnchorMacKey(configuration);
  try {
    if (command === 'db:migrate') {
      const lockedDatabasePath = existsSync(configuration.databasePath)
        ? await canonicalExistingRegularFile(configuration.databasePath)
        : await canonicalUnusedFile(configuration.databasePath);
      const lockedConfiguration = {
        ...configuration,
        databasePath: lockedDatabasePath,
      };
      return await withExclusiveMaintenanceLock(
        lockedDatabasePath,
        async () => {
          const databaseExists = existsSync(lockedDatabasePath);
          const existingInstanceId = databaseExists
            ? readCompanionInstanceId(lockedDatabasePath)
            : undefined;
          const actualApiOwner = await prepareActualApiOwnerDirectory(
            required(configuration.actualApiDirectory),
            databaseExists,
            existingInstanceId,
            configuration.budgetKeyHash,
          );
          const migrate = async () => {
            const migration =
              await initializeCompanionDatabaseAndAnchorDuringMaintenance({
                databasePath: lockedDatabasePath,
                migrationsDirectory: path.resolve(
                  import.meta.dirname,
                  '../../migrations',
                ),
                anchorPath: configuration.integrityAnchorPath,
                anchorMacKey,
                budgetKeyHash: configuration.budgetKeyHash,
                budgetCurrencyCode: configuration.budgetCurrencyCode,
                createOwnerCredentialHash: () =>
                  hashOwnerBootstrapCredential(
                    configuration.ownerBootstrapCredential,
                    configuration.ownerBootstrapCredentialFile,
                  ),
              });
            if (!actualApiOwner.ownerExists) {
              const freshArtifacts = databaseExists
                ? []
                : await captureFreshArtifacts([
                    lockedDatabasePath,
                    configuration.integrityAnchorPath,
                    `${lockedDatabasePath}-wal`,
                    `${lockedDatabasePath}-shm`,
                    `${lockedDatabasePath}-journal`,
                  ]);
              try {
                if (!databaseExists) {
                  await testHooks.afterFreshMigrationBeforeOwner?.();
                }
                await createActualApiOwner(
                  actualApiOwner.actualApiDirectory,
                  migration.instanceId,
                  configuration.budgetKeyHash,
                  actualApiOwner.directoryIdentity,
                );
              } catch (error) {
                if (!databaseExists) {
                  await removeFreshArtifacts(freshArtifacts);
                }
                throw error;
              }
            }
            return { ok: true, ...migration };
          };
          if (existsSync(lockedDatabasePath)) {
            const backupPath = parseBackupPath(arguments_);
            const encryptionKey = await loadBackupEncryptionKey(configuration);
            try {
              const request = backupRequest(
                lockedConfiguration,
                backupPath,
                encryptionKey,
                anchorMacKey,
              );
              await createCompanionOnlyBackupDuringMaintenance(request);
              await testHooks.afterBackupBeforeMigration?.();
              return await migrate();
            } finally {
              encryptionKey.fill(0);
            }
          }
          if (arguments_.length !== 0) {
            throw new Error(
              'Fresh companion initialization takes no arguments.',
            );
          }
          return await migrate();
        },
      );
    }
    if (command === 'integrity:verify') {
      if (arguments_.length !== 0) {
        throw new Error('Integrity verification takes no arguments.');
      }
      return {
        ok: true,
        ...(await verifyCompanionIntegrity({
          databasePath: configuration.databasePath,
          anchorPath: configuration.integrityAnchorPath,
          anchorMacKey,
          expectedBudgetKeyHash: configuration.budgetKeyHash,
          expectedCurrencyCode: configuration.budgetCurrencyCode,
        })),
      };
    }
    const backupPath = parseBackupPath(arguments_);
    const encryptionKey = await loadBackupEncryptionKey(configuration);
    try {
      const request = backupRequest(
        configuration,
        backupPath,
        encryptionKey,
        anchorMacKey,
      );
      const result =
        command === 'backup:create'
          ? await createCompanionOnlyBackup(request)
          : command === 'backup:verify'
            ? await verifyCompanionOnlyBackup(request)
            : await restoreCompanionOnlyBackup(request);
      return { ok: true, ...result };
    } finally {
      encryptionKey.fill(0);
    }
  } finally {
    anchorMacKey.fill(0);
  }
}

type FreshArtifact = Readonly<{ path: string; identity: string }>;

async function captureFreshArtifacts(
  paths: readonly string[],
): Promise<readonly FreshArtifact[]> {
  const artifacts = await Promise.all(
    paths.map(async artifactPath => {
      try {
        const status = await lstat(artifactPath, { bigint: true });
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new Error('Fresh companion state contains an unsafe artifact.');
        }
        return {
          path: artifactPath,
          identity: `${status.dev}:${status.ino}`,
        };
      } catch (error) {
        if (isMissingPathError(error)) return undefined;
        throw error;
      }
    }),
  );
  return artifacts.filter(
    (artifact): artifact is FreshArtifact => artifact !== undefined,
  );
}

async function removeFreshArtifacts(
  artifacts: readonly FreshArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    try {
      const status = await lstat(artifact.path, { bigint: true });
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        `${status.dev}:${status.ino}` !== artifact.identity
      ) {
        continue;
      }
      await unlink(artifact.path);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

function readCompanionInstanceId(databasePath: string): string {
  const database = openCompanionDatabase(databasePath, true);
  try {
    const instance = database
      .prepare(
        "SELECT instance_id FROM companion_instance WHERE singleton_key = 'main'",
      )
      .get() as Readonly<{ instance_id?: unknown }> | undefined;
    if (instance === undefined || typeof instance.instance_id !== 'string') {
      throw new Error('The companion database is not initialized.');
    }
    return instance.instance_id;
  } finally {
    database.close();
  }
}

function backupRequest(
  configuration: FinanceCompanionConfiguration,
  backupPath: string,
  encryptionKey: Buffer,
  anchorMacKey: Buffer,
) {
  const database = openCompanionDatabase(configuration.databasePath, true);
  try {
    const instance = database
      .prepare(
        'SELECT instance_id FROM companion_instance WHERE singleton_key = ?',
      )
      .get('main') as Readonly<{ instance_id: string }> | undefined;
    if (instance === undefined) {
      throw new Error('The companion database is not initialized.');
    }
    return {
      databasePath: configuration.databasePath,
      backupPath,
      encryptionKey,
      anchorPath: configuration.integrityAnchorPath,
      anchorMacKey,
      expectedInstanceId: instance.instance_id,
      expectedBudgetKeyHash: configuration.budgetKeyHash,
      expectedCurrencyCode: configuration.budgetCurrencyCode,
    };
  } finally {
    database.close();
  }
}

function parseBackupPath(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== '--backup-path' ||
    !arguments_[1]
  ) {
    throw new Error('A backup path is required.');
  }
  return arguments_[1];
}

async function loadAnchorMacKey(
  configuration: FinanceCompanionConfiguration,
): Promise<Buffer> {
  if (configuration.integrityMacKey !== undefined) {
    return decodeIntegrityMacKey(configuration.integrityMacKey);
  }
  if (configuration.integrityMacKeyFile === undefined) {
    throw new Error('The integrity key is invalid.');
  }
  return readIntegrityMacKey(configuration.integrityMacKeyFile);
}

async function loadBackupEncryptionKey(
  configuration: FinanceCompanionConfiguration,
): Promise<Buffer> {
  if (configuration.backupEncryptionKeyFile === undefined) {
    throw new Error('The backup encryption key is required.');
  }
  const key = await readFile(configuration.backupEncryptionKeyFile);
  if (key.length !== 32) {
    key.fill(0);
    throw new Error('The backup encryption key is invalid.');
  }
  return key;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('The Actual API directory is required.');
  }
  return value;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
