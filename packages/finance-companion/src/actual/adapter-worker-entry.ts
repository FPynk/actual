import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as actualApi from '@actual-app/api';

import type {
  AdapterWorkerMessage,
  AdapterWorkerParentMessage,
  AdapterWorkerStartMessage,
} from '#actual/adapter-worker-protocol';
import {
  calculateBudgetBindingHash,
  effectiveCurrencyCode,
} from '#actual/budget-binding';
import { canonicalJson } from '#actual/canonical-json';
import { acquireActualApiLock } from '#actual/operation-lock';
import type {
  ActualAdapterRequest,
  ActualAdapterResponse,
  ActualTransactionV1,
  SubscriptionScheduleSnapshotV1,
} from '#contracts/adapter';

let initialization:
  | Readonly<{
      message: AdapterWorkerStartMessage;
      releaseLock: () => Promise<void>;
    }>
  | undefined;
let isRequestRunning = false;
let isFinalized = false;

process.on('message', (message: AdapterWorkerParentMessage) => {
  if (message.kind === 'start' && initialization === undefined) {
    void initializeWorker(message);
    return;
  }
  if (
    message.kind === 'request' &&
    initialization !== undefined &&
    !isRequestRunning
  ) {
    isRequestRunning = true;
    void runWorkerRequest(initialization, message.request);
    return;
  }
  if (
    message.kind === 'terminate' &&
    initialization !== undefined &&
    !isRequestRunning
  ) {
    void finalizeWorker(initialization, {
      kind: 'problem',
      code: 'adapter_unhealthy',
    });
  }
});

async function initializeWorker(
  message: AdapterWorkerStartMessage,
): Promise<void> {
  try {
    await verifyOperationOwnership(message);
    verifyBudgetBinding(message);
    const releaseLock = await acquireActualApiLock(
      message.configuration.actualApiDirectory,
      message.workerOperationId,
      message.configuration.actualApiDirectoryNonce,
      message.configuration.serviceInstanceNonce,
    );
    initialization = { message, releaseLock };
    send({ kind: 'ready' });
  } catch {
    send({ kind: 'problem', code: 'adapter_unhealthy' });
    process.exitCode = 1;
    process.disconnect();
  }
}

async function runWorkerRequest(
  worker: NonNullable<typeof initialization>,
  request: ActualAdapterRequest,
): Promise<void> {
  let terminalMessage: Extract<
    AdapterWorkerMessage,
    { kind: 'result' | 'problem' }
  >;
  try {
    const { message } = worker;
    verifyRequestMatchesMarker(message, request);
    await actualApi.init({
      dataDir: message.operationDirectory,
      password: message.configuration.actualPassword,
      serverURL: message.configuration.actualServerUrl,
      verbose: false,
    });
    await actualApi.downloadBudget(message.configuration.actualBudgetId, {
      password: message.configuration.actualBudgetEncryptionPassword,
    });
    const preferences = await actualApi.getPreferences();
    const currencyCode = effectiveCurrencyCode(preferences);
    if (currencyCode !== message.configuration.actualBudgetCurrency) {
      throw new Error('Budget currency changed.');
    }
    terminalMessage = resultMessage(
      await executeRequest(
        request,
        currencyCode,
        message.configuration.budgetBindingHash,
      ),
    );
  } catch {
    terminalMessage = { kind: 'problem', code: 'adapter_unhealthy' };
  }
  await finalizeWorker(worker, terminalMessage);
}

