import { randomBytes, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, get } from 'node:http';
import path from 'node:path';

import { createActualAdapter } from '#actual/adapter';
import type { ActualAdapter } from '#actual/adapter';
import { canonicalJson } from '#actual/canonical-json';
import { createForkedAdapterWorkerRunner } from '#actual/forked-worker-runner';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createFinanceCompanionHttpApplication } from '#http/server';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';
import {
  createSqliteBankSyncJobRepository,
  runOneShotBankSyncJob,
} from '#service/bank-sync';
import { createSqliteRequestReplayRepository } from '#service/request-replay-repository';

const CONTAINER_UID = 10001;
const CONTAINER_GID = 10001;
const budgetKeyHash = 'a'.repeat(64);
const companionInstanceId = '11111111-1111-4111-8111-111111111111';

export type ContainerReadinessSmokeResult = Readonly<{
  ok: true;
  checks: readonly [
    'non-root-volumes',
    'migration-fixture',
    'mocked-job',
    'worker-quarantine',
    'adapter-readiness',
    'graceful-shutdown',
  ];
}>;

export async function runContainerReadinessSmoke(): Promise<ContainerReadinessSmokeResult> {
  assertContainerIdentity();
  const actualApiDirectory = await verifyOwnedWritableDirectory('/actual-api');
  const dataDirectory = await verifyOwnedWritableDirectory('/data');
  const anchorDirectory =
    await verifyOwnedWritableDirectory('/integrity-anchor');
  await verifyOwnedWritableDirectory('/tmp');
  if (
    actualApiDirectory === dataDirectory ||
    actualApiDirectory === anchorDirectory ||
    dataDirectory === anchorDirectory
  ) {
    throw new Error('The durable container mounts must be distinct.');
  }

  const fixtureId = randomUUID();
  const dataFixtureDirectory = path.join(
    dataDirectory,
    `.container-smoke-${fixtureId}`,
  );
  const anchorFixtureDirectory = path.join(
    anchorDirectory,
    `.container-smoke-${fixtureId}`,
  );
  const actualApiFixtureDirectory = path.join(
    actualApiDirectory,
    `.container-smoke-${fixtureId}`,
  );
  await mkdir(dataFixtureDirectory, { mode: 0o700 });
  await mkdir(anchorFixtureDirectory, { mode: 0o700 });
  await mkdir(actualApiFixtureDirectory, { mode: 0o700 });
  try {
    const databasePath = path.join(dataFixtureDirectory, 'companion.sqlite');
    const anchorPath = path.join(anchorFixtureDirectory, 'anchor.json');
    const anchorMacKey = randomBytes(32);
    try {
      await initializeCompanionDatabaseAndAnchor({
        databasePath,
        migrationsDirectory: path.resolve(
          import.meta.dirname,
          '../../migrations',
        ),
        anchorPath,
        anchorMacKey,
        budgetKeyHash,
        budgetCurrencyCode: 'USD',
        createOwnerCredentialHash: async () => 'container-smoke-owner-hash',
      });
      await runMockedBankSyncJob(databasePath);
      const adapterConfiguration = createReadinessAdapterConfiguration(
        actualApiFixtureDirectory,
      );
      await requireWorkerQuarantine(adapterConfiguration);
      await requireAdapterReadinessFailure(databasePath, adapterConfiguration);
    } finally {
      anchorMacKey.fill(0);
    }
  } finally {
    await rm(dataFixtureDirectory, { recursive: true, force: true });
    await rm(anchorFixtureDirectory, { recursive: true, force: true });
    await rm(actualApiFixtureDirectory, { recursive: true, force: true });
  }
  return {
    ok: true,
    checks: [
      'non-root-volumes',
      'migration-fixture',
      'mocked-job',
      'worker-quarantine',
      'adapter-readiness',
      'graceful-shutdown',
    ],
  };
}

function assertContainerIdentity(): void {
  if (
    process.platform !== 'linux' ||
    process.getuid?.() !== CONTAINER_UID ||
    process.getgid?.() !== CONTAINER_GID
  ) {
    throw new Error(
      'The readiness smoke requires the fixed non-root UID and GID.',
    );
  }
}

async function verifyOwnedWritableDirectory(
  directory: string,
): Promise<string> {
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`The required directory is invalid: ${directory}.`);
  }
  const ownership = await stat(directory);
  if (ownership.uid !== CONTAINER_UID || ownership.gid !== CONTAINER_GID) {
    throw new Error(
      `The required directory is not owned by the service identity: ${directory}.`,
    );
  }
  await access(directory);
  const probe = path.join(directory, `.container-readiness-${randomUUID()}`);
  await writeFile(probe, 'ok', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rm(probe, { force: true });
  return path.resolve(directory);
}

