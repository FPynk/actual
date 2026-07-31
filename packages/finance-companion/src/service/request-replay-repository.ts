import { randomUUID } from 'node:crypto';

import { openCompanionDatabase } from '#database/connection';

const REQUEST_REPLAY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const INTERRUPTED_BEFORE_DOMAIN_COMMIT_ERROR =
  'companion_interrupted_before_domain_commit';
const AMAZON_IMPORT_OPERATION_ID = 'amazon-import/v1';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const FEATURE_NOT_IMPLEMENTED_MESSAGE = 'This feature is not implemented yet.';
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RequestReplayScope = Readonly<{
  budgetKeyHash: string;
  principalId: string;
  invocationKind: 'local_http' | 'local_cli' | 'scheduler';
  operationId: string;
  idempotencyKey: string;
  requestHash: string;
}>;

type AmazonImportProblemDetails = Readonly<{
  code: 'feature_not_implemented';
  message: typeof FEATURE_NOT_IMPLEMENTED_MESSAGE;
  retryable: false;
  requestId: string;
}>;

export type RequestReplayResponse = Readonly<{
  contentType: typeof PROBLEM_CONTENT_TYPE;
  status: 501;
  body: AmazonImportProblemDetails;
}>;

export type RequestReplayDecision =
  | Readonly<{ kind: 'execute'; replayId: string; attempt: number }>
  | Readonly<{ kind: 'replay'; response: RequestReplayResponse }>
  | Readonly<{ kind: 'in_progress' }>
  | Readonly<{ kind: 'conflict' }>;

export type RequestReplayRecoveryResult = Readonly<{
  recoveredCompanionOnlyCount: number;
}>;

export type RequestReplayRepository = Readonly<{
  begin: (scope: RequestReplayScope) => RequestReplayDecision;
  complete: (replayId: string, response: RequestReplayResponse) => void;
  fail: (
    replayId: string,
    errorCode: string,
    finalResponse?: RequestReplayResponse,
  ) => void;
  recoverCompanionOnlyInterruptedRequests: () => RequestReplayRecoveryResult;
  purgeExpiredTerminalRows: (now?: Date) => number;
}>;

type RequestReplayRow = Readonly<{
  id: string;
  operation_id: string;
  request_hash: string;
  status: 'in_progress' | 'completed' | 'failed_retryable' | 'failed_final';
  attempt: number;
  response_status: number | null;
  response_json: string | null;
}>;

export function validateIdempotencyKey(
  value: string | undefined,
): string | null {
  return value !== undefined && /^[A-Za-z0-9_-]{16,128}$/.test(value)
    ? value
    : null;
}

export function createSqliteRequestReplayRepository(
  databasePath: string,
  now = () => new Date(),
): RequestReplayRepository {
  return {
    begin: scope =>
      withDatabase(databasePath, database =>
        database
          .transaction(() => beginRequestReplay(database, scope, now))
          .immediate(),
      ),
    complete: (replayId, response) =>
      withDatabase(databasePath, database =>
        database
          .transaction(() =>
            completeRequestReplay(database, replayId, response, now),
          )
          .immediate(),
      ),
    fail: (replayId, errorCode, finalResponse) =>
      withDatabase(databasePath, database =>
        database
          .transaction(() =>
            failRequestReplay(
              database,
              replayId,
              errorCode,
              finalResponse,
              now,
            ),
          )
          .immediate(),
      ),
    recoverCompanionOnlyInterruptedRequests: () =>
      withDatabase(databasePath, database =>
        database
          .transaction(() =>
            recoverCompanionOnlyInterruptedRequests(database, now),
          )
          .immediate(),
      ),
    purgeExpiredTerminalRows: (currentTime = now()) =>
      withDatabase(
        databasePath,
        database =>
          database
            .prepare(
              "DELETE FROM request_replays WHERE expires_at IS NOT NULL AND expires_at <= ? AND status IN ('completed', 'failed_final')",
            )
            .run(currentTime.toISOString()).changes,
      ),
  };
}

