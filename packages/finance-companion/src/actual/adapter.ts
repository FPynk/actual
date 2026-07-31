import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { ActualAdapterQueue } from '#actual/adapter-queue';
import { calculateBudgetBindingHash } from '#actual/budget-binding';
import { canonicalJson } from '#actual/canonical-json';
import { reclaimActualApiLockAfterWorkerExit } from '#actual/operation-lock';
import type {
  ActualAdapterRequest,
  ActualAdapterResponse,
} from '#contracts/adapter';
import { ActualAdapterError } from '#contracts/adapter';

export type ActualAdapterConfiguration = Readonly<{
  actualApiDirectory: string;
  companionInstanceId: string;
  budgetBindingHash: string;
  actualApiDirectoryNonce: string;
  serviceInstanceNonce: string;
  softTimeoutMilliseconds: number;
  hardTimeoutMilliseconds: number;
  workerExitTimeoutMilliseconds: number;
  actualServerUrl: string;
  actualPassword: string;
  actualBudgetId: string;
  actualBudgetCurrency: string;
  actualBudgetEncryptionPassword?: string;
}>;

export type AdapterExecutionContext = Readonly<{
  jobRunId?: string;
  workerOperationId?: string;
  bankSyncRetryJitterMilliseconds?: readonly [number, number];
  cancellationSignal?: AbortSignal;
  onQuarantine?: (quarantineBundleHash: string) => void;
  onSafetyOutcome?: (outcome: 'canceled' | 'outcome-unknown') => void;
}>;

export type AdapterOperation = Readonly<{
  request: ActualAdapterRequest;
  workerOperationId: string;
  ownershipNonce: string;
  operationDirectory: string;
  operationOwnerMarker: string;
  bankSyncRetryJitterMilliseconds?: readonly [number, number];
}>;

export type AdapterWorkerRunner = (
  operation: AdapterOperation,
  signal: AbortSignal,
  cancellationSignal?: AbortSignal,
  onTerminalResponse?: (response: ActualAdapterResponse) => void,
) => Promise<ActualAdapterResponse>;

export type ActualAdapter = Readonly<{
  execute(
    request: ActualAdapterRequest,
    context?: AdapterExecutionContext,
  ): Promise<ActualAdapterResponse>;
  getHealth(): 'healthy' | 'degraded' | 'unhealthy';
  getActiveOperationStatus(): 'running' | 'pending-timeout' | null;
}>;

export type ActualAdapterLifecycleDependencies = Readonly<{
  removeOwnedOperation?: (operation: AdapterOperation) => Promise<void>;
}>;

class WorkerExitUnprovenError extends ActualAdapterError {
  constructor() {
    super('adapter_unhealthy');
    this.name = 'WorkerExitUnprovenError';
  }
}

const operationDirectoryName = 'operations';
const quarantineDirectoryName = 'quarantine';

