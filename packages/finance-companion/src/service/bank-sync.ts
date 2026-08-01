import { createHash, randomUUID } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  AccountBankSyncOutcomeCode,
  ActualAccountV1,
} from '#contracts/adapter';
import { ActualAdapterError } from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import { withExclusiveMaintenanceLockSync } from '#database/maintenance-lock';
import { calculateRequestReplayHash } from '#http/request-idempotency';
import { canonicalJson } from '#integrity/canonical-hash';

const BANK_SYNC_CLI_OPERATION_ID = 'finance-companion/job:bank-sync/v1';
const BANK_SYNC_HTTP_OPERATION_ID = 'finance-companion/http/bank-sync/v1';
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BankSyncInvocationKind = 'local_http' | 'local_cli' | 'scheduler';
export type BankSyncJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'outcome_unknown';
export type BankSyncAccountOutcome = AccountBankSyncOutcomeCode;

export type BankSyncJobSummary = Readonly<{
  id: string;
  kind: 'bank-sync';
  status: BankSyncJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  accountResults: readonly Readonly<{
    accountId: string;
    outcomeCode: BankSyncAccountOutcome;
    transactionCounts: null;
  }>[];
  retryable: boolean;
}>;

export type BankSyncJobRequest = Readonly<{
  accountIds: readonly string[] | null;
  idempotencyKey: string;
  invocationKind: BankSyncInvocationKind;
  principalId: string;
}>;

export type BankSyncJobPage = Readonly<{
  items: readonly BankSyncJobSummary[];
  nextCursor: string | null;
}>;

export type BankSyncJobPageRequest = Readonly<{
  budgetKeyHash: string;
  principalId: string;
  cursor: string | null;
  limit: number;
}>;

export type BankSyncLogEvent = Readonly<{
  timestamp: string;
  severity: 'info' | 'warn' | 'error';
  eventCode: string;
  jobId: string;
  workerOperationId?: string;
  budgetKeyHash: string;
  accountId?: string;
  errorCode?: string;
}>;

export type BankSyncJobDependencies = Readonly<{
  adapter: Pick<ActualAdapter, 'execute'>;
  budgetKeyHash: string;
  repository: BankSyncJobRepository;
  now?: () => Date;
  jitterMilliseconds?: () => number;
  signal?: AbortSignal;
  log?: (event: BankSyncLogEvent) => void;
}>;

export type ParsedBankSyncCommand = Readonly<{
  accountIds: readonly string[] | null;
  idempotencyKey: string;
  invocationKind: BankSyncInvocationKind;
}>;

export class BankSyncJobError extends Error {
  readonly code:
    | 'invalid_request'
    | 'configuration_error'
    | 'operation_in_progress'
    | 'idempotency_conflict'
    | 'adapter_unavailable';

  constructor(
    code:
      | 'invalid_request'
      | 'configuration_error'
      | 'operation_in_progress'
      | 'idempotency_conflict'
      | 'adapter_unavailable',
  ) {
    super(code);
    this.code = code;
    this.name = 'BankSyncJobError';
  }
}

export function parseBankSyncCommandArguments(
  arguments_: readonly string[],
): ParsedBankSyncCommand {
  let idempotencyKey: string | undefined;
  let invocationKind: BankSyncInvocationKind = 'local_cli';
  const accountIds: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--scheduler') {
      if (invocationKind === 'scheduler') {
        throw new BankSyncJobError('invalid_request');
      }
      invocationKind = 'scheduler';
      continue;
    }
    if (argument === '--idempotency-key' || argument === '--account-id') {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new BankSyncJobError('invalid_request');
      }
      index += 1;
      if (argument === '--idempotency-key') {
        if (idempotencyKey !== undefined) {
          throw new BankSyncJobError('invalid_request');
        }
        idempotencyKey = value;
      } else {
        accountIds.push(value);
      }
      continue;
    }
    throw new BankSyncJobError('invalid_request');
  }
  if (idempotencyKey === undefined) {
    throw new BankSyncJobError('invalid_request');
  }
  return {
    accountIds: accountIds.length === 0 ? null : accountIds,
    idempotencyKey,
    invocationKind,
  };
}

