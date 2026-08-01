import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createCompanionOnlyBackup,
  restoreCompanionOnlyBackup,
  SimulatedRestoreInterruption,
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

  it('initializes migrations 001 through 005, a stable principal, and a generation-zero anchor', async () => {
    const initialized = await initializeCompanionDatabaseAndAnchor(request);
    expect(initialized).toMatchObject({
      schemaVersion: 5,
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
        version: 5,
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
    ).resolves.toEqual({ schemaVersion: 5, writeCapabilityState: 'disabled' });
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
      schemaVersion: 5,
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
      schemaVersion: 5,
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
      schemaVersion: 5,
      budgetKeyHash: request.budgetKeyHash,
    });
    await expect(verifyCompanionOnlyBackup(backup)).resolves.toMatchObject({
      schemaVersion: 5,
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
      schemaVersion: 5,
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
    ).resolves.toEqual({ schemaVersion: 5, writeCapabilityState: 'disabled' });
    expect((await readFile(backup.backupPath)).length).toBeGreaterThan(0);
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
});
