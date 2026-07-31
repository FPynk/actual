import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import { runFinanceCompanionCommand } from '#cli';
import { ActualAdapterError } from '#contracts/adapter';
import type { AccountBankSyncOutcomeCode } from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import {
  bankSyncExitCode,
  BankSyncJobError,
  createSqliteBankSyncJobRepository,
  runOneShotBankSyncJob,
} from '#service/bank-sync';
import type {
  BankSyncJobDependencies,
  BankSyncJobSummary,
} from '#service/bank-sync';

const principalId = '11111111-1111-4111-8111-111111111111';
const budgetKeyHash = 'a'.repeat(64);

describe('FIN-29 scheduled bank-sync reliability', () => {
  let temporaryDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'finance-companion-scheduler-reliability-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    const database = openCompanionDatabase(databasePath);
    try {
      database.exec(
        await readFile(migrationPath('001-instance-and-principal.sql'), 'utf8'),
      );
      database.exec(
        await readFile(
          migrationPath('002-request-replay-and-job-runs.sql'),
          'utf8',
        ),
      );
      database
        .prepare(
          'INSERT INTO local_principals (id, credential_hash, created_at, rotated_at) VALUES (?, ?, ?, ?)',
        )
        .run(principalId, 'hash', timestamp(0), null);
    } finally {
      database.close();
    }
  });

  afterEach(async () =>
    rm(temporaryDirectory, { recursive: true, force: true }),
  );

  it.each([
    ['succeeded', false, 0],
    ['skipped', false, 0],
    ['partial', false, 1],
    ['failed', false, 70],
    ['failed', true, 75],
    ['outcome_unknown', false, 76],
    ['canceled', true, 130],
  ] as const)(
    '%s with retryable=%s exits %i after writing one summary',
    async (status, retryable, expectedExitCode) => {
      const standardOutput: string[] = [];
      const standardError: string[] = [];
      const summary = summaryFor(status, retryable);

      const exitCode = await runFinanceCompanionCommand(
        'job:bank-sync',
        message => standardOutput.push(message),
        message => standardError.push(message),
        undefined,
        undefined,
        undefined,
        ['--scheduler', '--idempotency-key', 'scheduler-reliability-key'],
        async () => summary,
      );

      expect(exitCode).toBe(expectedExitCode);
      expect(bankSyncExitCode(summary)).toBe(expectedExitCode);
      expect(standardOutput).toEqual([`${JSON.stringify(summary)}\n`]);
      expect(standardError).toEqual([]);
    },
  );

  it.each([
    ['succeeded', 'succeeded', 'succeeded', false, 0],
    ['authentication-required', 'succeeded', 'failed', false, 70],
    ['rate-limited', 'succeeded', 'failed', true, 75],
    ['timed-out', 'succeeded', 'failed', true, 75],
    ['configuration-error', 'succeeded', 'failed', false, 70],
    ['provider-error', 'succeeded', 'failed', true, 75],
    ['succeeded', 'failed', 'failed', false, 70],
  ] as const)(
    '%s with final sync %s is %s (retryable=%s, exit %i)',
    async (
      adapterOutcome,
      finalSyncCode,
      expectedStatus,
      expectedRetryable,
      expectedExitCode,
    ) => {
      const summary = await runScheduledJob(
        databasePath,
        syntheticAdapter([syntheticAccount('opaque-account-a')], request =>
          request.kind === 'run-account-bank-sync'
            ? bankSyncResponse(request.accountId, adapterOutcome, finalSyncCode)
            : successfulResponse(request),
        ),
        `scheduler-matrix-${adapterOutcome}-${finalSyncCode}`,
      );

      expect(summary.accountResults).toEqual([
        {
          accountId: 'opaque-account-a',
          outcomeCode:
            finalSyncCode === 'failed' ? 'final-sync-failed' : adapterOutcome,
          transactionCounts: null,
        },
      ]);
      expect(summary.status).toBe(expectedStatus);
      expect(summary.retryable).toBe(expectedRetryable);
      expect(bankSyncExitCode(summary)).toBe(expectedExitCode);
    },
  );

  it('maps scheduler configuration and unavailable-operation failures to their documented exits', async () => {
    await expect(
      commandExitFor(new BankSyncJobError('invalid_request')),
    ).resolves.toEqual({
      exitCode: 64,
      standardError: ['{"code":"invalid_request","ok":false}\n'],
    });
    await expect(
      commandExitFor(new BankSyncJobError('adapter_unavailable')),
    ).resolves.toEqual({
      exitCode: 69,
      standardError: ['{"code":"adapter_unavailable","ok":false}\n'],
    });
    await expect(
      commandExitFor(new BankSyncJobError('operation_in_progress')),
    ).resolves.toEqual({
      exitCode: 69,
      standardError: ['{"code":"operation_in_progress","ok":false}\n'],
    });
  });

  it('reports an unknown outcome, stops later accounts, and disables automatic retry', async () => {
    const accountSyncCalls: string[] = [];
    const summary = await runScheduledJob(
      databasePath,
      syntheticAdapter(
        [
          syntheticAccount('opaque-account-a'),
          syntheticAccount('opaque-account-b'),
        ],
        request => {
          if (request.kind === 'run-account-bank-sync') {
            accountSyncCalls.push(request.accountId);
            throw new ActualAdapterError('adapter_timeout');
          }
          return successfulResponse(request);
        },
      ),
      'unknown-outcome-scheduler-key',
    );

    expect(accountSyncCalls).toEqual(['opaque-account-a']);
    expect(summary.accountResults).toEqual([
      {
        accountId: 'opaque-account-a',
        outcomeCode: 'outcome-unknown',
        transactionCounts: null,
      },
      {
        accountId: 'opaque-account-b',
        outcomeCode: 'skipped',
        transactionCounts: null,
      },
    ]);
    expect(summary.status).toBe('outcome_unknown');
    expect(summary.retryable).toBe(false);
    expect(bankSyncExitCode(summary)).toBe(76);
  });

  it('returns an exact replay without another snapshot or account sync', async () => {
    let snapshotCount = 0;
    let accountSyncCount = 0;
    const adapter = syntheticAdapter(
      [syntheticAccount('opaque-account-a')],
      request => {
        if (request.kind === 'read-budget-snapshot') snapshotCount += 1;
        if (request.kind === 'run-account-bank-sync') accountSyncCount += 1;
        return successfulResponse(request);
      },
    );

    const first = await runScheduledJob(databasePath, adapter);
    const replay = await runScheduledJob(databasePath, adapter);

    expect(replay).toEqual(first);
    expect(snapshotCount).toBe(1);
    expect(accountSyncCount).toBe(1);
  });

  it('rejects an overlapping exact run and later replays its durable result', async () => {
    const firstAccountSyncStarted = deferred<void>();
    const releaseFirstAccountSync = deferred<void>();
    let snapshotCount = 0;
    let accountSyncCount = 0;
    const adapter = syntheticAdapter(
      [syntheticAccount('opaque-account-a')],
      async request => {
        if (request.kind === 'read-budget-snapshot') {
          snapshotCount += 1;
          return successfulResponse(request);
        }
        accountSyncCount += 1;
        firstAccountSyncStarted.resolve();
        await releaseFirstAccountSync.promise;
        return successfulResponse(request);
      },
    );

    const firstRun = runScheduledJob(databasePath, adapter);
    await firstAccountSyncStarted.promise;

    await expect(runScheduledJob(databasePath, adapter)).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
    expect(snapshotCount).toBe(1);
    expect(accountSyncCount).toBe(1);

    releaseFirstAccountSync.resolve();
    const completed = await firstRun;
    const replay = await runScheduledJob(databasePath, adapter);

    expect(replay).toEqual(completed);
    expect(snapshotCount).toBe(1);
    expect(accountSyncCount).toBe(1);
  });

  it('refuses a different-key overlapping run before another adapter call', async () => {
    const firstAccountSyncStarted = deferred<void>();
    const releaseFirstAccountSync = deferred<void>();
    const calls: string[] = [];
    let accountSyncCount = 0;
    const serializedAdapter = serializingSyntheticAdapter(
      [syntheticAccount('opaque-account-a')],
      async request => {
        calls.push(request.kind);
        if (request.kind === 'read-budget-snapshot') {
          return successfulResponse(request);
        }
        accountSyncCount += 1;
        if (accountSyncCount === 1) {
          firstAccountSyncStarted.resolve();
          await releaseFirstAccountSync.promise;
        }
        return successfulResponse(request);
      },
    );

    const firstRun = runScheduledJob(databasePath, serializedAdapter.adapter);
    await firstAccountSyncStarted.promise;
    await expect(
      runScheduledJob(
        databasePath,
        serializedAdapter.adapter,
        'another-scheduler-reliability-key',
      ),
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });

    await Promise.resolve();
    expect(calls).toEqual(['read-budget-snapshot', 'run-account-bank-sync']);
    expect(serializedAdapter.maximumConcurrentOperations).toBe(1);

    releaseFirstAccountSync.resolve();
    await expect(firstRun).resolves.toMatchObject({ status: 'succeeded' });
    expect(calls).toEqual(['read-budget-snapshot', 'run-account-bank-sync']);
    expect(serializedAdapter.maximumConcurrentOperations).toBe(1);
  });

  it('keeps synthetic account names out of scheduler logs', async () => {
    const logs: unknown[] = [];
    await runScheduledJob(
      databasePath,
      syntheticAdapter(
        [
          syntheticAccount('opaque-account-a', {
            name: 'private synthetic account name',
          }),
        ],
        successfulResponse,
      ),
      undefined,
      event => logs.push(event),
    );

    expect(JSON.stringify(logs)).not.toContain('private synthetic');
  });
});