export type BankSyncJobScope = Readonly<{
  budgetKeyHash: string;
  principalId: string;
  invocationKind: BankSyncInvocationKind;
  idempotencyKey: string;
  requestHash: string;
}>;

type BankSyncChild = Readonly<{
  accountId: string;
  ordinal: number;
  workerOperationId: string;
}>;

type DurableBankSyncJob = Readonly<{
  id: string;
  children: readonly BankSyncChild[];
  summary: BankSyncJobSummary;
}>;

export type BankSyncJobRepository = Readonly<{
  find: (
    scope: BankSyncJobScope,
  ) =>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'replay'; summary: BankSyncJobSummary }>
    | Readonly<{ kind: 'in-progress' }>
    | Readonly<{ kind: 'blocked' }>
    | Readonly<{ kind: 'conflict' }>;
  create: (
    scope: BankSyncJobScope,
    accountIds: readonly string[],
  ) =>
    | Readonly<{ kind: 'created'; job: DurableBankSyncJob }>
    | Readonly<{ kind: 'replay'; summary: BankSyncJobSummary }>
    | Readonly<{ kind: 'in-progress' }>
    | Readonly<{ kind: 'blocked' }>
    | Readonly<{ kind: 'conflict' }>;
  markRunning: (jobId: string, startedAt: string) => void;
  markAccount: (
    jobId: string,
    workerOperationId: string,
    status: 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'outcome_unknown',
    completedAt: string,
  ) => void;
  complete: (summary: BankSyncJobSummary) => void;
  completeOutcomeUnknown: (
    summary: BankSyncJobSummary,
    workerOperationId: string,
    untouchedWorkerOperationIds: readonly string[],
    quarantineBundleHash: string | undefined,
  ) => void;
  completeSafetyOutcome: (
    summary: BankSyncJobSummary,
    workerOperationId: string,
    untouchedWorkerOperationIds: readonly string[],
  ) => void;
}>;

export function createSqliteBankSyncJobRepository(
  databasePath: string,
): BankSyncJobRepository {
  return createSqliteBankSyncJobRepositoryWithLockState(databasePath, false);
}

export function createSqliteBankSyncJobRepositoryDuringMaintenance(
  databasePath: string,
): BankSyncJobRepository {
  return createSqliteBankSyncJobRepositoryWithLockState(databasePath, true);
}

export function listSqliteBankSyncJobRuns(
  databasePath: string,
  request: BankSyncJobPageRequest,
): BankSyncJobPage {
  if (
    !/^[0-9a-f]{64}$/.test(request.budgetKeyHash) ||
    !CANONICAL_UUID_PATTERN.test(request.principalId) ||
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100 ||
    (request.cursor !== null && !CANONICAL_UUID_PATTERN.test(request.cursor))
  ) {
    throw new BankSyncJobError('invalid_request');
  }
  return withDatabase(databasePath, database => {
    let beforeRowId: number | null = null;
    if (request.cursor !== null) {
      const cursorRow = database
        .prepare(
          "SELECT rowid AS row_id FROM job_runs WHERE id = ? AND job_kind = 'bank_sync' AND budget_key_hash = ? AND principal_id = ?",
        )
        .get(request.cursor, request.budgetKeyHash, request.principalId) as
        | Readonly<{ row_id: number }>
        | undefined;
      if (cursorRow === undefined) {
        throw new BankSyncJobError('invalid_request');
      }
      beforeRowId = cursorRow.row_id;
    }
    const rows = database
      .prepare(
        `SELECT id, status, started_at, completed_at, summary_json
         FROM job_runs
         WHERE job_kind = 'bank_sync'
           AND budget_key_hash = ?
           AND principal_id = ?
           AND (? IS NULL OR rowid < ?)
         ORDER BY rowid DESC
         LIMIT ?`,
      )
      .all(
        request.budgetKeyHash,
        request.principalId,
        beforeRowId,
        beforeRowId,
        request.limit + 1,
      ) as readonly BankSyncJobRunRow[];
    const pageRows = rows.slice(0, request.limit);
    return {
      items: pageRows.map(parseJobRunRow),
      nextCursor:
        rows.length > request.limit ? (pageRows.at(-1)?.id ?? null) : null,
    };
  });
}

