import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ActualAdapterConfiguration,
  AdapterOperation,
} from '#actual/adapter';
import { createActualAdapter } from '#actual/adapter';
import { canonicalJson } from '#actual/canonical-json';
import { createForkedAdapterWorkerRunner } from '#actual/forked-worker-runner';

const serverUrl = 'https://actual.example.test';
const budgetId = 'budget-id';
const configuration: ActualAdapterConfiguration = {
  actualApiDirectory: 'unused-by-fixture',
  actualApiDirectoryNonce: 'a'.repeat(43),
  actualBudgetCurrency: 'USD',
  actualBudgetId: budgetId,
  actualPassword: 'runner-secret',
  actualServerUrl: serverUrl,
  budgetBindingHash: createHash('sha256')
    .update('finance-companion/budget-binding/v1\0')
    .update(serverUrl)
    .update('\0')
    .update(budgetId)
    .digest('hex'),
  companionInstanceId: '11111111-1111-4111-8111-111111111111',
  hardTimeoutMilliseconds: 100,
  serviceInstanceNonce: 's'.repeat(43),
  softTimeoutMilliseconds: 50,
  workerExitTimeoutMilliseconds: 50,
};
const operation: AdapterOperation = {
  operationDirectory: 'unused-by-fixture',
  operationOwnerMarker: '{}',
  ownershipNonce: 'o'.repeat(43),
  request: { kind: 'read-budget-snapshot', sections: [] },
  workerOperationId: '22222222-2222-4222-8222-222222222222',
};

describe('forked Actual adapter worker runner', () => {
  it('requires result, shutdown completion, and a clean exit while discarding output', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-success.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'read-budget-snapshot',
    });
  });

  it('rejects a result when shutdown completion is missing', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-no-shutdown.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'adapter_unhealthy',
    });
  });

  it('gracefully requests termination then force-kills and joins a stuck child', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-hangs.ts', import.meta.url),
    );
    const controller = new AbortController();
    const completion = runner(operation, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    await expect(completion).rejects.toMatchObject({
      code: 'adapter_unhealthy',
    });
  });

  it('rejects malformed IPC frames', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-malformed.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'adapter_unhealthy',
    });
  });

  it('rejects shutdown completion received before a terminal response', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-early-shutdown.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'adapter_unhealthy' });
  });

  it('rejects worker IPC frames larger than 16 MiB', async () => {
    const runner = createForkedAdapterWorkerRunner(
      configuration,
      new URL('./fixtures/adapter-worker-oversized.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'adapter_unhealthy' });
  });

  it('keeps Actual credentials out of a real child argv and environment', async () => {
    const runner = createForkedAdapterWorkerRunner(
      {
        ...configuration,
        actualBudgetEncryptionPassword: 'runner-encryption-secret',
      },
      new URL('./fixtures/adapter-worker-secret-probe.ts', import.meta.url),
    );
    await expect(
      runner(operation, new AbortController().signal),
    ).resolves.toMatchObject({ kind: 'read-budget-snapshot' });
  });

  it('enforces the real hard deadline, joins the killed child, and quarantines', async () => {
    const actualApiDirectory = await mkdtemp(
      path.join(tmpdir(), 'finance-runner-deadline-'),
    );
    const deadlineConfiguration: ActualAdapterConfiguration = {
      ...configuration,
      actualApiDirectory,
      hardTimeoutMilliseconds: 40,
      softTimeoutMilliseconds: 10,
      workerExitTimeoutMilliseconds: 500,
    };
    await writeFile(
      path.join(actualApiDirectory, 'owner.json'),
      canonicalJson({
        budgetBindingHash: configuration.budgetBindingHash,
        companionInstanceId: configuration.companionInstanceId,
        directoryNonce: configuration.actualApiDirectoryNonce,
        formatVersion: 1,
      }),
    );
    try {
      const adapter = createActualAdapter(
        deadlineConfiguration,
        createForkedAdapterWorkerRunner(
          deadlineConfiguration,
          new URL('./fixtures/adapter-worker-hangs.ts', import.meta.url),
        ),
      );
      await expect(
        adapter.execute({ kind: 'read-budget-snapshot', sections: [] }),
      ).rejects.toMatchObject({ code: 'adapter_timeout' });
      expect(adapter.getHealth()).toBe('degraded');
      expect(
        await readdir(path.join(actualApiDirectory, 'quarantine')),
      ).toHaveLength(1);
    } finally {
      await rm(actualApiDirectory, { recursive: true, force: true });
    }
  });
});
