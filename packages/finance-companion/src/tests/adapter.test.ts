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
import type { ActualAdapterConfiguration } from '#actual/adapter';
import { canonicalJson } from '#actual/canonical-json';

const budgetBindingHash = createHash('sha256')
  .update('finance-companion/budget-binding/v1\0')
  .update('https://actual.example.test')
  .update('\0')
  .update('budget-id')
  .digest('hex');

const configurationBase: Omit<
  ActualAdapterConfiguration,
  'actualApiDirectory'
> = {
  actualApiDirectoryNonce: 'a'.repeat(43),
  actualBudgetCurrency: 'USD',
  actualBudgetId: 'budget-id',
  actualPassword: 'secret',
  actualServerUrl: 'https://actual.example.test',
  budgetBindingHash,
  companionInstanceId: '11111111-1111-4111-8111-111111111111',
  hardTimeoutMilliseconds: 40,
  softTimeoutMilliseconds: 10,
  workerExitTimeoutMilliseconds: 100,
  serviceInstanceNonce: 's'.repeat(43),
};

describe('Actual adapter', () => {
  let actualApiDirectory: string;
  beforeEach(async () => {
    actualApiDirectory = await mkdtemp(
      path.join(tmpdir(), 'finance-companion-adapter-'),
    );
    await writeFile(
      path.join(actualApiDirectory, 'owner.json'),
      canonicalJson({
        budgetBindingHash: configurationBase.budgetBindingHash,
        companionInstanceId: configurationBase.companionInstanceId,
        directoryNonce: configurationBase.actualApiDirectoryNonce,
        formatVersion: 1,
      }),
    );
  });
  afterEach(async () =>
    rm(actualApiDirectory, { recursive: true, force: true }),
  );

  it('serializes reads and removes only operation children', async () => {
    let concurrent = 0;
    let maximum = 0;
    const adapter = createActualAdapter(configuration(), async _operation => {
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      await new Promise(resolve => setTimeout(resolve, 5));
      concurrent -= 1;
      return snapshotResponse('read-budget-snapshot');
    });
    await Promise.all([
      adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
      adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
    ]);
    expect(maximum).toBe(1);
    await expect(
      mkdir(path.join(actualApiDirectory, 'operations'), { recursive: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects a bank sync without a durable job identity', async () => {
    const adapter = createActualAdapter(configuration(), async () => {
      throw new Error('worker must not start');
    });
    await expect(
      adapter.execute({
        kind: 'run-account-bank-sync',
        accountId: 'account-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_adapter_request' });
  });

  it('joins a hard-timed-out worker before releasing the queue', async () => {
    let didExit = false;
    const adapter = createActualAdapter(
      configuration(),
      async (_operation, signal) =>
        new Promise(resolve =>
          signal.addEventListener('abort', () =>
            setTimeout(() => {
              didExit = true;
              resolve(snapshotResponse('read-budget-snapshot'));
            }, 10),
          ),
        ),
    );
    await expect(
      adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
    ).rejects.toMatchObject({ code: 'adapter_timeout' });
    expect(didExit).toBe(true);
    expect(adapter.getHealth()).toBe('degraded');
    expect(
      await readdir(path.join(actualApiDirectory, 'quarantine')),
    ).toHaveLength(1);
  });

  it('retains the exact typed bank-sync operation name in quarantine', async () => {
    const jobRunId = '33333333-3333-4333-8333-333333333333';
    let workerOperationId = '';
    const adapter = createActualAdapter(
      configuration(),
      async (operation, signal) => {
        workerOperationId = operation.workerOperationId;
        return new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () => resolve(bankSyncResponse('account-1')),
            { once: true },
          ),
        );
      },
    );
    await expect(
      adapter.execute(
        { kind: 'run-account-bank-sync', accountId: 'account-1' },
        { jobRunId },
      ),
    ).rejects.toMatchObject({ code: 'adapter_timeout' });
    const expectedRootName = `bank-sync-${jobRunId}-${workerOperationId}`;
    expect(await readdir(path.join(actualApiDirectory, 'quarantine'))).toEqual([
      expectedRootName,
    ]);
    const marker = JSON.parse(
      await readFile(
        path.join(
          actualApiDirectory,
          'quarantine',
          expectedRootName,
          'operation-owner.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(marker.rootName).toBe(expectedRootName);
  });

  it('uses one worker-exit timeout window after the hard deadline', async () => {
    const workerExitTimeoutMilliseconds = 20;
    const adapter = createActualAdapter(
      configuration({
        hardTimeoutMilliseconds: 20,
        softTimeoutMilliseconds: 5,
        workerExitTimeoutMilliseconds,
      }),
      async (_operation, signal) =>
        new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () =>
              setTimeout(
                () => resolve(snapshotResponse('read-budget-snapshot')),
                workerExitTimeoutMilliseconds * 2,
              ),
            { once: true },
          ),
        ),
    );
    await expect(
      adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
    ).rejects.toMatchObject({ code: 'adapter_unhealthy' });
    expect(adapter.getHealth()).toBe('unhealthy');
  });

  it('fails closed when an operation path no longer matches its typed root', async () => {
    const adapter = createActualAdapter(configuration(), async operation => {
      Object.assign(operation, { operationDirectory: actualApiDirectory });
      return snapshotResponse('read-budget-snapshot');
    });
    await adapter.execute({ kind: 'read-budget-snapshot', sections: [] });
    expect(adapter.getHealth()).toBe('unhealthy');
    expect(
      await readdir(path.join(actualApiDirectory, 'operations')),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(path.join(actualApiDirectory, 'owner.json'), 'utf8'),
      ),
    ).toMatchObject({ formatVersion: 1 });
  });

  it('fails closed when response binding evidence changes', async () => {
    const adapter = createActualAdapter(configuration(), async () => ({
      kind: 'read-budget-snapshot',
      snapshot: {
        ...snapshotResponse('read-budget-snapshot').snapshot,
        budget: {
          ...snapshotResponse('read-budget-snapshot').snapshot.budget,
          budgetKeyHash: 'c'.repeat(64),
        },
      },
    }));
    await expect(
      adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
    ).rejects.toMatchObject({ code: 'adapter_unhealthy' });
  });

  it('accepts the closed schedule snapshot and no raw schedule fields', async () => {
    const schedules = [scheduleSnapshot()];
    const adapter = createActualAdapter(configuration(), async () => ({
      kind: 'read-budget-snapshot',
      snapshot: {
        ...snapshotResponse('read-budget-snapshot').snapshot,
        schedules,
      },
    }));
    await expect(
      adapter.execute({
        kind: 'read-budget-snapshot',
        sections: ['schedules'],
      }),
    ).resolves.toMatchObject({ snapshot: { schedules } });
  });

  it.each([
    {
      name: 'missing',
      response: snapshotResponse('read-budget-snapshot'),
    },
    {
      name: 'malformed',
      response: {
        kind: 'read-budget-snapshot' as const,
        snapshot: {
          ...snapshotResponse('read-budget-snapshot').snapshot,
          schedules: [{ ...scheduleSnapshot(), name: 'forbidden' }],
        },
      },
    },
  ])('rejects a $name requested schedule section', async ({ response }) => {
    const adapter = createActualAdapter(
      configuration(),
      async () => response as never,
    );
    await expect(
      adapter.execute({
        kind: 'read-budget-snapshot',
        sections: ['schedules'],
      }),
    ).rejects.toMatchObject({ code: 'adapter_unhealthy' });
  });

  it('totally rejects missing, mistyped, and unknown request fields', async () => {
    const adapter = createActualAdapter(configuration(), async () => {
      throw new Error('worker must not start');
    });
    await expect(
      adapter.execute({ kind: 'read-budget-snapshot' } as never),
    ).rejects.toMatchObject({ code: 'invalid_adapter_request' });
    await expect(
      adapter.execute({
        kind: 'read-budget-snapshot',
        sections: [],
        query: 'forbidden',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_adapter_request' });
    await expect(
      adapter.execute({
        kind: 'read-budget-snapshot',
        sections: [],
        transactionRange: {
          startDate: 1,
          endDateExclusive: '2026-08-01',
        },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_adapter_request' });
  });

  it('reports a soft timeout without releasing the worker guard', async () => {
    let resolveWorker:
      | ((value: ReturnType<typeof snapshotResponse>) => void)
      | undefined;
    const adapter = createActualAdapter(
      configuration({
        hardTimeoutMilliseconds: 1_000,
        softTimeoutMilliseconds: 20,
      }),
      async () =>
        new Promise(resolve => {
          resolveWorker = resolve;
        }),
    );
    const completion = adapter.execute({
      kind: 'read-budget-snapshot',
      sections: [],
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(adapter.getActiveOperationStatus()).toBe('pending-timeout');
    resolveWorker?.(snapshotResponse('read-budget-snapshot'));
    await completion;
    expect(adapter.getActiveOperationStatus()).toBeNull();
  });

  it('quarantines an owned operation when scoped cleanup fails', async () => {
    const adapter = createActualAdapter(
      configuration(),
      async () => snapshotResponse('read-budget-snapshot'),
      {
        removeOwnedOperation: async () => {
          throw new Error('synthetic cleanup failure');
        },
      },
    );
    await adapter.execute({ kind: 'read-budget-snapshot', sections: [] });
    expect(adapter.getHealth()).toBe('degraded');
    expect(
      await readdir(path.join(actualApiDirectory, 'quarantine')),
    ).toHaveLength(1);
  });

  function configuration(
    overrides: Partial<ActualAdapterConfiguration> = {},
  ): ActualAdapterConfiguration {
    return { ...configurationBase, actualApiDirectory, ...overrides };
  }
});

function snapshotResponse(kind: 'read-budget-snapshot') {
  return {
    kind,
    snapshot: {
      budget: {
        budgetKeyHash: configurationBase.budgetBindingHash,
        capturedAt: '2026-07-31T12:00:00.000Z',
        currencyCode: 'USD',
      },
      contractVersion: 1 as const,
    },
  };
}

function bankSyncResponse(accountId: string) {
  return {
    kind: 'run-account-bank-sync' as const,
    result: {
      accountId,
      completedAt: '2026-07-31T12:00:01.000Z',
      contractVersion: 1 as const,
      finalSyncCode: 'succeeded' as const,
      outcomeCode: 'succeeded' as const,
      startedAt: '2026-07-31T12:00:00.000Z',
      transactionCounts: null,
    },
  };
}

function scheduleSnapshot() {
  return {
    accountId: 'account-1',
    amount: -1_000,
    amountOperator: 'is' as const,
    id: 'schedule-1',
    isCompleted: false,
    payeeId: 'payee-1',
    recurrence: {
      frequency: 'monthly' as const,
      interval: 1,
      kind: 'recurring' as const,
      start: '2026-01-15',
    },
  };
}