function createSqliteBankSyncJobRepositoryWithLockState(
  databasePath: string,
  alreadyHoldsMaintenanceLock: boolean,
): BankSyncJobRepository {
  const create = (
    scope: BankSyncJobScope,
    accountIds: readonly string[],
  ): ReturnType<BankSyncJobRepository['create']> =>
    withDatabase(databasePath, database =>
      database
        .transaction(() => createJob(database, scope, accountIds))
        .immediate(),
    );
  return {
    find: scope =>
      withDatabase(databasePath, database => findJob(database, scope)),
    create: (scope, accountIds) =>
      alreadyHoldsMaintenanceLock
        ? create(scope, accountIds)
        : withExclusiveMaintenanceLockSync(databasePath, () =>
            create(scope, accountIds),
          ),
    markRunning: (jobId, startedAt) =>
      withDatabase(databasePath, database => {
        const result = database
          .prepare(
            "UPDATE job_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
          )
          .run(startedAt, jobId);
        if (result.changes !== 1) {
          throw new Error('The bank-sync job is not queued.');
        }
      }),
    markAccount: (jobId, workerOperationId, status, completedAt) =>
      withDatabase(databasePath, database => {
        const result = database
          .prepare(
            'UPDATE job_run_account_operations SET status = ?, completed_at = ? WHERE job_run_id = ? AND worker_operation_id = ?',
          )
          .run(status, completedAt, jobId, workerOperationId);
        if (result.changes !== 1) {
          throw new Error('The bank-sync account is missing.');
        }
      }),
    complete: summary =>
      withDatabase(databasePath, database => {
        const result = database
          .prepare(
            "UPDATE job_runs SET status = ?, completed_at = ?, summary_json = ? WHERE id = ? AND status = 'running'",
          )
          .run(
            summary.status,
            summary.completedAt,
            JSON.stringify(summary),
            summary.id,
          );
        if (result.changes !== 1) {
          throw new Error('The bank-sync job is not running.');
        }
      }),
    completeOutcomeUnknown: (
      summary,
      workerOperationId,
      untouchedWorkerOperationIds,
      quarantineBundleHash,
    ) =>
      withDatabase(databasePath, database =>
        persistSafetyOutcome(
          database,
          summary,
          workerOperationId,
          untouchedWorkerOperationIds,
          'outcome_unknown',
          'skipped',
          quarantineBundleHash,
        ),
      ),
    completeSafetyOutcome: (
      summary,
      workerOperationId,
      untouchedWorkerOperationIds,
    ) =>
      withDatabase(databasePath, database =>
        persistSafetyOutcome(
          database,
          summary,
          workerOperationId,
          untouchedWorkerOperationIds,
          summary.status === 'outcome_unknown' ? 'outcome_unknown' : 'canceled',
          summary.status === 'outcome_unknown' ? 'skipped' : 'canceled',
          undefined,
        ),
      ),
  };
}