export function createActualAdapter(
  configuration: ActualAdapterConfiguration,
  runWorker: AdapterWorkerRunner,
  lifecycleDependencies: ActualAdapterLifecycleDependencies = {},
): ActualAdapter {
  validateConfiguration(configuration);
  const queue = new ActualAdapterQueue();
  let health: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  let activeOperationStatus: 'running' | 'pending-timeout' | null = null;

  return {
    async execute(request, context) {
      validateRequest(request, context);
      const ownedRequest = structuredClone(request);
      const ownedContext =
        context === undefined
          ? undefined
          : {
              jobRunId: context.jobRunId,
              workerOperationId: context.workerOperationId,
              bankSyncRetryJitterMilliseconds:
                context.bankSyncRetryJitterMilliseconds,
            };
      if (health === 'unhealthy') {
        throw new ActualAdapterError('adapter_unhealthy');
      }
      return queue.run(async () => {
        const operation = await createOperation(
          configuration,
          ownedRequest,
          ownedContext,
        );
        const controller = new AbortController();
        let mayCleanOperation = true;
        let mustQuarantineOperation = false;
        let operationFailure: unknown;
        activeOperationStatus = 'running';
        try {
          const response = await runWithDeadlines(
            runWorker(
              operation,
              controller.signal,
              context?.cancellationSignal,
              response => {
                validateResponse(
                  configuration,
                  ownedRequest,
                  response,
                  ownedContext,
                );
                if (
                  response.kind === 'run-account-bank-sync' &&
                  response.result.outcomeCode === 'outcome-unknown'
                ) {
                  context?.onSafetyOutcome?.(response.result.outcomeCode);
                }
              },
            ),
            controller,
            configuration.softTimeoutMilliseconds,
            configuration.hardTimeoutMilliseconds,
            configuration.workerExitTimeoutMilliseconds,
            () => {
              activeOperationStatus = 'pending-timeout';
            },
            () => context?.onSafetyOutcome?.('outcome-unknown'),
          );
          validateResponse(configuration, ownedRequest, response, ownedContext);
          assertWithinIpcLimit(response);
          if (
            response.kind === 'run-account-bank-sync' &&
            response.result.outcomeCode === 'canceled'
          ) {
            context?.onSafetyOutcome?.('canceled');
          }
          if (
            response.kind === 'run-account-bank-sync' &&
            response.result.outcomeCode === 'outcome-unknown'
          ) {
            mustQuarantineOperation = true;
          }
          return response;
        } catch (error) {
          operationFailure = error;
          if (error instanceof WorkerExitUnprovenError) {
            mayCleanOperation = false;
          }
          if (
            error instanceof ActualAdapterError &&
            error.code === 'adapter_timeout'
          ) {
            mustQuarantineOperation = true;
          }
          if (
            error instanceof ActualAdapterError &&
            error.code === 'adapter_unhealthy' &&
            error.bankSyncWorkBegan
          ) {
            mustQuarantineOperation = true;
          }
          if (
            error instanceof ActualAdapterError &&
            error.code === 'adapter_unhealthy'
          ) {
            health = 'unhealthy';
            queue.close();
          }
          throw error;
        } finally {
          activeOperationStatus = null;
          if (mayCleanOperation) {
            if (mustQuarantineOperation) {
              try {
                const quarantineBundleHash = await quarantineOwnedOperation(
                  configuration,
                  operation,
                );
                if (operationFailure instanceof ActualAdapterError) {
                  operationFailure.quarantineBundleHash = quarantineBundleHash;
                }
                context?.onQuarantine?.(quarantineBundleHash);
                await reclaimActualApiLockAfterWorkerExit(
                  configuration.actualApiDirectory,
                  configuration.actualApiDirectoryNonce,
                );
                if (health === 'healthy') {
                  health = 'degraded';
                }
              } catch {
                health = 'unhealthy';
                queue.close();
              }
            } else {
              try {
                if (lifecycleDependencies.removeOwnedOperation !== undefined) {
                  await lifecycleDependencies.removeOwnedOperation(operation);
                } else {
                  await removeOwnedOperation(configuration, operation);
                }
              } catch {
                try {
                  await quarantineOwnedOperation(configuration, operation);
                  if (health === 'healthy') health = 'degraded';
                } catch {
                  health = 'unhealthy';
                  queue.close();
                }
              }
            }
          }
        }
      });
    },
    getHealth: () => health,
    getActiveOperationStatus: () => activeOperationStatus,
  };
}