async function finalizeWorker(
  worker: NonNullable<typeof initialization>,
  terminalMessage: Extract<
    AdapterWorkerMessage,
    { kind: 'result' | 'problem' }
  >,
): Promise<void> {
  if (isFinalized) return;
  isFinalized = true;
  send(terminalMessage);
  try {
    await actualApi.shutdown();
    await worker.releaseLock();
    send({ kind: 'shutdown-complete' });
  } catch {
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
}

function resultMessage(
  response: ActualAdapterResponse,
): Extract<AdapterWorkerMessage, { kind: 'result' | 'problem' }> {
  const message = {
    kind: 'result',
    response,
  } as const;
  if (Buffer.byteLength(canonicalJson(message), 'utf8') > 16 * 1024 * 1024) {
    return { kind: 'problem', code: 'payload_too_large' };
  }
  return message;
}

async function executeRequest(
  request: ActualAdapterRequest,
  currencyCode: string,
  budgetBindingHash: string,
): Promise<ActualAdapterResponse> {
  if (request.kind === 'read-budget-snapshot') {
    return {
      kind: request.kind,
      snapshot: await readSnapshot(request, currencyCode, budgetBindingHash),
    };
  }
  if (request.kind === 'read-actual-target') {
    return {
      kind: request.kind,
      target: await readTransactionTarget(request.target.id),
    };
  }
  return {
    kind: request.kind,
    result: await runAccountBankSync(request.accountId),
  };
}

async function readSnapshot(
  request: Extract<ActualAdapterRequest, { kind: 'read-budget-snapshot' }>,
  currencyCode: string,
  budgetBindingHash: string,
) {
  const requestedSections = new Set(request.sections);
  const snapshot: Record<string, unknown> = {
    budget: {
      budgetKeyHash: budgetBindingHash,
      capturedAt: new Date().toISOString(),
      currencyCode,
    },
    contractVersion: 1,
  };
  if (requestedSections.has('accounts')) {
    snapshot.accounts = (await readAccountRows()).map(projectAccount);
  }
  if (requestedSections.has('payees')) {
    snapshot.payees = (await actualApi.getPayees()).map(projectPayee);
  }
  if (requestedSections.has('categories')) {
    snapshot.categoryGroups = (await actualApi.getCategoryGroups()).map(
      projectCategoryGroup,
    );
    snapshot.categories = (await actualApi.getCategories()).map(
      projectCategory,
    );
  }
  if (requestedSections.has('schedules')) {
    snapshot.schedules = (await actualApi.getSchedules())
      .flatMap(schedule => {
        const projectedSchedule = projectSchedule(schedule);
        return projectedSchedule === null ? [] : [projectedSchedule];
      })
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
      );
  }
  if (request.transactionRange !== undefined) {
    const accountIds =
      request.transactionRange.accountIds ??
      (await readAccountRows()).map(account => requiredString(account.id));
    const transactions = await Promise.all(
      accountIds.map(accountId =>
        actualApi.getTransactions(
          accountId,
          request.transactionRange!.startDate,
          dateBefore(request.transactionRange!.endDateExclusive),
        ),
      ),
    );
    const projected = transactions.flatMap(rows =>
      rows.map(projectTransaction),
    );
    if (projected.length > 10_000) throw new Error('Snapshot exceeds limit.');
    snapshot.transactions = projected;
  }
  return snapshot as ActualAdapterResponse extends Readonly<{
    kind: 'read-budget-snapshot';
    snapshot: infer Snapshot;
  }>
    ? Snapshot
    : never;
}

async function readTransactionTarget(id: string) {
  const initialRows = await actualApi.aqlQuery(
    actualApi
      .q('transactions')
      .filter({ id })
      .select('*')
      .options({ splits: 'grouped' }),
  );
  const initial = asRows(initialRows)[0];
  if (initial === undefined) throw new Error('Target transaction is missing.');
  const parentRow =
    initial.is_child === true && typeof initial.parent_id === 'string'
      ? asRows(
          await actualApi.aqlQuery(
            actualApi
              .q('transactions')
              .filter({ id: initial.parent_id })
              .select('*')
              .options({ splits: 'grouped' }),
          ),
        )[0]
      : initial;
  if (parentRow === undefined) throw new Error('Target parent is missing.');
  const parent = projectTransaction(parentRow);
  const children = asRows(parentRow.subtransactions)
    .map(projectTransaction)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
    );
  if (new Set(children.map(child => child.id)).size !== children.length) {
    throw new Error('Target has duplicate children.');
  }
  const canonicalGraph = { children, contractVersion: 1 as const, parent };
  return {
    ...canonicalGraph,
    targetVersionHash: createHash('sha256')
      .update('finance-companion/actual-transaction-graph/v1\0')
      .update(canonicalJson(canonicalGraph))
      .digest('hex'),
  };
}