function persistSafetyOutcome(
  database: ReturnType<typeof openCompanionDatabase>,
  summary: BankSyncJobSummary,
  workerOperationId: string,
  untouchedWorkerOperationIds: readonly string[],
  currentStatus: 'canceled' | 'outcome_unknown',
  untouchedStatus: 'canceled' | 'skipped',
  quarantineBundleHash: string | undefined,
): void {
  database
    .transaction(() => {
      const completedAt = summary.completedAt;
      const current = database
        .prepare(
          "UPDATE job_run_account_operations SET status = ?, quarantine_bundle_hash = COALESCE(?, quarantine_bundle_hash), completed_at = ? WHERE job_run_id = ? AND worker_operation_id = ? AND status IN ('queued', ?)",
        )
        .run(
          currentStatus,
          quarantineBundleHash ?? null,
          completedAt,
          summary.id,
          workerOperationId,
          currentStatus,
        );
      if (current.changes !== 1) {
        throw new Error('The bank-sync account is missing.');
      }
      const updateUntouched = database.prepare(
        "UPDATE job_run_account_operations SET status = ?, completed_at = ? WHERE job_run_id = ? AND worker_operation_id = ? AND status IN ('queued', ?)",
      );
      for (const untouchedWorkerOperationId of untouchedWorkerOperationIds) {
        if (
          updateUntouched.run(
            untouchedStatus,
            completedAt,
            summary.id,
            untouchedWorkerOperationId,
            untouchedStatus,
          ).changes !== 1
        ) {
          throw new Error('An untouched bank-sync account is missing.');
        }
      }
      const parent = database
        .prepare(
          "UPDATE job_runs SET status = ?, completed_at = ?, summary_json = ? WHERE id = ? AND status IN ('running', ?)",
        )
        .run(
          summary.status,
          completedAt,
          JSON.stringify(summary),
          summary.id,
          summary.status,
        );
      if (parent.changes !== 1) {
        throw new Error('The bank-sync job is not running.');
      }
    })
    .immediate();
}

export async function runOneShotBankSyncJob(
  request: BankSyncJobRequest,
  dependencies: BankSyncJobDependencies,
): Promise<BankSyncJobSummary> {
  const accountIds = validateRequest(request);
  const now = dependencies.now ?? (() => new Date());
  const signal = dependencies.signal ?? new AbortController().signal;
  const scope: BankSyncJobScope = {
    budgetKeyHash: dependencies.budgetKeyHash,
    idempotencyKey: request.idempotencyKey,
    invocationKind: request.invocationKind,
    principalId: request.principalId,
    requestHash: calculateRequestReplayHash({ accountIds }),
  };
  const existing = dependencies.repository.find(scope);
  if (existing.kind === 'replay') {
    return existing.summary;
  }
  if (existing.kind === 'in-progress') {
    throw new BankSyncJobError('operation_in_progress');
  }
  if (existing.kind === 'blocked') {
    throw new BankSyncJobError('adapter_unavailable');
  }
  if (existing.kind === 'conflict') {
    throw new BankSyncJobError('idempotency_conflict');
  }

  let snapshot: Awaited<ReturnType<ActualAdapter['execute']>>;
  try {
    snapshot = await dependencies.adapter.execute({
      kind: 'read-budget-snapshot',
      sections: ['accounts'],
    });
  } catch {
    throw new BankSyncJobError('adapter_unavailable');
  }
  if (
    snapshot.kind !== 'read-budget-snapshot' ||
    snapshot.snapshot.accounts === undefined
  ) {
    throw new BankSyncJobError('configuration_error');
  }
  const selectedAccounts = selectAccounts(
    snapshot.snapshot.accounts,
    accountIds,
  );
  const created = dependencies.repository.create(
    scope,
    selectedAccounts.map(account => account.id),
  );
  if (created.kind === 'replay') {
    return created.summary;
  }
  if (created.kind === 'in-progress') {
    throw new BankSyncJobError('operation_in_progress');
  }
  if (created.kind === 'blocked') {
    throw new BankSyncJobError('adapter_unavailable');
  }
  if (created.kind === 'conflict') {
    throw new BankSyncJobError('idempotency_conflict');
  }

  const job = created.job;
  const startedAt = now().toISOString();
  dependencies.repository.markRunning(job.id, startedAt);
  const results: Array<BankSyncJobSummary['accountResults'][number]> = [];
  let shouldCancelUntouched = false;

  for (const [index, account] of selectedAccounts.entries()) {
    const child = job.children[index];
    if (child === undefined) {
      throw new Error('Bank-sync child rows are incomplete.');
    }
    let outcomeCode: BankSyncAccountOutcome;
    if (shouldCancelUntouched || signal.aborted) {
      outcomeCode = 'canceled';
      shouldCancelUntouched = true;
    } else if (account.closed) {
      outcomeCode = 'skipped';
    } else {
      const accountResult = await runAccount(
        job.id,
        child,
        dependencies,
        signal,
        now,
        safetyOutcome => {
          const untouchedAccounts = selectedAccounts.slice(index + 1);
          const safetyResults = [
            ...results,
            {
              accountId: account.id,
              outcomeCode: safetyOutcome,
              transactionCounts: null,
            },
            ...untouchedAccounts.map(untouchedAccount => ({
              accountId: untouchedAccount.id,
              outcomeCode:
                safetyOutcome === 'outcome-unknown'
                  ? ('skipped' as const)
                  : ('canceled' as const),
              transactionCounts: null,
            })),
          ];
          const safetySummary = createSummary(
            job.id,
            startedAt,
            now,
            safetyResults,
          );
          dependencies.repository.completeSafetyOutcome(
            safetySummary,
            child.workerOperationId,
            job.children
              .slice(index + 1)
              .map(untouchedChild => untouchedChild.workerOperationId),
          );
          return safetySummary;
        },
      );
      outcomeCode = accountResult.outcomeCode;
      if (accountResult.persistedSummary !== undefined) {
        if (outcomeCode === 'outcome-unknown') {
          dependencies.repository.completeOutcomeUnknown(
            accountResult.persistedSummary,
            child.workerOperationId,
            job.children
              .slice(index + 1)
              .map(untouchedChild => untouchedChild.workerOperationId),
            accountResult.quarantineBundleHash,
          );
        }
        return accountResult.persistedSummary;
      }
      if (outcomeCode === 'outcome-unknown') {
        results.push({
          accountId: account.id,
          outcomeCode,
          transactionCounts: null,
        });
        const untouchedAccounts = selectedAccounts.slice(index + 1);
        results.push(
          ...untouchedAccounts.map(untouchedAccount => ({
            accountId: untouchedAccount.id,
            outcomeCode: 'skipped' as const,
            transactionCounts: null,
          })),
        );
        const summary = createSummary(job.id, startedAt, now, results);
        dependencies.repository.completeOutcomeUnknown(
          summary,
          child.workerOperationId,
          job.children
            .slice(index + 1)
            .map(untouchedChild => untouchedChild.workerOperationId),
          accountResult.quarantineBundleHash,
        );
        return summary;
      }
      if (signal.aborted) shouldCancelUntouched = true;
    }
    const completedAt = now().toISOString();
    dependencies.repository.markAccount(
      job.id,
      child.workerOperationId,
      childStatus(outcomeCode),
      completedAt,
    );
    results.push({
      accountId: account.id,
      outcomeCode,
      transactionCounts: null,
    });
  }

  const summary = createSummary(job.id, startedAt, now, results);
  dependencies.repository.complete(summary);
  return summary;
}

