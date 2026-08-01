import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FinanceCompanionConfiguration } from '#config';
import { openCompanionDatabase } from '#database/connection';
import { createFinanceCompanionSecurity } from '#security/local-security';
import { createDurableLocalPrincipalRepository } from '#service/durable-principal-repository';

describe('durable local principal repository', () => {
  let temporaryDirectory: string;
  let configuration: FinanceCompanionConfiguration;
  const credential = Buffer.alloc(32, 31).toString('base64url');

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-principal-'),
    );
    const dataDirectory = path.join(temporaryDirectory, 'data');
    await mkdir(dataDirectory);
    const integrityMacKeyFile = path.join(temporaryDirectory, 'integrity.key');
    const integrityMacKey = Buffer.alloc(32, 8).toString('base64url');
    if (process.platform !== 'win32') {
      await writeFile(integrityMacKeyFile, randomBytes(32), { mode: 0o600 });
      await chmod(integrityMacKeyFile, 0o600);
    }
    configuration = {
      bindAddress: '127.0.0.1',
      port: 4100,
      origin: 'http://127.0.0.1:4100',
      dataDirectory,
      databasePath: path.join(dataDirectory, 'companion.sqlite'),
      integrityAnchorPath: path.join(temporaryDirectory, 'integrity.anchor'),
      integrityMacKeyFile:
        process.platform === 'win32' ? undefined : integrityMacKeyFile,
      integrityMacKey:
        process.platform === 'win32' ? integrityMacKey : undefined,
      budgetKeyHash: 'a'.repeat(64),
      budgetCurrencyCode: 'USD',
      ownerBootstrapCredential: credential,
      ownerBootstrapCredentialFile: undefined,
    };
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await expect(access(temporaryDirectory)).rejects.toThrow();
  });

  it('creates, reopens, and persists owner credential rotation', async () => {
    const firstRepository = await createRepository(configuration);
    const firstSecurity = await createFinanceCompanionSecurity({
      localPrincipalRepository: firstRepository,
    });
    const firstLogin = await firstSecurity.login(credential);
    expect(firstLogin).not.toBeNull();
    expect(firstLogin).not.toBe('rate-limited');

    const database = openCompanionDatabase(configuration.databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT credential_hash, rotated_at FROM local_principals')
          .get(),
      ).toEqual({
        credential_hash: expect.stringMatching(/^\$argon2id\$/),
        rotated_at: null,
      });
    } finally {
      database.close();
    }

    const restartedRepository = await createRepository({
      ...configuration,
      ownerBootstrapCredential: undefined,
    });
    const restartedSecurity = await createFinanceCompanionSecurity({
      localPrincipalRepository: restartedRepository,
    });
    expect(await restartedSecurity.login(credential)).not.toBeNull();

    const nextCredential = Buffer.alloc(32, 32).toString('base64url');
    const rotation =
      await restartedSecurity.rotateOwnerCredential(nextCredential);
    expect(rotation).not.toBeNull();

    const rotatedRepository = await createRepository({
      ...configuration,
      ownerBootstrapCredential: undefined,
    });
    const rotatedSecurity = await createFinanceCompanionSecurity({
      localPrincipalRepository: rotatedRepository,
    });
    expect(await rotatedSecurity.login(credential)).toBeNull();
    expect(await rotatedSecurity.login(nextCredential)).not.toBeNull();

    const rotatedDatabase = openCompanionDatabase(
      configuration.databasePath,
      true,
    );
    try {
      expect(
        rotatedDatabase
          .prepare('SELECT rotated_at FROM local_principals')
          .get(),
      ).toEqual({ rotated_at: rotation?.rotatedAt });
    } finally {
      rotatedDatabase.close();
    }
  });

  it('reopens an existing current-schema database without changing its pair', async () => {
    await createRepository(configuration);
    const originalDatabase = await readFile(configuration.databasePath);
    const originalAnchor = await readFile(configuration.integrityAnchorPath);

    await expect(
      createRepository({ ...configuration, ownerBootstrapCredential: undefined }),
    ).resolves.toBeDefined();

    expect(await readFile(configuration.databasePath)).toEqual(originalDatabase);
    expect(await readFile(configuration.integrityAnchorPath)).toEqual(
      originalAnchor,
    );
  });

  it('refuses to start with pending migrations without changing the existing pair', async () => {
    const legacyMigrationsDirectory = path.join(
      temporaryDirectory,
      'legacy-migrations',
    );
    await mkdir(legacyMigrationsDirectory);
    for (const migrationName of [
      '001-instance-and-principal.sql',
      '002-request-replay-and-job-runs.sql',
      '003-source-import-identities.sql',
      '004-review-candidates.sql',
      '005-amazon-enrichment.sql',
      '006-application-receipts-compatibility.sql',
    ]) {
      await copyFile(
        path.resolve(import.meta.dirname, '../../migrations', migrationName),
        path.join(legacyMigrationsDirectory, migrationName),
      );
    }
    await createRepository(configuration, legacyMigrationsDirectory);
    const originalDatabase = await readFile(configuration.databasePath);
    const originalAnchor = await readFile(configuration.integrityAnchorPath);

    await expect(
      createRepository({ ...configuration, ownerBootstrapCredential: undefined }),
    ).rejects.toThrow(
      'Companion database migrations are pending; run db:migrate before starting.',
    );

    expect(await readFile(configuration.databasePath)).toEqual(originalDatabase);
    expect(await readFile(configuration.integrityAnchorPath)).toEqual(
      originalAnchor,
    );
  });

  it('fails closed for a mismatched budget binding', async () => {
    await createRepository(configuration);
    await expect(
      createRepository({ ...configuration, budgetKeyHash: 'b'.repeat(64) }),
    ).rejects.toThrow(
      'Existing companion integrity state is not generation zero.',
    );
  });

  it('fails closed for a mismatched budget currency', async () => {
    await createRepository(configuration);
    await expect(
      createRepository({ ...configuration, budgetCurrencyCode: 'EUR' }),
    ).rejects.toThrow(
      'Existing companion integrity state is not generation zero.',
    );
  });

  it('fails closed for incomplete companion state', async () => {
    await createRepository(configuration);
    await unlink(configuration.integrityAnchorPath);
    await expect(createRepository(configuration)).rejects.toThrow(
      'Companion database and anchor state is incomplete.',
    );
  });

  it('rejects an unreadable integrity key without disclosing its path', async () => {
    if (process.platform === 'win32') return;
    await expect(
      createRepository({
        ...configuration,
        integrityMacKeyFile: path.join(temporaryDirectory, 'missing.key'),
      }),
    ).rejects.toThrow('The integrity key is invalid.');
  });

  it('initializes from the development-only direct integrity key source', async () => {
    const directConfiguration = {
      ...configuration,
      integrityMacKeyFile: undefined,
      integrityMacKey: Buffer.alloc(32, 12).toString('base64url'),
    };
    const repository = await createRepository(directConfiguration);
    const security = await createFinanceCompanionSecurity({
      localPrincipalRepository: repository,
    });
    expect(await security.login(credential)).not.toBeNull();
  });
});

function createRepository(
  configuration: FinanceCompanionConfiguration,
  migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations'),
) {
  return createDurableLocalPrincipalRepository(
    configuration,
    migrationsDirectory,
  );
}
