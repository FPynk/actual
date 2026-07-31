import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createCompanionOnlyBackup,
  restoreCompanionOnlyBackup,
  verifyCompanionOnlyBackup,
} from '#database/backup';
import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { readIntegrityAnchor, writeIntegrityAnchor } from '#integrity/anchor';
import { verifyCompanionIntegrity } from '#integrity/verify';

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

  it('initializes migration 001, a stable principal, and a generation-zero anchor', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    expect(initialized).toMatchObject({
      schemaVersion: 1,
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
          .prepare('SELECT version, checksum FROM schema_migrations')
          .get(),
      ).toMatchObject({
        version: 1,
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
    ).resolves.toEqual({ schemaVersion: 1, writeCapabilityState: 'disabled' });
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
      schemaVersion: 1,
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
      schemaVersion: 1,
      writeCapabilityState: 'recovery_required',
    });
  });

  it('creates and verifies a backup while restore activation remains gated', async () => {
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
      schemaVersion: 1,
      budgetKeyHash: request.budgetKeyHash,
    });
    await expect(verifyCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(restoreCompanionOnlyBackup(backup)).rejects.toThrow(
      'explicit destructive-capability authorization',
    );
    expect((await readFile(backup.backupPath)).length).toBeGreaterThan(0);
  });
});