function beginRequestReplay(
  database: ReturnType<typeof openCompanionDatabase>,
  scope: RequestReplayScope,
  now: () => Date,
): RequestReplayDecision {
  const exact = database
    .prepare(
      'SELECT id, operation_id, request_hash, status, attempt, response_status, response_json FROM request_replays WHERE budget_key_hash = ? AND principal_id = ? AND invocation_kind = ? AND operation_id = ? AND idempotency_key = ?',
    )
    .get(
      scope.budgetKeyHash,
      scope.principalId,
      scope.invocationKind,
      scope.operationId,
      scope.idempotencyKey,
    ) as RequestReplayRow | undefined;
  if (exact !== undefined) {
    return decideExistingReplay(database, exact, scope);
  }

  const keyWasBoundToAnotherScope = database
    .prepare('SELECT 1 FROM request_replays WHERE idempotency_key = ? LIMIT 1')
    .get(scope.idempotencyKey);
  if (keyWasBoundToAnotherScope !== undefined) return { kind: 'conflict' };

  const replayId = randomUUID();
  database
    .prepare(
      'INSERT INTO request_replays (id, budget_key_hash, principal_id, invocation_kind, operation_id, idempotency_key, request_hash, status, attempt, response_status, response_json, domain_record_kind, domain_record_id, error_code, created_at, completed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      replayId,
      scope.budgetKeyHash,
      scope.principalId,
      scope.invocationKind,
      scope.operationId,
      scope.idempotencyKey,
      scope.requestHash,
      'in_progress',
      1,
      null,
      null,
      null,
      null,
      null,
      now().toISOString(),
      null,
      null,
    );
  return { kind: 'execute', replayId, attempt: 1 };
}

function decideExistingReplay(
  database: ReturnType<typeof openCompanionDatabase>,
  row: RequestReplayRow,
  scope: RequestReplayScope,
): RequestReplayDecision {
  if (row.request_hash !== scope.requestHash) return { kind: 'conflict' };
  if (row.status === 'in_progress') return { kind: 'in_progress' };
  if (row.status === 'completed') {
    return {
      kind: 'replay',
      response: readStoredResponse(row.operation_id, row),
    };
  }
  if (row.status === 'failed_final') {
    return {
      kind: 'replay',
      response: readStoredFinalResponse(row.operation_id, row),
    };
  }
  const transition = database
    .prepare(
      "UPDATE request_replays SET status = 'in_progress', attempt = attempt + 1, error_code = NULL, completed_at = NULL, expires_at = NULL WHERE id = ? AND request_hash = ? AND status = 'failed_retryable'",
    )
    .run(row.id, scope.requestHash);
  if (transition.changes !== 1) return { kind: 'in_progress' };
  return { kind: 'execute', replayId: row.id, attempt: row.attempt + 1 };
}

function completeRequestReplay(
  database: ReturnType<typeof openCompanionDatabase>,
  replayId: string,
  response: RequestReplayResponse,
  now: () => Date,
): void {
  const operationId = readReplayOperationId(database, replayId);
  assertAllowlistedResponse(operationId, response);
  const completedAt = now();
  const result = database
    .prepare(
      "UPDATE request_replays SET status = 'completed', response_status = ?, response_json = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status = 'in_progress'",
    )
    .run(
      response.status,
      JSON.stringify(response.body),
      completedAt.toISOString(),
      new Date(
        completedAt.getTime() + REQUEST_REPLAY_RETENTION_MILLISECONDS,
      ).toISOString(),
      replayId,
    );
  if (result.changes !== 1) throw new Error('The replay is not active.');
}

function failRequestReplay(
  database: ReturnType<typeof openCompanionDatabase>,
  replayId: string,
  errorCode: string,
  finalResponse: RequestReplayResponse | undefined,
  now: () => Date,
): void {
  if (!/^[a-z0-9_]+$/.test(errorCode)) {
    throw new Error('The replay error code is invalid.');
  }
  if (finalResponse === undefined) {
    const result = database
      .prepare(
        "UPDATE request_replays SET status = 'failed_retryable', error_code = ?, completed_at = ? WHERE id = ? AND status = 'in_progress'",
      )
      .run(errorCode, now().toISOString(), replayId);
    if (result.changes !== 1) throw new Error('The replay is not active.');
    return;
  }
  const operationId = readReplayOperationId(database, replayId);
  assertAllowlistedResponse(operationId, finalResponse);
  const completedAt = now();
  const result = database
    .prepare(
      "UPDATE request_replays SET status = 'failed_final', response_json = ?, error_code = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status = 'in_progress'",
    )
    .run(
      JSON.stringify(finalResponse.body),
      errorCode,
      completedAt.toISOString(),
      new Date(
        completedAt.getTime() + REQUEST_REPLAY_RETENTION_MILLISECONDS,
      ).toISOString(),
      replayId,
    );
  if (result.changes !== 1) throw new Error('The replay is not active.');
}