async function commandExitFor(error: BankSyncJobError): Promise<
  Readonly<{
    exitCode: number;
    standardError: readonly string[];
  }>
> {
  const standardError: string[] = [];
  const exitCode = await runFinanceCompanionCommand(
    'job:bank-sync',
    () => undefined,
    message => standardError.push(message),
    undefined,
    undefined,
    undefined,
    ['--scheduler', '--idempotency-key', 'scheduler-reliability-key'],
    async () => {
      throw error;
    },
  );
  return { exitCode, standardError };
}

function runScheduledJob(
  databasePath: string,
  adapter: Pick<ActualAdapter, 'execute'>,
  idempotencyKey = 'scheduler-reliability-key',
  log?: BankSyncJobDependencies['log'],
) {
  return runOneShotBankSyncJob(
    {
      accountIds: null,
      idempotencyKey,
      invocationKind: 'scheduler',
      principalId,
    },
    {
      adapter,
      budgetKeyHash,
      log,
      now: clock(),
      repository: createSqliteBankSyncJobRepository(databasePath),
    },
  );
}

function syntheticAdapter(
  accounts: readonly ReturnType<typeof syntheticAccount>[],
  respond: (
    request: Parameters<ActualAdapter['execute']>[0],
  ) =>
    | Awaited<ReturnType<ActualAdapter['execute']>>
    | Promise<Awaited<ReturnType<ActualAdapter['execute']>>>,
): Pick<ActualAdapter, 'execute'> {
  return {
    execute: async request => {
      if (request.kind === 'read-budget-snapshot') {
        await respond(request);
        return {
          kind: request.kind,
          snapshot: {
            accounts,
            budget: {
              budgetKeyHash,
              capturedAt: timestamp(0),
              currencyCode: 'USD',
            },
            contractVersion: 1,
          },
        };
      }
      return respond(request);
    },
  };
}