async function runAccountBankSync(accountId: string) {
  const startedAt = new Date().toISOString();
  let outcomeCode:
    | 'succeeded'
    | 'authentication-required'
    | 'rate-limited'
    | 'timed-out'
    | 'configuration-error'
    | 'provider-error' = 'succeeded';
  try {
    await actualApi.runBankSync({ accountId });
  } catch {
    const account = (await readAccountRows()).find(row => row.id === accountId);
    outcomeCode = mapBankSyncFailure(account?.bank_sync_status);
  }
  try {
    await actualApi.sync();
    return {
      accountId,
      completedAt: new Date().toISOString(),
      contractVersion: 1 as const,
      finalSyncCode: 'succeeded' as const,
      outcomeCode,
      startedAt,
      transactionCounts: null,
    };
  } catch {
    return {
      accountId,
      completedAt: new Date().toISOString(),
      contractVersion: 1 as const,
      finalSyncCode: 'failed' as const,
      outcomeCode: 'final-sync-failed' as const,
      startedAt,
      transactionCounts: null,
    };
  }
}

async function readAccountRows(): Promise<Record<string, unknown>[]> {
  return asRows(await actualApi.aqlQuery(actualApi.q('accounts').select('*')));
}

function mapBankSyncFailure(
  status: unknown,
):
  | 'authentication-required'
  | 'rate-limited'
  | 'timed-out'
  | 'configuration-error'
  | 'provider-error' {
  if (status === 'reauth-required') return 'authentication-required';
  if (status === 'rate-limit-exceeded') return 'rate-limited';
  if (status === 'timed-out') return 'timed-out';
  if (status === 'account-missing' || status === undefined) {
    return 'configuration-error';
  }
  return 'provider-error';
}

async function verifyOperationOwnership(
  message: AdapterWorkerStartMessage,
): Promise<void> {
  const rootStatus = await lstat(message.configuration.actualApiDirectory);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error('Actual API root is invalid.');
  }
  const ownerPath = path.join(
    message.configuration.actualApiDirectory,
    'owner.json',
  );
  const ownerStatus = await lstat(ownerPath);
  if (!ownerStatus.isFile() || ownerStatus.isSymbolicLink()) {
    throw new Error('Actual API root owner is invalid.');
  }
  const serializedOwner = await readFile(ownerPath, 'utf8');
  const owner = JSON.parse(serializedOwner) as Record<string, unknown>;
  if (
    canonicalJson(owner) !== serializedOwner ||
    !hasExactMarkerKeys(owner, [
      'formatVersion',
      'companionInstanceId',
      'budgetBindingHash',
      'directoryNonce',
    ]) ||
    owner.formatVersion !== 1 ||
    owner.companionInstanceId !== message.configuration.companionInstanceId ||
    owner.budgetBindingHash !== message.configuration.budgetBindingHash ||
    owner.directoryNonce !== message.configuration.actualApiDirectoryNonce
  ) {
    throw new Error('Actual API root owner does not match.');
  }
  const expectedRoot = path.join(
    message.configuration.actualApiDirectory,
    'operations',
  );
  if (path.dirname(message.operationDirectory) !== expectedRoot) {
    throw new Error('Operation directory escaped its root.');
  }
  const operationStatus = await lstat(message.operationDirectory);
  if (!operationStatus.isDirectory() || operationStatus.isSymbolicLink()) {
    throw new Error('Operation directory is not owned.');
  }
  const markerPath = path.join(
    message.operationDirectory,
    'operation-owner.json',
  );
  const markerStatus = await lstat(markerPath);
  if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) {
    throw new Error('Operation marker is invalid.');
  }
  const marker = await readFile(markerPath, 'utf8');
  const parsedMarker = JSON.parse(marker) as Record<string, unknown>;
  const commonMarkerKeys = [
    'formatVersion',
    'companionInstanceId',
    'budgetBindingHash',
    'ownershipNonce',
    'rootKind',
    'rootName',
    'workerOperationId',
  ];
  const markerKeys =
    parsedMarker.rootKind === 'bank-sync'
      ? [...commonMarkerKeys, 'jobRunId', 'accountId']
      : commonMarkerKeys;
  if (
    marker !== message.operationOwnerMarker ||
    canonicalJson(parsedMarker) !== marker ||
    !hasExactMarkerKeys(parsedMarker, markerKeys) ||
    parsedMarker.formatVersion !== 1 ||
    parsedMarker.companionInstanceId !==
      message.configuration.companionInstanceId ||
    parsedMarker.budgetBindingHash !==
      message.configuration.budgetBindingHash ||
    parsedMarker.ownershipNonce !== message.ownershipNonce ||
    parsedMarker.workerOperationId !== message.workerOperationId ||
    !['read', 'bank-sync'].includes(parsedMarker.rootKind as string) ||
    path.basename(message.operationDirectory) !== parsedMarker.rootName ||
    (parsedMarker.rootKind === 'read' &&
      parsedMarker.rootName !== `read-${message.workerOperationId}`) ||
    (parsedMarker.rootKind === 'bank-sync' &&
      (typeof parsedMarker.jobRunId !== 'string' ||
        !isCanonicalUuid(parsedMarker.jobRunId) ||
        parsedMarker.rootName !==
          `bank-sync-${parsedMarker.jobRunId}-${message.workerOperationId}`))
  ) {
    throw new Error('Operation marker changed.');
  }
}