export function bankSyncExitCode(summary: BankSyncJobSummary): number {
  if (summary.status === 'succeeded' || summary.status === 'skipped') return 0;
  if (summary.status === 'partial') return 1;
  if (summary.status === 'outcome_unknown') return 76;
  if (summary.status === 'canceled') return 130;
  return summary.retryable ? 75 : 70;
}

function validateRequest(
  request: BankSyncJobRequest,
): readonly string[] | null {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.idempotencyKey)) {
    throw new BankSyncJobError('invalid_request');
  }
  if (!/^[0-9a-f-]{36}$/.test(request.principalId)) {
    throw new BankSyncJobError('invalid_request');
  }
  if (request.accountIds === null) return null;
  if (
    request.accountIds.some(id => typeof id !== 'string' || id.length === 0) ||
    new Set(request.accountIds).size !== request.accountIds.length
  ) {
    throw new BankSyncJobError('invalid_request');
  }
  return [...request.accountIds].sort(byteOrder);
}

function selectAccounts(
  accounts: readonly ActualAccountV1[],
  requestedAccountIds: readonly string[] | null,
): readonly ActualAccountV1[] {
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) {
    throw new BankSyncJobError('configuration_error');
  }
  if (requestedAccountIds === null) {
    return accounts
      .filter(account => account.syncSource !== null)
      .sort((left, right) => byteOrder(left.id, right.id));
  }
  const byId = new Map(accounts.map(account => [account.id, account]));
  const selected: ActualAccountV1[] = [];
  for (const accountId of requestedAccountIds) {
    const account = byId.get(accountId);
    if (account === undefined || account.syncSource === null) {
      throw new BankSyncJobError('invalid_request');
    }
    selected.push(account);
  }
  return selected.sort((left, right) => byteOrder(left.id, right.id));
}

