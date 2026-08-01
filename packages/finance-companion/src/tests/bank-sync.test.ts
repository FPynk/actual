import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createActualAdapter } from '#actual/adapter';
import type {
  ActualAdapter,
  ActualAdapterConfiguration,
} from '#actual/adapter';
import { canonicalJson } from '#actual/canonical-json';
import { createForkedAdapterWorkerRunner } from '#actual/forked-worker-runner';
import { ActualAdapterError } from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import {
  bankSyncExitCode,
  createSqliteBankSyncJobRepository,
  runOneShotBankSyncJob,
} from '#service/bank-sync';
import type { BankSyncJobDependencies } from '#service/bank-sync';

const principalId = '11111111-1111-4111-8111-111111111111';
const budgetKeyHash = 'a'.repeat(64);
const actualServerUrl = 'https://actual.example.test';
const actualBudgetId = 'budget-id';
const actualBudgetBindingHash = createHash('sha256')
  .update('finance-companion/budget-binding/v1\0')
  .update(actualServerUrl)
  .update('\0')
  .update(actualBudgetId)
  .digest('hex');
let testDatabasePath = '';

describe('FIN-28 one-shot bank sync', () => {
  let temporaryDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'finance-companion-bank-sync-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    testDatabasePath = databasePath;
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

  it('sorts linked accounts, skips closed accounts, persists rows, and never makes an unscoped call', async () => {
    const calls: string[] = [];
    const summary = await run({
      adapter: adapter(
        [
          account('b'),
          account('a', { closed: true }),
          account('unlinked', { syncSource: null }),
        ],
        request => {
          if (request.kind === 'run-account-bank-sync') {
            calls.push(request.accountId);
          }
          return success(request);
        },
      ),
    });

    expect(summary.status).toBe('succeeded');
    expect(summary.accountResults).toEqual([
      { accountId: 'a', outcomeCode: 'skipped', transactionCounts: null },
      { accountId: 'b', outcomeCode: 'succeeded', transactionCounts: null },
    ]);
    expect(calls).toEqual(['b']);
    expect(bankSyncExitCode(summary)).toBe(0);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database.prepare('SELECT account_scope_hash FROM job_runs').get(),
      ).toMatchObject({
        account_scope_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(
        database
          .prepare(
            'SELECT ordinal, status FROM job_run_account_operations ORDER BY ordinal',
          )
          .all(),
      ).toEqual([
        { ordinal: 0, status: 'skipped' },
        { ordinal: 1, status: 'succeeded' },
      ]);
    } finally {
      database.close();
    }
  });

  it('passes deterministic retry jitter into one account lifecycle and continues after failure', async () => {
    const calls: string[] = [];
    const retryJitter: unknown[] = [];
    const summary = await run({
      adapter: adapter([account('a'), account('b')], (request, context) => {
        if (request.kind !== 'run-account-bank-sync') return success(request);
        calls.push(request.accountId);
        retryJitter.push(context?.bankSyncRetryJitterMilliseconds);
        if (request.accountId === 'a') {
          return outcome(request.accountId, 'provider-error');
        }
        return success(request);
      }),
      jitterMilliseconds: () => 7,
    });

    expect(calls).toEqual(['a', 'b']);
    expect(retryJitter).toEqual([
      [7, 7],
      [7, 7],
    ]);
    expect(summary.status).toBe('partial');
  });

  it('returns stored replay results without asking Actual again', async () => {
    let reads = 0;
    const first = await run({
      adapter: adapter([account('a')], request => {
        if (request.kind === 'read-budget-snapshot') reads += 1;
        return success(request);
      }),
    });
    const replay = await run({
      adapter: adapter([], request => {
        if (request.kind === 'read-budget-snapshot') reads += 1;
        return success(request);
      }),
    });

    expect(replay).toEqual(first);
    expect(reads).toBe(1);
  });

  it('scopes an idempotency key to its invocation and operation identity', async () => {
    const idempotencyKey = 'shared-identity-key';
    const scheduled = await run({
      adapter: adapter([account('a')], request => success(request)),
      idempotencyKey,
    });
    let httpReads = 0;
    const http = await runOneShotBankSyncJob(
      {
        accountIds: ['a'],
        idempotencyKey,
        invocationKind: 'local_http',
        principalId,
      },
      {
        adapter: adapter([account('a')], request => {
          if (request.kind === 'read-budget-snapshot') httpReads += 1;
          return success(request);
        }),
        budgetKeyHash,
        now: clock(),
        repository: createSqliteBankSyncJobRepository(databasePath),
      },
    );

    expect(http.id).not.toBe(scheduled.id);
    expect(httpReads).toBe(1);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT invocation_kind, operation_id FROM job_runs ORDER BY invocation_kind',
          )
          .all(),
      ).toEqual([
        {
          invocation_kind: 'local_http',
          operation_id: 'finance-companion/http/bank-sync/v1',
        },
        {
          invocation_kind: 'scheduler',
          operation_id: 'finance-companion/job:bank-sync/v1',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('turns a hard timeout into unknown effects, skips untouched accounts, and closes later work', async () => {
    const calls: string[] = [];
    const summary = await run({
      adapter: adapter([account('a'), account('b')], (request, context) => {
        if (request.kind !== 'run-account-bank-sync') return success(request);
        calls.push(request.accountId);
        context?.onSafetyOutcome?.('outcome-unknown');
        const timeout = new ActualAdapterError('adapter_timeout');
        timeout.quarantineBundleHash = 'b'.repeat(64);
        throw timeout;
      }),
    });

    expect(calls).toEqual(['a']);
    expect(summary.status).toBe('outcome_unknown');
    expect(summary.accountResults.map(result => result.outcomeCode)).toEqual([
      'outcome-unknown',
      'skipped',
    ]);
    expect(bankSyncExitCode(summary)).toBe(76);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT status, quarantine_bundle_hash FROM job_run_account_operations WHERE ordinal = 0',
          )
          .get(),
      ).toEqual({
        quarantine_bundle_hash: 'b'.repeat(64),
        status: 'outcome_unknown',
      });
      expect(database.prepare('SELECT status FROM job_runs').get()).toEqual({
        status: 'outcome_unknown',
      });
    } finally {
      database.close();
    }
    await expect(
      run({
        adapter: adapter([], request => success(request)),
        idempotencyKey: 'new-key-after-unknown',
      }),
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });
  });

  it('upgrades a canceled result with unproven shutdown to quarantined unknown and blocks restart', async () => {
    const actualApiDirectory = path.join(temporaryDirectory, 'actual-api');
    await mkdir(actualApiDirectory);
    const actualAdapterConfiguration: ActualAdapterConfiguration = {
      actualApiDirectory,
      actualApiDirectoryNonce: 'a'.repeat(43),
      actualBudgetCurrency: 'USD',
      actualBudgetId,
      actualPassword: 'secret',
      actualServerUrl,
      budgetBindingHash: actualBudgetBindingHash,
      companionInstanceId: '22222222-2222-4222-8222-222222222222',
      hardTimeoutMilliseconds: 1_000,
      serviceInstanceNonce: 's'.repeat(43),
      softTimeoutMilliseconds: 500,
      workerExitTimeoutMilliseconds: 500,
    };
    await writeFile(
      path.join(actualApiDirectory, 'owner.json'),
      canonicalJson({
        budgetBindingHash: actualBudgetBindingHash,
        companionInstanceId: actualAdapterConfiguration.companionInstanceId,
        directoryNonce: actualAdapterConfiguration.actualApiDirectoryNonce,
        formatVersion: 1,
      }),
    );
    const actualAdapter = createActualAdapter(
      actualAdapterConfiguration,
      createForkedAdapterWorkerRunner(
        actualAdapterConfiguration,
        new URL(
          './fixtures/adapter-worker-bank-sync-no-shutdown.ts',
          import.meta.url,
        ),
      ),
    );

    const summary = await runOneShotBankSyncJob(
      {
        accountIds: null,
        idempotencyKey: 'missing-shutdown-first',
        invocationKind: 'scheduler',
        principalId,
      },
      {
        adapter: actualAdapter,
        budgetKeyHash: actualBudgetBindingHash,
        now: clock(),
        repository: createSqliteBankSyncJobRepository(databasePath),
      },
    );

    expect(summary).toMatchObject({
      accountResults: [
        { accountId: 'account-1', outcomeCode: 'outcome-unknown' },
      ],
      status: 'outcome_unknown',
    });
    expect(
      await readdir(path.join(actualApiDirectory, 'quarantine')),
    ).toHaveLength(1);
    expect(await readdir(path.join(actualApiDirectory, 'operations'))).toEqual(
      [],
    );
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT job_runs.status AS job_status, job_run_account_operations.status AS account_status, job_run_account_operations.quarantine_bundle_hash FROM job_runs JOIN job_run_account_operations ON job_run_account_operations.job_run_id = job_runs.id',
          )
          .get(),
      ).toEqual({
        account_status: 'outcome_unknown',
        job_status: 'outcome_unknown',
        quarantine_bundle_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      database.close();
    }

    let restartedAdapterCalls = 0;
    await expect(
      runOneShotBankSyncJob(
        {
          accountIds: null,
          idempotencyKey: 'missing-shutdown-after-restart',
          invocationKind: 'scheduler',
          principalId,
        },
        {
          adapter: {
            execute: async () => {
              restartedAdapterCalls += 1;
              throw new Error('A blocked restart must not call Actual.');
            },
          },
          budgetKeyHash: actualBudgetBindingHash,
          repository: createSqliteBankSyncJobRepository(databasePath),
        },
      ),
    ).rejects.toMatchObject({ code: 'adapter_unavailable' });
    expect(restartedAdapterCalls).toBe(0);
  });

  it('cancels before calls, preserves redacted logs, and maps final-sync failures', async () => {
    const logs: unknown[] = [];
    await run({
      adapter: adapter(
        [account('account-1', { name: 'sensitive account name' })],
        request => success(request),
      ),
      log: event => logs.push(event),
    });
    expect(JSON.stringify(logs)).not.toContain('sensitive');

    const controller = new AbortController();
    controller.abort();
    const canceled = await run({
      adapter: adapter([account('account-2')], request => success(request)),
      idempotencyKey: 'a-second-valid-idempotency-key',
      signal: controller.signal,
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled.retryable).toBe(true);

    const finalSyncFailure = await run({
      idempotencyKey: 'another-valid-idempotency-key',
      adapter: adapter([account('a')], request =>
        request.kind === 'run-account-bank-sync'
          ? outcome(request.accountId, 'succeeded', 'failed')
          : success(request),
      ),
    });
    expect(finalSyncFailure.accountResults[0]?.outcomeCode).toBe(
      'final-sync-failed',
    );
    expect(finalSyncFailure.status).toBe('failed');
    expect(finalSyncFailure.retryable).toBe(false);
    expect(bankSyncExitCode(finalSyncFailure)).toBe(70);
  });
});