async function createOperation(
  configuration: ActualAdapterConfiguration,
  request: ActualAdapterRequest,
  context: AdapterExecutionContext | undefined,
): Promise<AdapterOperation> {
  const workerOperationId = context?.workerOperationId ?? randomUUID();
  const ownershipNonce = randomBytes(32).toString('base64url');
  const operationRoot = await ensureManagedParent(
    configuration,
    operationDirectoryName,
    true,
  );
  const jobRunId = context?.jobRunId;
  const rootName =
    request.kind === 'run-account-bank-sync'
      ? `bank-sync-${jobRunId}-${workerOperationId}`
      : `read-${workerOperationId}`;
  const operationDirectory = directChildPath(operationRoot, rootName);
  await mkdir(operationDirectory, { mode: 0o700 });
  const marker = canonicalJson({
    budgetBindingHash: configuration.budgetBindingHash,
    companionInstanceId: configuration.companionInstanceId,
    formatVersion: 1,
    ownershipNonce,
    rootKind: request.kind === 'run-account-bank-sync' ? 'bank-sync' : 'read',
    rootName,
    workerOperationId,
    ...(request.kind === 'run-account-bank-sync'
      ? { accountId: request.accountId, jobRunId }
      : {}),
  });
  const markerPath = path.join(operationDirectory, 'operation-owner.json');
  await writeFile(markerPath, marker, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return {
    request,
    workerOperationId,
    ownershipNonce,
    operationDirectory,
    operationOwnerMarker: marker,
    bankSyncRetryJitterMilliseconds: context?.bankSyncRetryJitterMilliseconds,
  };
}

async function ensureOwnedDirectory(directory: string): Promise<void> {
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  assertSamePath(await realpath(directory), path.resolve(directory));
}

async function verifyActualApiRootOwner(
  configuration: ActualAdapterConfiguration,
): Promise<string> {
  const actualApiDirectory = path.resolve(configuration.actualApiDirectory);
  if (actualApiDirectory !== configuration.actualApiDirectory) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  await ensureOwnedDirectory(actualApiDirectory);
  const markerPath = path.join(actualApiDirectory, 'owner.json');
  const markerStatus = await lstat(markerPath);
  if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  const serializedOwner = await readFile(markerPath, 'utf8');
  let owner: Record<string, unknown>;
  try {
    owner = JSON.parse(serializedOwner) as Record<string, unknown>;
  } catch {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  if (
    canonicalJson(owner) !== serializedOwner ||
    !hasExactKeys(owner, [
      'formatVersion',
      'companionInstanceId',
      'budgetBindingHash',
      'directoryNonce',
    ]) ||
    owner.formatVersion !== 1 ||
    owner.companionInstanceId !== configuration.companionInstanceId ||
    owner.budgetBindingHash !== configuration.budgetBindingHash ||
    owner.directoryNonce !== configuration.actualApiDirectoryNonce
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  return actualApiDirectory;
}

async function removeOwnedOperation(
  configuration: ActualAdapterConfiguration,
  operation: AdapterOperation,
): Promise<void> {
  const identity = deriveExpectedOperationIdentity(configuration, operation);
  const operationRoot = await ensureManagedParent(
    configuration,
    operationDirectoryName,
    false,
  );
  assertSamePath(identity.operationRoot, operationRoot);
  await assertDirectOwnedOperation(operationRoot, identity.rootName, operation);
  const cleanupName = `${identity.rootName}.cleanup-${operation.ownershipNonce}`;
  const cleanupDirectory = directChildPath(operationRoot, cleanupName);
  await assertPathAbsent(cleanupDirectory);
  await rename(identity.operationDirectory, cleanupDirectory);
  const verifiedOperationRoot = await ensureManagedParent(
    configuration,
    operationDirectoryName,
    false,
  );
  assertSamePath(operationRoot, verifiedOperationRoot);
  await assertDirectOwnedOperation(
    verifiedOperationRoot,
    cleanupName,
    operation,
  );
  await rm(cleanupDirectory, {
    recursive: true,
    force: false,
    maxRetries: 0,
  });
  await ensureManagedParent(configuration, operationDirectoryName, false);
  await assertPathAbsent(cleanupDirectory);
}

async function quarantineOwnedOperation(
  configuration: ActualAdapterConfiguration,
  operation: AdapterOperation,
): Promise<string> {
  const identity = deriveExpectedOperationIdentity(configuration, operation);
  const operationRoot = await ensureManagedParent(
    configuration,
    operationDirectoryName,
    false,
  );
  assertSamePath(identity.operationRoot, operationRoot);
  await assertDirectOwnedOperation(operationRoot, identity.rootName, operation);
  const quarantineRoot = await ensureManagedParent(
    configuration,
    quarantineDirectoryName,
    true,
  );
  const quarantineDirectory = directChildPath(
    quarantineRoot,
    identity.rootName,
  );
  await assertPathAbsent(quarantineDirectory);
  await rename(identity.operationDirectory, quarantineDirectory);
  const verifiedOperationRoot = await ensureManagedParent(
    configuration,
    operationDirectoryName,
    false,
  );
  const verifiedQuarantineRoot = await ensureManagedParent(
    configuration,
    quarantineDirectoryName,
    false,
  );
  assertSamePath(operationRoot, verifiedOperationRoot);
  assertSamePath(quarantineRoot, verifiedQuarantineRoot);
  await assertDirectOwnedOperation(
    verifiedQuarantineRoot,
    identity.rootName,
    operation,
  );
  await assertPathAbsent(identity.operationDirectory);
  return quarantineBundleHash(quarantineDirectory, identity.rootName);
}

async function quarantineBundleHash(
  quarantineDirectory: string,
  rootName: string,
): Promise<string> {
  const entries: Readonly<{
    relativePath: string;
    type: 0 | 1;
    content: Buffer;
  }>[] = await readQuarantineEntries(quarantineDirectory, '');
  const rootNameBytes = Buffer.from(rootName, 'utf8');
  const rootNameLength = Buffer.alloc(2);
  rootNameLength.writeUInt16BE(rootNameBytes.length);
  const entryCount = Buffer.alloc(4);
  entryCount.writeUInt32BE(entries.length);
  const encodedEntries = entries.flatMap(entry => {
    const pathBytes = Buffer.from(entry.relativePath, 'utf8');
    const header = Buffer.alloc(13);
    header.writeUInt8(entry.type, 0);
    header.writeUInt32BE(pathBytes.length, 1);
    header.writeBigUInt64BE(BigInt(entry.content.length), 5);
    return [header, pathBytes, entry.content];
  });
  const bundle = Buffer.concat([
    Buffer.from('FCQTR001', 'ascii'),
    rootNameLength,
    rootNameBytes,
    entryCount,
    ...encodedEntries,
  ]);
  return createHash('sha256')
    .update('finance-companion/operation-quarantine-bundle/v1\0')
    .update(bundle)
    .digest('hex');
}

async function readQuarantineEntries(
  directory: string,
  relativeParent: string,
): Promise<Readonly<{ relativePath: string; type: 0 | 1; content: Buffer }>[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: Array<{
    relativePath: string;
    type: 0 | 1;
    content: Buffer;
  }> = [];
  for (const entry of entries) {
    const relativePath = relativeParent
      ? `${relativeParent}/${entry.name}`
      : entry.name;
    const entryPath = path.join(directory, entry.name);
    const status = await lstat(entryPath);
    if (status.isSymbolicLink()) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    if (status.isDirectory()) {
      result.push({ relativePath, type: 0, content: Buffer.alloc(0) });
      result.push(...(await readQuarantineEntries(entryPath, relativePath)));
      continue;
    }
    if (!status.isFile() || status.nlink !== 1) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    result.push({ relativePath, type: 1, content: await readFile(entryPath) });
  }
  return result.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath),
      Buffer.from(right.relativePath),
    ),
  );
}