async function runAccount(
  jobId: string,
  child: BankSyncChild,
  dependencies: BankSyncJobDependencies,
  signal: AbortSignal,
  now: () => Date,
  persistSafetyOutcome: (
    outcome: 'canceled' | 'outcome-unknown',
  ) => BankSyncJobSummary,
): Promise<
  Readonly<{
    outcomeCode: BankSyncAccountOutcome;
    quarantineBundleHash?: string;
    persistedSummary?: BankSyncJobSummary;
  }>
> {
  if (signal.aborted) return { outcomeCode: 'canceled' };
  const jitter = dependencies.jitterMilliseconds;
  let persistedSummary: BankSyncJobSummary | undefined;
  try {
    let quarantineBundleHash: string | undefined;
    const response = await dependencies.adapter.execute(
      { kind: 'run-account-bank-sync', accountId: child.accountId },
      {
        jobRunId: jobId,
        workerOperationId: child.workerOperationId,
        cancellationSignal: signal,
        onQuarantine: hash => {
          quarantineBundleHash = hash;
        },
        onSafetyOutcome: outcome => {
          persistedSummary ??= persistSafetyOutcome(outcome);
        },
        bankSyncRetryJitterMilliseconds:
          jitter === undefined
            ? undefined
            : [validateJitter(jitter()), validateJitter(jitter())],
      },
    );
    if (response.kind !== 'run-account-bank-sync') {
      return { outcomeCode: 'outcome-unknown' };
    }
    const outcome =
      response.result.finalSyncCode === 'succeeded'
        ? response.result.outcomeCode
        : response.result.finalSyncCode === 'outcome-unknown'
          ? 'outcome-unknown'
          : 'final-sync-failed';
    log(dependencies, now, jobId, child, outcome);
    return { outcomeCode: outcome, quarantineBundleHash, persistedSummary };
  } catch (error) {
    const outcome = 'outcome-unknown';
    log(dependencies, now, jobId, child, outcome);
    return {
      outcomeCode: outcome,
      quarantineBundleHash:
        error instanceof ActualAdapterError
          ? error.quarantineBundleHash
          : undefined,
      persistedSummary,
    };
  }
}

function parentStatus(
  results: BankSyncJobSummary['accountResults'],
): BankSyncJobStatus {
  const outcomes = results.map(result => result.outcomeCode);
  if (outcomes.includes('outcome-unknown')) return 'outcome_unknown';
  const hasSuccess = outcomes.includes('succeeded');
  const hasFailure = outcomes.some(
    outcome => !['succeeded', 'skipped', 'canceled'].includes(outcome),
  );
  const hasCanceled = outcomes.includes('canceled');
  if (hasSuccess && (hasFailure || hasCanceled)) return 'partial';
  if (hasSuccess) return 'succeeded';
  if (hasFailure) return 'failed';
  if (hasCanceled) return 'canceled';
  return 'skipped';
}

function createSummary(
  jobId: string,
  startedAt: string,
  now: () => Date,
  accountResults: BankSyncJobSummary['accountResults'],
): BankSyncJobSummary {
  return {
    accountResults,
    completedAt: now().toISOString(),
    id: jobId,
    kind: 'bank-sync',
    retryable: isRetryable(accountResults),
    startedAt,
    status: parentStatus(accountResults),
  };
}