function serializingSyntheticAdapter(
  accounts: readonly ReturnType<typeof syntheticAccount>[],
  respond: (
    request: Parameters<ActualAdapter['execute']>[0],
  ) =>
    | Awaited<ReturnType<ActualAdapter['execute']>>
    | Promise<Awaited<ReturnType<ActualAdapter['execute']>>>,
): Readonly<{
  adapter: Pick<ActualAdapter, 'execute'>;
  readonly maximumConcurrentOperations: number;
}> {
  let nextOperation = Promise.resolve();
  let activeOperations = 0;
  let maximumConcurrentOperations = 0;

  return {
    adapter: {
      execute: async request => {
        const previousOperation = nextOperation;
        const releaseOperation = deferred<void>();
        nextOperation = releaseOperation.promise;
        await previousOperation;
        activeOperations += 1;
        maximumConcurrentOperations = Math.max(
          maximumConcurrentOperations,
          activeOperations,
        );
        try {
          if (request.kind === 'read-budget-snapshot') {
            await respond(request);
            return {
              kind: request.kind,
              snapshot: {
                accounts,
                budget: {
                  budgetKeyHash,
                  capturedAt: timestamp(0),
                  currencyCode: 'USD',
                },
                contractVersion: 1,
              },
            };
          }
          return await respond(request);
        } finally {
          activeOperations -= 1;
          releaseOperation.resolve();
        }
      },
    },
    get maximumConcurrentOperations() {
      return maximumConcurrentOperations;
    },
  };
}

function successfulResponse(request: Parameters<ActualAdapter['execute']>[0]) {
  if (request.kind === 'read-budget-snapshot') {
    return {
      kind: request.kind,
      snapshot: {
        budget: {
          budgetKeyHash,
          capturedAt: timestamp(0),
          currencyCode: 'USD',
        },
        contractVersion: 1,
      },
    } as const;
  }
  if (request.kind === 'read-actual-target') {
    throw new Error('Unexpected target read.');
  }
  return bankSyncResponse(request.accountId, 'succeeded', 'succeeded');
}

function bankSyncResponse(
  accountId: string,
  outcomeCode: AccountBankSyncOutcomeCode,
  finalSyncCode: 'succeeded' | 'failed',
) {
  return {
    kind: 'run-account-bank-sync' as const,
    result: {
      accountId,
      completedAt: timestamp(1),
      contractVersion: 1 as const,
      finalSyncCode,
      outcomeCode,
      startedAt: timestamp(0),
      transactionCounts: null,
    },
  };
}

function syntheticAccount(
  id: string,
  overrides: Readonly<{ name?: string }> = {},
) {
  return {
    closed: false,
    id,
    lastSync: null,
    name: overrides.name ?? `synthetic-${id}`,
    offBudget: false,
    syncSource: 'simpleFin' as const,
    syncStatus: null,
  };
}

function summaryFor(
  status: BankSyncJobSummary['status'],
  retryable: boolean,
): BankSyncJobSummary {
  return {
    accountResults: [],
    completedAt: timestamp(1),
    id: randomUUID(),
    kind: 'bank-sync',
    retryable,
    startedAt: timestamp(0),
    status,
  };
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>(resolve_ => {
    resolve = resolve_;
  });
  return { promise, resolve };
}

function clock() {
  let milliseconds = 0;
  return () => new Date(Date.UTC(2026, 6, 31, 12, 0, milliseconds++));
}

function timestamp(milliseconds: number) {
  return new Date(Date.UTC(2026, 6, 31, 12, 0, milliseconds)).toISOString();
}

function migrationPath(name: string) {
  return path.resolve(import.meta.dirname, '../../migrations', name);
}