function verifyRequestMatchesMarker(
  message: AdapterWorkerStartMessage,
  request: ActualAdapterRequest,
): void {
  const marker = JSON.parse(message.operationOwnerMarker) as Record<
    string,
    unknown
  >;
  if (
    (request.kind === 'run-account-bank-sync' &&
      (marker.rootKind !== 'bank-sync' ||
        marker.accountId !== request.accountId)) ||
    (request.kind !== 'run-account-bank-sync' && marker.rootKind !== 'read')
  ) {
    throw new Error('Operation marker does not match request.');
  }
}

function hasExactMarkerKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
  );
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
}

function verifyBudgetBinding(message: AdapterWorkerStartMessage): void {
  const expectedBindingHash = calculateBudgetBindingHash(
    message.configuration.actualServerUrl,
    message.configuration.actualBudgetId,
  );
  if (expectedBindingHash !== message.configuration.budgetBindingHash) {
    throw new Error('Budget binding does not match.');
  }
}

function projectAccount(account: Record<string, unknown>) {
  return {
    closed: account.closed === true,
    id: requiredString(account.id),
    lastSync: nullableString(account.last_sync),
    name: requiredString(account.name),
    offBudget: account.offbudget === true,
    syncSource: validSyncSource(account.account_sync_source),
    syncStatus: validSyncStatus(account.bank_sync_status),
  };
}

function projectPayee(payee: Record<string, unknown>) {
  return {
    id: requiredString(payee.id),
    name: requiredString(payee.name),
    transferAccountId: nullableString(payee.transfer_acct),
  };
}

function projectCategoryGroup(group: Record<string, unknown>) {
  return {
    hidden: group.hidden === true,
    id: requiredString(group.id),
    isIncome: group.is_income === true,
    name: requiredString(group.name),
  };
}

function projectCategory(category: Record<string, unknown>) {
  return {
    groupId: requiredString(category.group_id),
    hidden: category.hidden === true,
    id: requiredString(category.id),
    isIncome: category.is_income === true,
    name: requiredString(category.name),
  };
}

function projectTransaction(
  transaction: Record<string, unknown>,
): ActualTransactionV1 {
  return {
    accountId: requiredString(transaction.account),
    amountMinorUnits: requiredNumber(transaction.amount),
    categoryId: nullableString(transaction.category),
    cleared: transaction.cleared === true,
    date: requiredString(transaction.date),
    id: requiredString(transaction.id),
    importedId: nullableString(transaction.imported_id),
    importedPayee: nullableString(transaction.imported_payee),
    isChild: transaction.is_child === true,
    isParent: transaction.is_parent === true,
    isStartingBalance: transaction.starting_balance_flag === true,
    notes: nullableString(transaction.notes),
    parentId: nullableString(transaction.parent_id),
    payeeId: nullableString(transaction.payee),
    reconciled: transaction.reconciled === true,
    tombstone: transaction.tombstone === true,
    transferId: nullableString(transaction.transfer_id),
  };
}