function isRetryable(results: BankSyncJobSummary['accountResults']): boolean {
  const outcomes = results.map(result => result.outcomeCode);
  if (outcomes.includes('outcome-unknown')) {
    return false;
  }
  if (
    outcomes.some(outcome =>
      [
        'authentication-required',
        'configuration-error',
        'final-sync-failed',
      ].includes(outcome),
    )
  ) {
    return false;
  }
  return outcomes.some(
    outcome => isRetryableOutcome(outcome) || outcome === 'canceled',
  );
}

function isRetryableOutcome(outcome: BankSyncAccountOutcome): boolean {
  return (
    outcome === 'rate-limited' ||
    outcome === 'timed-out' ||
    outcome === 'provider-error'
  );
}

function childStatus(
  outcome: BankSyncAccountOutcome,
): 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'outcome_unknown' {
  if (outcome === 'succeeded') return 'succeeded';
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'canceled') return 'canceled';
  if (outcome === 'outcome-unknown') return 'outcome_unknown';
  return 'failed';
}

function validateJitter(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 250) {
    throw new BankSyncJobError('configuration_error');
  }
  return value;
}

function log(
  dependencies: BankSyncJobDependencies,
  now: () => Date,
  jobId: string,
  child: BankSyncChild,
  outcome: BankSyncAccountOutcome,
): void {
  dependencies.log?.({
    accountId: child.accountId,
    budgetKeyHash: dependencies.budgetKeyHash,
    eventCode: `bank_sync_${outcome.replaceAll('-', '_')}`,
    jobId,
    severity: outcome === 'succeeded' ? 'info' : 'warn',
    timestamp: now().toISOString(),
    workerOperationId: child.workerOperationId,
  });
}

function createJob(
  database: ReturnType<typeof openCompanionDatabase>,
  scope: BankSyncJobScope,
  accountIds: readonly string[],
): ReturnType<BankSyncJobRepository['create']> {
  const existing = findJob(database, scope);
  if (existing.kind !== 'missing') return existing;
  const id = randomUUID();
  const children = accountIds.map((accountId, ordinal) => ({
    accountId,
    ordinal,
    workerOperationId: randomUUID(),
  }));
  const summary: BankSyncJobSummary = {
    accountResults: [],
    completedAt: null,
    id,
    kind: 'bank-sync',
    retryable: false,
    startedAt: null,
    status: 'skipped',
  };
  database
    .prepare(
      'INSERT INTO job_runs (id, job_kind, budget_key_hash, invocation_kind, operation_id, principal_id, idempotency_key, request_hash, account_scope_hash, status, attempt, started_at, completed_at, error_code, summary_json, resolution_code, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      'bank_sync',
      scope.budgetKeyHash,
      scope.invocationKind,
      bankSyncOperationId(scope.invocationKind),
      scope.principalId,
      scope.idempotencyKey,
      scope.requestHash,
      scopeHash(accountIds),
      'queued',
      1,
      null,
      null,
      null,
      JSON.stringify(summary),
      null,
      null,
    );
  const insertChild = database.prepare(
    'INSERT INTO job_run_account_operations (worker_operation_id, job_run_id, account_id, ordinal, expected_quarantine_root, status, quarantine_bundle_hash, started_at, completed_at, resolution_code, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const child of children) {
    insertChild.run(
      child.workerOperationId,
      id,
      child.accountId,
      child.ordinal,
      `bank-sync-${id}-${child.workerOperationId}`,
      'queued',
      null,
      null,
      null,
      null,
      null,
    );
  }
  return { kind: 'created', job: { children, id, summary } };
}