async function ensureManagedParent(
  configuration: ActualAdapterConfiguration,
  directoryName: typeof operationDirectoryName | typeof quarantineDirectoryName,
  createIfMissing: boolean,
): Promise<string> {
  const actualApiDirectory = await verifyActualApiRootOwner(configuration);
  const managedParent = directChildPath(actualApiDirectory, directoryName);
  if (createIfMissing) {
    try {
      await mkdir(managedParent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  await ensureOwnedDirectory(managedParent);
  return managedParent;
}

function deriveExpectedOperationIdentity(
  configuration: ActualAdapterConfiguration,
  operation: AdapterOperation,
): Readonly<{
  operationDirectory: string;
  operationRoot: string;
  rootName: string;
}> {
  let marker: unknown;
  try {
    marker = JSON.parse(operation.operationOwnerMarker) as unknown;
  } catch {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  if (!isRecord(marker)) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  const isBankSync = operation.request.kind === 'run-account-bank-sync';
  const markerKeys = [
    'formatVersion',
    'companionInstanceId',
    'budgetBindingHash',
    'ownershipNonce',
    'rootKind',
    'rootName',
    'workerOperationId',
    ...(isBankSync ? ['jobRunId', 'accountId'] : []),
  ];
  const expectedRootName = isBankSync
    ? typeof marker.jobRunId === 'string' && isUuid(marker.jobRunId)
      ? `bank-sync-${marker.jobRunId}-${operation.workerOperationId}`
      : undefined
    : `read-${operation.workerOperationId}`;
  if (
    expectedRootName === undefined ||
    canonicalJson(marker) !== operation.operationOwnerMarker ||
    !hasExactKeys(marker, markerKeys) ||
    marker.formatVersion !== 1 ||
    marker.companionInstanceId !== configuration.companionInstanceId ||
    marker.budgetBindingHash !== configuration.budgetBindingHash ||
    marker.ownershipNonce !== operation.ownershipNonce ||
    marker.workerOperationId !== operation.workerOperationId ||
    marker.rootKind !== (isBankSync ? 'bank-sync' : 'read') ||
    marker.rootName !== expectedRootName ||
    !isUuid(operation.workerOperationId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(operation.ownershipNonce) ||
    (isBankSync && marker.accountId !== operation.request.accountId)
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  const actualApiDirectory = path.resolve(configuration.actualApiDirectory);
  const operationRoot = directChildPath(
    actualApiDirectory,
    operationDirectoryName,
  );
  const operationDirectory = directChildPath(operationRoot, expectedRootName);
  assertSamePath(operation.operationDirectory, operationDirectory);
  return { operationDirectory, operationRoot, rootName: expectedRootName };
}

function directChildPath(parent: string, childName: string): string {
  const child = path.join(parent, childName);
  if (
    childName.length === 0 ||
    path.basename(child) !== childName ||
    path.dirname(child) !== parent ||
    path.resolve(child) !== child
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  return child;
}

function assertSamePath(actual: string, expected: string): void {
  if (
    normalizePath(actual) !== normalizePath(expected) ||
    normalizePath(path.resolve(actual)) !== normalizePath(expected)
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function assertDirectOwnedOperation(
  parent: string,
  childName: string,
  operation: AdapterOperation,
): Promise<void> {
  const operationDirectory = directChildPath(parent, childName);
  const operationStatus = await lstat(operationDirectory);
  if (!operationStatus.isDirectory() || operationStatus.isSymbolicLink()) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  assertSamePath(
    await realpath(operationDirectory),
    path.resolve(operationDirectory),
  );
  const markerPath = directChildPath(
    operationDirectory,
    'operation-owner.json',
  );
  const markerStatus = await lstat(markerPath);
  if (
    !markerStatus.isFile() ||
    markerStatus.isSymbolicLink() ||
    markerStatus.nlink !== 1
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  assertSamePath(await realpath(markerPath), path.resolve(markerPath));
  if ((await readFile(markerPath, 'utf8')) !== operation.operationOwnerMarker) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new ActualAdapterError('adapter_unhealthy');
}

async function runWithDeadlines(
  operation: Promise<ActualAdapterResponse>,
  controller: AbortController,
  softTimeoutMilliseconds: number,
  hardTimeoutMilliseconds: number,
  workerExitTimeoutMilliseconds: number,
  reportSoftTimeout: () => void,
  reportHardTimeout: () => void,
): Promise<ActualAdapterResponse> {
  let softTimeout: NodeJS.Timeout | undefined;
  let hardTimeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ActualAdapterResponse>((resolve, reject) => {
      let didSettle = false;
      let didReachHardDeadline = false;
      const settle = (callback: () => void) => {
        if (didSettle) return;
        didSettle = true;
        callback();
      };
      softTimeout = setTimeout(reportSoftTimeout, softTimeoutMilliseconds);
      hardTimeout = setTimeout(() => {
        void (async () => {
          didReachHardDeadline = true;
          try {
            reportHardTimeout();
          } catch {
            // The worker must still be terminated if durable reporting fails.
          }
          controller.abort();
          const joined = await Promise.race([
            operation.then(
              () => true,
              () => true,
            ),
            new Promise<false>(resolveAfterExit =>
              setTimeout(
                () => resolveAfterExit(false),
                workerExitTimeoutMilliseconds,
              ),
            ),
          ]);
          settle(() =>
            reject(
              joined
                ? new ActualAdapterError('adapter_timeout')
                : new WorkerExitUnprovenError(),
            ),
          );
        })();
      }, hardTimeoutMilliseconds);
      void operation.then(
        response => {
          if (!didReachHardDeadline) settle(() => resolve(response));
        },
        error => {
          if (!didReachHardDeadline) {
            settle(() =>
              reject(
                error instanceof ActualAdapterError
                  ? error
                  : new ActualAdapterError('adapter_unhealthy'),
              ),
            );
          }
        },
      );
    });
  } finally {
    if (softTimeout !== undefined) clearTimeout(softTimeout);
    if (hardTimeout !== undefined) clearTimeout(hardTimeout);
  }
}

function validateConfiguration(
  configuration: ActualAdapterConfiguration,
): void {
  if (
    !isUuid(configuration.companionInstanceId) ||
    !isHash(configuration.budgetBindingHash) ||
    !/^[A-Za-z0-9_-]{43}$/.test(configuration.actualApiDirectoryNonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(configuration.serviceInstanceNonce) ||
    configuration.softTimeoutMilliseconds < 1 ||
    configuration.hardTimeoutMilliseconds <=
      configuration.softTimeoutMilliseconds ||
    configuration.workerExitTimeoutMilliseconds < 1 ||
    !isValidActualServerUrl(configuration.actualServerUrl) ||
    !configuration.actualPassword ||
    !configuration.actualBudgetId ||
    !/^[A-Z]{3}$/.test(configuration.actualBudgetCurrency) ||
    calculateBudgetBindingHash(
      configuration.actualServerUrl,
      configuration.actualBudgetId,
    ) !== configuration.budgetBindingHash
  ) {
    throw new ActualAdapterError('invalid_adapter_request');
  }
}

function validateRequest(
  request: unknown,
  context: AdapterExecutionContext | undefined,
): void {
  if (!isRecord(request) || typeof request.kind !== 'string') {
    throw new ActualAdapterError('invalid_adapter_request');
  }
  if (request.kind === 'read-budget-snapshot') {
    assertKeys(request, ['kind', 'sections'], ['transactionRange']);
    if (!Array.isArray(request.sections)) {
      throw new ActualAdapterError('invalid_adapter_request');
    }
    const knownSections = new Set([
      'accounts',
      'payees',
      'categories',
      'schedules',
    ]);
    if (
      new Set(request.sections).size !== request.sections.length ||
      request.sections.some(
        section => typeof section !== 'string' || !knownSections.has(section),
      )
    ) {
      throw new ActualAdapterError('invalid_adapter_request');
    }
    if (request.transactionRange !== undefined) {
      if (!isRecord(request.transactionRange)) {
        throw new ActualAdapterError('invalid_adapter_request');
      }
      assertKeys(
        request.transactionRange,
        ['startDate', 'endDateExclusive'],
        ['accountIds'],
      );
      const { accountIds, endDateExclusive, startDate } =
        request.transactionRange;
      if (
        typeof startDate !== 'string' ||
        typeof endDateExclusive !== 'string' ||
        !isIsoDate(startDate) ||
        !isIsoDate(endDateExclusive)
      ) {
        throw new ActualAdapterError('invalid_adapter_request');
      }
      const rangeDays =
        (Date.parse(`${endDateExclusive}T00:00:00Z`) -
          Date.parse(`${startDate}T00:00:00Z`)) /
        86_400_000;
      if (!Number.isInteger(rangeDays) || rangeDays < 1 || rangeDays > 90) {
        throw new ActualAdapterError('invalid_adapter_request');
      }
      if (
        accountIds !== undefined &&
        (!Array.isArray(accountIds) ||
          accountIds.length < 1 ||
          accountIds.length > 100 ||
          new Set(accountIds).size !== accountIds.length ||
          accountIds.some(id => typeof id !== 'string' || id.length === 0))
      ) {
        throw new ActualAdapterError('invalid_adapter_request');
      }
    }
    return;
  }
  if (request.kind === 'read-actual-target') {
    assertKeys(request, ['kind', 'target']);
    if (!isRecord(request.target)) {
      throw new ActualAdapterError('invalid_adapter_request');
    }
    assertKeys(request.target, ['kind', 'id']);
    if (
      request.target.kind !== 'transaction' ||
      typeof request.target.id !== 'string' ||
      request.target.id.length === 0
    ) {
      throw new ActualAdapterError('invalid_adapter_request');
    }
    return;
  }
  assertKeys(request, ['kind', 'accountId']);
  if (
    request.kind !== 'run-account-bank-sync' ||
    typeof request.accountId !== 'string' ||
    request.accountId.length === 0 ||
    context?.jobRunId === undefined ||
    !isUuid(context.jobRunId)
  ) {
    throw new ActualAdapterError('invalid_adapter_request');
  }
  if (
    context.workerOperationId !== undefined &&
    !isUuid(context.workerOperationId)
  ) {
    throw new ActualAdapterError('invalid_adapter_request');
  }
  if (
    context.bankSyncRetryJitterMilliseconds !== undefined &&
    (!Array.isArray(context.bankSyncRetryJitterMilliseconds) ||
      context.bankSyncRetryJitterMilliseconds.length !== 2 ||
      context.bankSyncRetryJitterMilliseconds.some(
        value => !Number.isInteger(value) || value < 0 || value > 250,
      ))
  ) {
    throw new ActualAdapterError('invalid_adapter_request');
  }
}

function validateResponse(
  configuration: ActualAdapterConfiguration,
  request: ActualAdapterRequest,
  response: ActualAdapterResponse,
  context: AdapterExecutionContext | undefined,
): void {
  if (
    !isRecord(response) ||
    !hasExactKeys(response, [
      'kind',
      response.kind === 'read-budget-snapshot'
        ? 'snapshot'
        : response.kind === 'read-actual-target'
          ? 'target'
          : 'result',
    ])
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  if (request.kind !== response.kind) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  if (response.kind === 'read-budget-snapshot') {
    if (
      request.kind !== 'read-budget-snapshot' ||
      !isRecord(response.snapshot) ||
      !isValidSnapshot(response.snapshot, request)
    ) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    const { budget } = response.snapshot;
    if (
      response.snapshot.contractVersion !== 1 ||
      budget.budgetKeyHash !== configuration.budgetBindingHash ||
      budget.currencyCode !== configuration.actualBudgetCurrency ||
      !isIsoTimestamp(budget.capturedAt)
    ) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    return;
  }
  if (
    response.kind === 'read-actual-target' &&
    request.kind === 'read-actual-target'
  ) {
    if (
      !isRecord(response.target) ||
      !hasExactKeys(response.target, [
        'contractVersion',
        'parent',
        'children',
        'targetVersionHash',
      ]) ||
      !Array.isArray(response.target.children) ||
      response.target.contractVersion !== 1 ||
      !isHash(response.target.targetVersionHash) ||
      !isValidTransaction(response.target.parent) ||
      response.target.children.some(child => !isValidTransaction(child)) ||
      new Set(response.target.children.map(child => child.id)).size !==
        response.target.children.length ||
      response.target.children.some(
        (child, index, children) =>
          index > 0 &&
          Buffer.compare(
            Buffer.from(children[index - 1].id),
            Buffer.from(child.id),
          ) >= 0,
      ) ||
      (response.target.parent.id !== request.target.id &&
        !response.target.children.some(child => child.id === request.target.id))
    ) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    const graph = {
      children: response.target.children,
      contractVersion: 1,
      parent: response.target.parent,
    };
    const graphHash = createHash('sha256')
      .update('finance-companion/actual-transaction-graph/v1\0')
      .update(canonicalJson(graph))
      .digest('hex');
    if (graphHash !== response.target.targetVersionHash) {
      throw new ActualAdapterError('adapter_unhealthy');
    }
    return;
  }
  if (
    response.kind !== 'run-account-bank-sync' ||
    request.kind !== 'run-account-bank-sync' ||
    !isRecord(response.result) ||
    !hasExactKeys(response.result, [
      'contractVersion',
      'accountId',
      'startedAt',
      'completedAt',
      'outcomeCode',
      'transactionCounts',
      'finalSyncCode',
    ])
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
  if (
    response.result.contractVersion !== 1 ||
    response.result.accountId !== request.accountId ||
    !isIsoTimestamp(response.result.startedAt) ||
    !isIsoTimestamp(response.result.completedAt) ||
    context?.jobRunId === undefined ||
    response.result.transactionCounts !== null ||
    ![
      'succeeded',
      'authentication-required',
      'rate-limited',
      'timed-out',
      'configuration-error',
      'provider-error',
      'final-sync-failed',
      'skipped',
      'canceled',
      'outcome-unknown',
    ].includes(response.result.outcomeCode) ||
    !['succeeded', 'failed', 'not-attempted', 'outcome-unknown'].includes(
      response.result.finalSyncCode,
    ) ||
    Date.parse(response.result.completedAt) <
      Date.parse(response.result.startedAt) ||
    !isValidBankSyncOutcomePair(
      response.result.outcomeCode,
      response.result.finalSyncCode,
    )
  ) {
    throw new ActualAdapterError('adapter_unhealthy');
  }
}

function isValidBankSyncOutcomePair(
  outcomeCode: string,
  finalSyncCode: string,
): boolean {
  if (outcomeCode === 'final-sync-failed') return finalSyncCode === 'failed';
  if (outcomeCode === 'outcome-unknown') {
    return finalSyncCode === 'outcome-unknown';
  }
  if (outcomeCode === 'skipped' || outcomeCode === 'canceled') {
    return finalSyncCode === 'not-attempted';
  }
  return finalSyncCode === 'succeeded';
}

function assertWithinIpcLimit(response: ActualAdapterResponse): void {
  if (Buffer.byteLength(canonicalJson(response), 'utf8') > 16 * 1024 * 1024) {
    throw new ActualAdapterError('payload_too_large');
  }
}

function assertKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const actualKeys = Object.keys(value);
  if (
    requiredKeys.some(key => !actualKeys.includes(key)) ||
    actualKeys.some(
      key => !requiredKeys.includes(key) && !optionalKeys.includes(key),
    )
  ) {
    throw new ActualAdapterError('invalid_adapter_request');
  }
}

function isValidActualServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function isValidSnapshot(
  value: unknown,
  request: Extract<ActualAdapterRequest, { kind: 'read-budget-snapshot' }>,
): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'contractVersion',
      'budget',
      'accounts',
      'payees',
      'categoryGroups',
      'categories',
      'schedules',
      'transactions',
    ])
  ) {
    return false;
  }
  if (
    !isRecord(value.budget) ||
    !hasExactKeys(value.budget, ['budgetKeyHash', 'currencyCode', 'capturedAt'])
  ) {
    return false;
  }
  return (
    hasExpectedArray(
      value,
      'accounts',
      request.sections.includes('accounts'),
      isValidAccount,
    ) &&
    hasExpectedArray(
      value,
      'payees',
      request.sections.includes('payees'),
      isValidPayee,
    ) &&
    hasExpectedArray(
      value,
      'categoryGroups',
      request.sections.includes('categories'),
      isValidCategoryGroup,
    ) &&
    hasExpectedArray(
      value,
      'categories',
      request.sections.includes('categories'),
      isValidCategory,
    ) &&
    hasExpectedArray(
      value,
      'schedules',
      request.sections.includes('schedules'),
      isValidSchedule,
    ) &&
    hasExpectedArray(
      value,
      'transactions',
      request.transactionRange !== undefined,
      isValidTransaction,
    )
  );
}

function hasExpectedArray(
  value: Record<string, unknown>,
  name: string,
  isExpected: boolean,
  validateItem: (item: unknown) => boolean,
): boolean {
  if (!isExpected) return value[name] === undefined;
  return (
    Array.isArray(value[name]) &&
    (name !== 'transactions' || value[name].length <= 10_000) &&
    value[name].every(validateItem)
  );
}

function isValidAccount(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'name',
      'offBudget',
      'closed',
      'syncSource',
      'lastSync',
      'syncStatus',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    typeof value.offBudget === 'boolean' &&
    typeof value.closed === 'boolean' &&
    (value.lastSync === null || typeof value.lastSync === 'string') &&
    (value.syncSource === null ||
      [
        'goCardless',
        'simpleFin',
        'pluggyai',
        'enableBanking',
        'akahu',
      ].includes(value.syncSource as string)) &&
    (value.syncStatus === null ||
      [
        'ok',
        'pending',
        'sync-requested',
        'failed',
        'reauth-required',
        'attention-required',
        'rate-limit-exceeded',
        'timed-out',
        'account-missing',
      ].includes(value.syncStatus as string))
  );
}

function isValidPayee(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'name', 'transferAccountId']) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.transferAccountId === null ||
      typeof value.transferAccountId === 'string')
  );
}

function isValidCategoryGroup(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'name', 'isIncome', 'hidden']) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.isIncome === 'boolean' &&
    typeof value.hidden === 'boolean'
  );
}

