import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createActualAdapter } from '#actual/adapter';
import { createForkedAdapterWorkerRunner } from '#actual/forked-worker-runner';
import type { FinanceCompanionConfiguration } from '#config';
import { openCompanionDatabase } from '#database/connection';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import type { LocalPrincipalRepository } from '#security/local-security';

import {
  BankSyncJobError,
  createSqliteBankSyncJobRepositoryDuringMaintenance,
  runOneShotBankSyncJob,
} from './bank-sync.ts';
import type { BankSyncJobSummary, ParsedBankSyncCommand } from './bank-sync.ts';

export type ConfiguredBankSyncJobTestHooks = Readonly<{
  createAdapter?: typeof createConfiguredActualAdapter;
}>;

export async function runConfiguredBankSyncJob(
  configuration: FinanceCompanionConfiguration,
  principalRepository: LocalPrincipalRepository,
  command: ParsedBankSyncCommand,
  signal?: AbortSignal,
  testHooks: ConfiguredBankSyncJobTestHooks = {},
): Promise<BankSyncJobSummary> {
  return withExclusiveMaintenanceLock(configuration.databasePath, async () => {
    const principal = await principalRepository.readOwner();
    if (principal === null) throw new BankSyncJobError('configuration_error');
    const adapter = await (
      testHooks.createAdapter ?? createConfiguredActualAdapter
    )(configuration);
    return runOneShotBankSyncJob(
      { ...command, principalId: principal.id },
      {
        adapter,
        budgetKeyHash: configuration.budgetKeyHash,
        repository: createSqliteBankSyncJobRepositoryDuringMaintenance(
          configuration.databasePath,
        ),
        signal,
      },
    );
  });
}

export async function createConfiguredActualAdapter(
  configuration: FinanceCompanionConfiguration,
) {
  const instanceId = readCompanionInstanceId(configuration.databasePath);
  const adapterConfiguration = await readAdapterConfiguration(
    configuration,
    instanceId,
  );
  return createActualAdapter(
    adapterConfiguration,
    createForkedAdapterWorkerRunner(adapterConfiguration),
  );
}

async function readAdapterConfiguration(
  configuration: FinanceCompanionConfiguration,
  companionInstanceId: string,
) {
  const actualApiDirectory = required(configuration.actualApiDirectory);
  const serializedOwner = await readFile(
    path.join(actualApiDirectory, 'owner.json'),
    'utf8',
  );
  const owner = JSON.parse(serializedOwner) as Readonly<{
    directoryNonce?: unknown;
  }>;
  if (
    typeof owner.directoryNonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(owner.directoryNonce)
  ) {
    throw new BankSyncJobError('configuration_error');
  }
  return {
    actualApiDirectory,
    actualApiDirectoryNonce: owner.directoryNonce,
    actualBudgetCurrency: configuration.budgetCurrencyCode,
    actualBudgetEncryptionPassword: await readOptionalSecret(
      configuration.actualBudgetEncryptionPassword,
      configuration.actualBudgetEncryptionPasswordFile,
    ),
    actualBudgetId: required(configuration.actualBudgetId),
    actualPassword: await readRequiredSecret(
      configuration.actualPassword,
      configuration.actualPasswordFile,
    ),
    actualServerUrl: required(configuration.actualServerUrl),
    budgetBindingHash: configuration.budgetKeyHash,
    companionInstanceId,
    hardTimeoutMilliseconds: required(
      configuration.adapterHardTimeoutMilliseconds,
    ),
    serviceInstanceNonce: randomBytes(32).toString('base64url'),
    softTimeoutMilliseconds: required(
      configuration.adapterSoftTimeoutMilliseconds,
    ),
    workerExitTimeoutMilliseconds: required(
      configuration.workerExitTimeoutMilliseconds,
    ),
  };
}

function readCompanionInstanceId(databasePath: string): string {
  const database = openCompanionDatabase(databasePath, true);
  try {
    const row = database
      .prepare(
        "SELECT instance_id FROM companion_instance WHERE singleton_key = 'main'",
      )
      .get() as Readonly<{ instance_id?: unknown }> | undefined;
    if (
      row === undefined ||
      typeof row.instance_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        row.instance_id,
      )
    ) {
      throw new BankSyncJobError('configuration_error');
    }
    return row.instance_id;
  } finally {
    database.close();
  }
}

async function readRequiredSecret(
  value: string | undefined,
  filePath: string | undefined,
): Promise<string> {
  const secret = await readOptionalSecret(value, filePath);
  if (secret === undefined || secret.length === 0) {
    throw new BankSyncJobError('configuration_error');
  }
  return secret;
}

async function readOptionalSecret(
  value: string | undefined,
  filePath: string | undefined,
): Promise<string | undefined> {
  if (value !== undefined && filePath !== undefined) {
    throw new BankSyncJobError('configuration_error');
  }
  if (value !== undefined) return value;
  if (filePath === undefined) return undefined;
  return (await readFile(filePath, 'utf8')).replace(/\r?\n$/, '');
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new BankSyncJobError('configuration_error');
  return value;
}