function run(
  overrides: Partial<BankSyncJobDependencies> &
    Readonly<{ idempotencyKey?: string }>,
) {
  return runOneShotBankSyncJob(
    {
      accountIds: null,
      idempotencyKey: overrides.idempotencyKey ?? 'a-valid-idempotency-key',
      invocationKind: 'scheduler',
      principalId,
    },
    {
      adapter: overrides.adapter!,
      budgetKeyHash,
      jitterMilliseconds: overrides.jitterMilliseconds,
      log: overrides.log,
      now: clock(),
      repository: createSqliteBankSyncJobRepository(testDatabasePath),
      signal: overrides.signal,
    },
  );
}

function adapter(
  accounts: readonly ReturnType<typeof account>[],
  handler: (
    request: Parameters<ActualAdapter['execute']>[0],
    context?: Parameters<ActualAdapter['execute']>[1],
  ) => ReturnType<typeof success>,
): Pick<ActualAdapter, 'execute'> {
  return {
    execute: async (request, context) => {
      if (request.kind === 'read-budget-snapshot') {
        handler(request, context);
        return {
          kind: request.kind,
          snapshot: {
            budget: {
              budgetKeyHash,
              capturedAt: timestamp(0),
              currencyCode: 'USD',
            },
            contractVersion: 1,
            accounts,
          },
        };
      }
      return handler(request, context);
    },
  };
}

function account(
  id: string,
  overrides: Readonly<{
    closed?: boolean;
    name?: string;
    syncSource?: 'simpleFin' | null;
  }> = {},
) {
  return {
    closed: overrides.closed ?? false,
    id,
    lastSync: null,
    name: overrides.name ?? `account-${id}`,
    offBudget: false,
    syncSource:
      overrides.syncSource === undefined ? 'simpleFin' : overrides.syncSource,
    syncStatus: null,
  } as const;
}

function success(request: Parameters<ActualAdapter['execute']>[0]) {
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
  return outcome(request.accountId, 'succeeded');
}

function outcome(
  accountId: string,
  outcomeCode: 'succeeded' | 'provider-error',
  finalSyncCode: 'succeeded' | 'failed' = 'succeeded',
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