function isValidSchedule(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'accountId',
      'payeeId',
      'amount',
      'amountOperator',
      'recurrence',
      'isCompleted',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isNullableNonemptyString(value.accountId) &&
    isNullableNonemptyString(value.payeeId) &&
    isValidScheduleAmount(value.amount) &&
    ['is', 'isapprox', 'isbetween'].includes(value.amountOperator as string) &&
    isValidScheduleRecurrence(value.recurrence) &&
    typeof value.isCompleted === 'boolean'
  );
}

function isValidScheduleAmount(value: unknown): boolean {
  return (
    value === null ||
    Number.isSafeInteger(value) ||
    (isRecord(value) &&
      hasExactKeys(value, ['num1', 'num2']) &&
      Number.isSafeInteger(value.num1) &&
      Number.isSafeInteger(value.num2))
  );
}

function isValidScheduleRecurrence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'one-time') {
    return (
      hasExactKeys(value, ['kind', 'date']) &&
      typeof value.date === 'string' &&
      isIsoDate(value.date)
    );
  }
  return (
    value.kind === 'recurring' &&
    hasExactKeys(value, ['kind', 'frequency', 'interval', 'start']) &&
    ['weekly', 'monthly', 'yearly'].includes(value.frequency as string) &&
    Number.isSafeInteger(value.interval) &&
    (value.interval as number) > 0 &&
    typeof value.start === 'string' &&
    isIsoDate(value.start)
  );
}

function isNullableNonemptyString(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isValidCategory(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['id', 'name', 'groupId', 'isIncome', 'hidden']) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.groupId === 'string' &&
    typeof value.isIncome === 'boolean' &&
    typeof value.hidden === 'boolean'
  );
}

function isValidTransaction(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'id',
      'accountId',
      'parentId',
      'transferId',
      'date',
      'amountMinorUnits',
      'payeeId',
      'categoryId',
      'notes',
      'importedId',
      'importedPayee',
      'cleared',
      'reconciled',
      'isParent',
      'isChild',
      'isStartingBalance',
      'tombstone',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    typeof value.date === 'string' &&
    isIsoDate(value.date) &&
    Number.isSafeInteger(value.amountMinorUnits) &&
    [
      'parentId',
      'transferId',
      'payeeId',
      'categoryId',
      'notes',
      'importedId',
      'importedPayee',
    ].every(key => value[key] === null || typeof value[key] === 'string') &&
    [
      'cleared',
      'reconciled',
      'isParent',
      'isChild',
      'isStartingBalance',
      'tombstone',
    ].every(key => typeof value[key] === 'boolean')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