function recoverCompanionOnlyInterruptedRequests(
  database: ReturnType<typeof openCompanionDatabase>,
  now: () => Date,
): RequestReplayRecoveryResult {
  const invalidDomainPair = database
    .prepare(
      "SELECT 1 FROM request_replays WHERE status = 'in_progress' AND ((domain_record_kind IS NULL) <> (domain_record_id IS NULL)) LIMIT 1",
    )
    .get();
  if (invalidDomainPair !== undefined) {
    throw new Error('The replay domain binding is invalid.');
  }
  const result = database
    .prepare(
      "UPDATE request_replays SET status = 'failed_retryable', error_code = ?, completed_at = ? WHERE status = 'in_progress' AND domain_record_kind IS NULL AND domain_record_id IS NULL",
    )
    .run(INTERRUPTED_BEFORE_DOMAIN_COMMIT_ERROR, now().toISOString());
  return { recoveredCompanionOnlyCount: result.changes };
}

function readReplayOperationId(
  database: ReturnType<typeof openCompanionDatabase>,
  replayId: string,
): string {
  const row = database
    .prepare('SELECT operation_id FROM request_replays WHERE id = ?')
    .get(replayId) as Readonly<{ operation_id: string }> | undefined;
  if (row === undefined) throw new Error('The replay does not exist.');
  return row.operation_id;
}

function readStoredResponse(
  operationId: string,
  row: RequestReplayRow,
): RequestReplayResponse {
  if (row.response_status === null || row.response_json === null) {
    throw new Error('The completed replay is invalid.');
  }
  return parseStoredResponse(
    operationId,
    row.response_status,
    row.response_json,
  );
}

function readStoredFinalResponse(
  operationId: string,
  row: RequestReplayRow,
): RequestReplayResponse {
  if (row.response_json === null) {
    throw new Error('The final replay is invalid.');
  }
  return parseStoredResponse(operationId, 501, row.response_json);
}

function parseStoredResponse(
  operationId: string,
  status: number,
  value: string,
): RequestReplayResponse {
  const body: unknown = JSON.parse(value);
  const response = {
    contentType: PROBLEM_CONTENT_TYPE,
    status,
    body,
  };
  assertAllowlistedResponse(operationId, response);
  return response;
}

function assertAllowlistedResponse(
  operationId: string,
  response: unknown,
): asserts response is RequestReplayResponse {
  if (operationId !== AMAZON_IMPORT_OPERATION_ID) {
    throw new Error('The replay operation has no response policy.');
  }
  if (typeof response !== 'object' || response === null) {
    throw new Error('The replay response is not allowlisted.');
  }
  if (
    !('contentType' in response) ||
    response.contentType !== PROBLEM_CONTENT_TYPE ||
    !('status' in response) ||
    response.status !== 501 ||
    !('body' in response) ||
    typeof response.body !== 'object' ||
    response.body === null ||
    Array.isArray(response.body)
  ) {
    throw new Error('The replay response is not allowlisted.');
  }
  const body = response.body;
  if (
    Object.keys(body).sort().join(',') !== 'code,message,requestId,retryable' ||
    !('code' in body) ||
    body.code !== 'feature_not_implemented' ||
    !('message' in body) ||
    body.message !== FEATURE_NOT_IMPLEMENTED_MESSAGE ||
    !('retryable' in body) ||
    body.retryable !== false ||
    !('requestId' in body) ||
    typeof body.requestId !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(body.requestId)
  ) {
    throw new Error('The replay response is not allowlisted.');
  }
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