function projectSchedule(
  schedule: Awaited<ReturnType<typeof actualApi.getSchedules>>[number],
): SubscriptionScheduleSnapshotV1 | null {
  const recurrence = projectScheduleRecurrence(schedule.date);
  if (recurrence === null) return null;
  return {
    accountId: nullableNonemptyString(schedule.account),
    amount: projectScheduleAmount(schedule.amount),
    amountOperator: validScheduleAmountOperator(schedule.amountOp),
    id: requiredNonemptyString(schedule.id),
    isCompleted: schedule.completed === true,
    payeeId: nullableNonemptyString(schedule.payee),
    recurrence,
  };
}

function projectScheduleRecurrence(
  value: Awaited<ReturnType<typeof actualApi.getSchedules>>[number]['date'],
): SubscriptionScheduleSnapshotV1['recurrence'] | null {
  if (typeof value === 'string') {
    if (!isIsoDate(value)) throw new Error('Actual returned an invalid date.');
    return { date: value, kind: 'one-time' };
  }
  if (value.frequency === 'daily') return null;
  const interval = value.interval ?? 1;
  if (
    !['weekly', 'monthly', 'yearly'].includes(value.frequency) ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !isIsoDate(value.start)
  ) {
    throw new Error('Actual returned an invalid schedule recurrence.');
  }
  return {
    frequency: value.frequency,
    interval,
    kind: 'recurring',
    start: value.start,
  };
}

function projectScheduleAmount(
  value: Awaited<ReturnType<typeof actualApi.getSchedules>>[number]['amount'],
): SubscriptionScheduleSnapshotV1['amount'] {
  if (value === undefined) return null;
  if (typeof value === 'number') return requiredNumber(value);
  if (!Number.isSafeInteger(value.num1) || !Number.isSafeInteger(value.num2)) {
    throw new Error('Actual returned an invalid schedule amount.');
  }
  return { num1: value.num1, num2: value.num2 };
}

function validScheduleAmountOperator(
  value: unknown,
): SubscriptionScheduleSnapshotV1['amountOperator'] {
  if (!['is', 'isapprox', 'isbetween'].includes(value as string)) {
    throw new Error('Actual returned an invalid schedule amount operator.');
  }
  return value as SubscriptionScheduleSnapshotV1['amountOperator'];
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.data)) {
    return value.data.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Actual returned an invalid value.');
  }
  return value;
}

function requiredNonemptyString(value: unknown): string {
  const result = requiredString(value);
  if (result.length === 0) throw new Error('Actual returned an invalid value.');
  return result;
}

function nullableNonemptyString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredNonemptyString(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Actual returned an invalid amount.');
  }
  return value;
}

function validSyncSource(value: unknown) {
  return [
    'goCardless',
    'simpleFin',
    'pluggyai',
    'enableBanking',
    'akahu',
  ].includes(value as string)
    ? (value as
        | 'goCardless'
        | 'simpleFin'
        | 'pluggyai'
        | 'enableBanking'
        | 'akahu')
    : null;
}

function validSyncStatus(value: unknown) {
  return [
    'ok',
    'pending',
    'sync-requested',
    'failed',
    'reauth-required',
    'attention-required',
    'rate-limit-exceeded',
    'timed-out',
    'account-missing',
  ].includes(value as string)
    ? (value as
        | 'ok'
        | 'pending'
        | 'sync-requested'
        | 'failed'
        | 'reauth-required'
        | 'attention-required'
        | 'rate-limit-exceeded'
        | 'timed-out'
        | 'account-missing')
    : null;
}

function dateBefore(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function send(message: AdapterWorkerMessage): void {
  process.send?.(message);
}