function findJob(
  database: ReturnType<typeof openCompanionDatabase>,
  scope: BankSyncJobScope,
): ReturnType<BankSyncJobRepository['find']> {
  const row = database
    .prepare(
      'SELECT request_hash, status, summary_json FROM job_runs WHERE budget_key_hash = ? AND principal_id = ? AND invocation_kind = ? AND operation_id = ? AND idempotency_key = ?',
    )
    .get(
      scope.budgetKeyHash,
      scope.principalId,
      scope.invocationKind,
      bankSyncOperationId(scope.invocationKind),
      scope.idempotencyKey,
    ) as
    | Readonly<{ request_hash: string; status: string; summary_json: string }>
    | undefined;
  if (row !== undefined) {
    if (row.request_hash !== scope.requestHash) {
      return { kind: 'conflict' };
    }
    if (row.status === 'queued' || row.status === 'running') {
      return { kind: 'in-progress' };
    }
    return { kind: 'replay', summary: parseSummary(row.summary_json) };
  }
  const unresolvedUnknown = database
    .prepare(
      "SELECT 1 FROM job_runs WHERE status IN ('queued', 'running', 'outcome_unknown') LIMIT 1",
    )
    .get();
  if (unresolvedUnknown !== undefined) {
    return { kind: 'blocked' };
  }
  const keyWasBound = database
    .prepare('SELECT 1 FROM job_runs WHERE idempotency_key = ? LIMIT 1')
    .get(scope.idempotencyKey);
  return keyWasBound === undefined ? { kind: 'missing' } : { kind: 'conflict' };
}

function parseSummary(value: string): BankSyncJobSummary {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.kind !== 'bank-sync' ||
    !Array.isArray(parsed.accountResults)
  ) {
    throw new Error('Stored bank-sync summary is invalid.');
  }
  if (
    typeof parsed.id !== 'string' ||
    !isJobStatus(parsed.status) ||
    (parsed.startedAt !== null && typeof parsed.startedAt !== 'string') ||
    (parsed.completedAt !== null && typeof parsed.completedAt !== 'string') ||
    typeof parsed.retryable !== 'boolean'
  ) {
    throw new Error('Stored bank-sync summary is invalid.');
  }
  const accountResults = parsed.accountResults.map(result => {
    if (
      !isRecord(result) ||
      typeof result.accountId !== 'string' ||
      !isAccountOutcome(result.outcomeCode) ||
      result.transactionCounts !== null
    ) {
      throw new Error('Stored bank-sync summary is invalid.');
    }
    return {
      accountId: result.accountId,
      outcomeCode: result.outcomeCode,
      transactionCounts: null,
    };
  });
  return {
    accountResults,
    completedAt: parsed.completedAt,
    id: parsed.id,
    kind: 'bank-sync',
    retryable: parsed.retryable,
    startedAt: parsed.startedAt,
    status: parsed.status,
  };
}

type BankSyncJobRunRow = Readonly<{
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  summary_json: string;
}>;

function parseJobRunRow(row: BankSyncJobRunRow): BankSyncJobSummary {
  if (
    !CANONICAL_UUID_PATTERN.test(row.id) ||
    !isJobStatus(row.status) ||
    (row.started_at !== null && typeof row.started_at !== 'string') ||
    (row.completed_at !== null && typeof row.completed_at !== 'string')
  ) {
    throw new Error('Stored bank-sync job is invalid.');
  }
  const summary = parseSummary(row.summary_json);
  if (summary.id !== row.id) {
    throw new Error('Stored bank-sync job is invalid.');
  }
  return {
    ...summary,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccountOutcome(value: unknown): value is BankSyncAccountOutcome {
  return (
    typeof value === 'string' &&
    [
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
    ].includes(value)
  );
}

function bankSyncOperationId(invocationKind: BankSyncInvocationKind): string {
  return invocationKind === 'local_http'
    ? BANK_SYNC_HTTP_OPERATION_ID
    : BANK_SYNC_CLI_OPERATION_ID;
}

function isJobStatus(value: unknown): value is BankSyncJobStatus {
  return (
    typeof value === 'string' &&
    [
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
      'skipped',
      'canceled',
      'outcome_unknown',
    ].includes(value)
  );
}

function scopeHash(accountIds: readonly string[]): string {
  return createHash('sha256')
    .update('finance-companion/bank-sync-account-scope/v1\0')
    .update(canonicalJson(accountIds))
    .digest('hex');
}

function byteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function withDatabase<Result>(
  databasePath: string,
  operation: (database: ReturnType<typeof openCompanionDatabase>) => Result,
): Result {
  const database = openCompanionDatabase(databasePath, true);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