async function runMockedBankSyncJob(databasePath: string): Promise<void> {
  const summary = await runOneShotBankSyncJob(
    {
      accountIds: null,
      idempotencyKey: 'container-readiness-mocked-job',
      invocationKind: 'scheduler',
      principalId: '22222222-2222-4222-8222-222222222222',
    },
    {
      adapter: {
        execute: async request => {
          if (request.kind === 'read-budget-snapshot') {
            return {
              kind: 'read-budget-snapshot',
              snapshot: {
                accounts: [
                  {
                    closed: false,
                    id: 'mocked-account',
                    lastSync: null,
                    name: 'Mocked account',
                    offBudget: false,
                    syncSource: 'simpleFin',
                    syncStatus: null,
                  },
                ],
                budget: {
                  budgetKeyHash,
                  capturedAt: '2026-07-31T12:00:00.000Z',
                  currencyCode: 'USD',
                },
                contractVersion: 1,
              },
            };
          }
          if (request.kind === 'run-account-bank-sync') {
            return {
              kind: 'run-account-bank-sync',
              result: {
                accountId: request.accountId,
                completedAt: '2026-07-31T12:00:01.000Z',
                contractVersion: 1,
                finalSyncCode: 'succeeded',
                outcomeCode: 'succeeded',
                startedAt: '2026-07-31T12:00:00.000Z',
                transactionCounts: null,
              },
            };
          }
          throw new Error('The mocked job received an unsupported request.');
        },
      },
      budgetKeyHash,
      repository: createSqliteBankSyncJobRepository(databasePath),
    },
  );
  if (summary.status !== 'succeeded') {
    throw new Error('The mocked bank-sync job did not succeed.');
  }
}

async function requireWorkerQuarantine(
  configuration: ReturnType<typeof createReadinessAdapterConfiguration>,
): Promise<void> {
  await writeFile(
    path.join(configuration.actualApiDirectory, 'owner.json'),
    canonicalJson({
      budgetBindingHash: budgetKeyHash,
      companionInstanceId,
      directoryNonce: configuration.actualApiDirectoryNonce,
      formatVersion: 1,
    }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const workerEntry = new URL(
    import.meta.url.endsWith('.ts')
      ? './readiness-hanging-worker.ts'
      : './readiness-hanging-worker.js',
    import.meta.url,
  );
  const adapter = createActualAdapter(
    configuration,
    createForkedAdapterWorkerRunner(configuration, workerEntry),
  );
  await expectTimeout(
    adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
  );
  if (adapter.getHealth() !== 'degraded') {
    throw new Error('The terminated worker did not degrade adapter health.');
  }
  const quarantine = await readdir(
    path.join(configuration.actualApiDirectory, 'quarantine'),
  );
  if (quarantine.length !== 1) {
    throw new Error('The terminated worker operation was not quarantined.');
  }
}

function createReadinessAdapterConfiguration(actualApiDirectory: string) {
  const actualApiDirectoryNonce = randomBytes(32).toString('base64url');
  return {
    actualApiDirectory,
    actualApiDirectoryNonce,
    actualBudgetCurrency: 'USD',
    actualBudgetId: 'container-smoke-budget',
    actualPassword: 'synthetic-only',
    actualServerUrl: 'http://127.0.0.1:5999',
    budgetBindingHash: budgetKeyHash,
    companionInstanceId,
    hardTimeoutMilliseconds: 60,
    serviceInstanceNonce: randomBytes(32).toString('base64url'),
    softTimeoutMilliseconds: 10,
    workerExitTimeoutMilliseconds: 100,
  } as const;
}

async function requireAdapterReadinessFailure(
  databasePath: string,
  adapterConfiguration: ReturnType<typeof createReadinessAdapterConfiguration>,
): Promise<void> {
  const configuration = {
    ...adapterConfiguration,
    hardTimeoutMilliseconds: 20,
    softTimeoutMilliseconds: 5,
    workerExitTimeoutMilliseconds: 20,
  };
  const adapter = createActualAdapter(
    configuration,
    async () => new Promise(() => undefined),
  );
  await expectAdapterUnhealthy(
    adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
  );
  if (adapter.getHealth() !== 'unhealthy') {
    throw new Error('The unproven worker exit did not fail-stop the adapter.');
  }
  await requireGracefulShutdown(databasePath, adapter);
}

async function expectAdapterUnhealthy(
  operation: Promise<unknown>,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'adapter_unhealthy'
    ) {
      return;
    }
  }
  throw new Error('The synthetic worker did not fail-stop the adapter.');
}

async function requireGracefulShutdown(
  databasePath: string,
  healthDependency: Pick<ActualAdapter, 'getHealth'>,
): Promise<void> {
  const security = await createFinanceCompanionSecurity({
    bootstrapCredential: randomBytes(32).toString('base64url'),
    localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
  });
  const server = createServer(
    createFinanceCompanionHttpApplication(
      {
        bindAddress: '127.0.0.1',
        budgetKeyHash,
        budgetCurrencyCode: 'USD',
        origin: 'http://127.0.0.1:4100',
        port: 4100,
      },
      path.resolve(import.meta.dirname, '../ui'),
      security,
      createSqliteRequestReplayRepository(databasePath),
      undefined,
      undefined,
      healthDependency,
    ),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4100, '127.0.0.1', () => resolve());
  });
  try {
    const health = await readHealth();
    if (
      health.statusCode !== 503 ||
      health.body !== '{"status":"not-healthy","version":"0.0.1"}'
    ) {
      throw new Error(
        'Terminal adapter failure did not fail container readiness.',
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function expectTimeout(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'adapter_timeout'
    ) {
      return;
    }
  }
  throw new Error('The synthetic worker did not reach its hard deadline.');
}

function readHealth(): Promise<Readonly<{ statusCode: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const request = get('http://127.0.0.1:4100/health', response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ statusCode: response.statusCode ?? 0, body }),
      );
    });
    request.once('error', reject);
  });
}
