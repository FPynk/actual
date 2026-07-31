import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteRequestReplayRepository } from '#service/request-replay-repository';
import type {
  RequestReplayResponse,
  RequestReplayScope,
} from '#service/request-replay-repository';

describe('FIN-13 request replay repository', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let scope: RequestReplayScope;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-replay-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    await initializeCompanionDatabaseAndAnchor({
      databasePath,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        '../../migrations',
      ),
      anchorPath: path.join(temporaryDirectory, 'anchor.json'),
      anchorMacKey: randomBytes(32),
      budgetKeyHash: 'a'.repeat(64),
      budgetCurrencyCode: 'USD',
      createOwnerCredentialHash: async () => 'test-owner-hash',
    });
    const database = openCompanionDatabase(databasePath, true);
    try {
      const principal = database
        .prepare('SELECT id FROM local_principals')
        .get() as Readonly<{ id: string }>;
      scope = {
        budgetKeyHash: 'a'.repeat(64),
        principalId: principal.id,
        invocationKind: 'local_http',
        operationId: 'amazon-import/v1',
        idempotencyKey: 'a-valid-idempotency-key',
        requestHash: 'b'.repeat(64),
      };
    } finally {
      database.close();
    }
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates once, replays only its allowlisted terminal result, and rejects a changed scope', () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    expect(started.kind).toBe('execute');
    if (started.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }

    const response = createFeatureNotImplementedResponse();
    repository.complete(started.replayId, response);

    expect(repository.begin(scope)).toEqual({
      kind: 'replay',
      response,
    });
    expect(repository.begin({ ...scope, requestHash: 'c'.repeat(64) })).toEqual(
      { kind: 'conflict' },
    );
    expect(
      repository.begin({ ...scope, operationId: 'amazon-import/v2' }),
    ).toEqual({ kind: 'conflict' });
    expect(repository.begin({ ...scope, principalId: randomUUID() })).toEqual({
      kind: 'conflict',
    });
    expect(repository.begin({ ...scope, invocationKind: 'scheduler' })).toEqual(
      { kind: 'conflict' },
    );
    expect(
      repository.begin({ ...scope, budgetKeyHash: 'd'.repeat(64) }),
    ).toEqual({ kind: 'conflict' });
  });

  it('serializes concurrent duplicates and leaves active work blocked before startup recovery', async () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const decisions = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve(repository.begin(scope))),
    );
    expect(
      decisions.filter(decision => decision.kind === 'execute'),
    ).toHaveLength(1);
    expect(
      decisions.filter(decision => decision.kind === 'in_progress'),
    ).toHaveLength(7);

    const restartedRepository =
      createSqliteRequestReplayRepository(databasePath);
    expect(restartedRepository.begin(scope)).toEqual({ kind: 'in_progress' });
  });

  it('recovers a companion-only interruption once and allows exactly one retry', () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    expect(started.kind).toBe('execute');

    const restartedRepository =
      createSqliteRequestReplayRepository(databasePath);
    expect(
      restartedRepository.recoverCompanionOnlyInterruptedRequests(),
    ).toEqual({ recoveredCompanionOnlyCount: 1 });
    const recoveredDatabase = openCompanionDatabase(databasePath, true);
    try {
      expect(
        recoveredDatabase
          .prepare(
            'SELECT status, error_code, completed_at FROM request_replays WHERE id = ?',
          )
          .get(started.kind === 'execute' ? started.replayId : ''),
      ).toEqual({
        status: 'failed_retryable',
        error_code: 'companion_interrupted_before_domain_commit',
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    } finally {
      recoveredDatabase.close();
    }
    expect(
      restartedRepository.recoverCompanionOnlyInterruptedRequests(),
    ).toEqual({ recoveredCompanionOnlyCount: 0 });
    const retry = restartedRepository.begin(scope);
    expect(retry).toMatchObject({ kind: 'execute', attempt: 2 });
    expect(restartedRepository.begin(scope)).toEqual({ kind: 'in_progress' });

    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare(
            'SELECT error_code, completed_at FROM request_replays WHERE id = ?',
          )
          .get(started.kind === 'execute' ? started.replayId : ''),
      ).toEqual({ error_code: null, completed_at: null });
    } finally {
      database.close();
    }
  });

  it('leaves an in-progress replay with an atomic domain owner blocked', () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    if (started.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }
    const database = openCompanionDatabase(databasePath, true);
    try {
      database
        .prepare(
          "UPDATE request_replays SET domain_record_kind = 'import_batch', domain_record_id = ? WHERE id = ?",
        )
        .run(randomUUID(), started.replayId);
    } finally {
      database.close();
    }

    expect(repository.recoverCompanionOnlyInterruptedRequests()).toEqual({
      recoveredCompanionOnlyCount: 0,
    });
    expect(repository.begin(scope)).toEqual({ kind: 'in_progress' });
  });

  it('only takes over an explicitly retryable companion-only failure and reuses its row', () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    if (started.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }
    repository.fail(started.replayId, 'temporary_failure');

    expect(repository.begin(scope)).toEqual({
      kind: 'execute',
      replayId: started.replayId,
      attempt: 2,
    });
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM request_replays').get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('retains unresolved work while purging only expired terminal records', () => {
    let currentTime = new Date('2026-01-01T00:00:00.000Z');
    const repository = createSqliteRequestReplayRepository(
      databasePath,
      () => currentTime,
    );
    const completed = repository.begin(scope);
    if (completed.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }
    repository.complete(
      completed.replayId,
      createFeatureNotImplementedResponse(),
    );
    const unresolved = repository.begin({
      ...scope,
      idempotencyKey: 'another-valid-idempotency-key',
      requestHash: 'c'.repeat(64),
    });
    expect(unresolved.kind).toBe('execute');

    currentTime = new Date('2026-02-01T00:00:00.000Z');
    expect(repository.purgeExpiredTerminalRows()).toBe(1);
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database.prepare('SELECT status FROM request_replays').all(),
      ).toEqual([{ status: 'in_progress' }]);
    } finally {
      database.close();
    }
  });

  it('enforces the frozen request_replays and job_runs table constraints', () => {
    const database = openCompanionDatabase(databasePath, true);
    try {
      const principal = scope.principalId;
      expect(() =>
        database
          .prepare(
            'INSERT INTO request_replays (id, budget_key_hash, principal_id, invocation_kind, operation_id, idempotency_key, request_hash, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            scope.budgetKeyHash,
            principal,
            scope.invocationKind,
            scope.operationId,
            'short',
            scope.requestHash,
            'in_progress',
            1,
            new Date().toISOString(),
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO request_replays (id, budget_key_hash, principal_id, invocation_kind, operation_id, idempotency_key, request_hash, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            scope.budgetKeyHash,
            principal,
            scope.invocationKind,
            scope.operationId,
            'valid-timestamp-test-key',
            scope.requestHash,
            'in_progress',
            1,
            'not-a-timestamp',
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO job_runs (id, job_kind, budget_key_hash, invocation_kind, operation_id, principal_id, idempotency_key, request_hash, status, attempt, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            'bank_sync',
            scope.budgetKeyHash,
            'scheduler',
            'bank-sync/v1',
            principal,
            'a-valid-job-idempotency-key',
            scope.requestHash,
            'queued',
            1,
            '{}',
          ),
      ).not.toThrow();
      const jobRun = database
        .prepare('SELECT id FROM job_runs')
        .get() as Readonly<{ id: string }>;
      const workerOperationId = randomUUID();
      expect(() =>
        database
          .prepare(
            'INSERT INTO job_run_account_operations (worker_operation_id, job_run_id, account_id, ordinal, expected_quarantine_root, status) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            workerOperationId,
            jobRun.id,
            'account-1',
            0,
            `bank-sync-${jobRun.id}-${workerOperationId}`,
            'queued',
          ),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            'INSERT INTO job_run_account_operations (worker_operation_id, job_run_id, account_id, ordinal, expected_quarantine_root, status) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            randomUUID(),
            jobRun.id,
            'account-2',
            1,
            'wrong-quarantine-root',
            'queued',
          ),
      ).toThrow();
      expect(() =>
        database
          .prepare('UPDATE job_runs SET started_at = ? WHERE id = ?')
          .run('2026-01-01 00:00:00', jobRun.id),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            'UPDATE job_run_account_operations SET completed_at = ? WHERE worker_operation_id = ?',
          )
          .run('tomorrow', workerOperationId),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it.each([
    [
      'an extra field',
      {
        ...createFeatureNotImplementedResponse(),
        body: {
          ...createFeatureNotImplementedResponse().body,
          detail: 'benign',
        },
      },
    ],
    [
      'a missing field',
      {
        ...createFeatureNotImplementedResponse(),
        body: {
          code: 'feature_not_implemented',
          retryable: false,
          requestId: randomUUID(),
        },
      },
    ],
    [
      'arbitrary or sensitive text',
      {
        ...createFeatureNotImplementedResponse(),
        body: {
          ...createFeatureNotImplementedResponse().body,
          message: 'C:\\private\\source.csv exception detail',
        },
      },
    ],
    [
      'the wrong status',
      { ...createFeatureNotImplementedResponse(), status: 500 },
    ],
    [
      'the wrong content type',
      {
        ...createFeatureNotImplementedResponse(),
        contentType: 'application/json',
      },
    ],
  ])('rejects %s outside the operation response policy', (_name, response) => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    if (started.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }
    expect(() =>
      Reflect.apply(repository.complete, undefined, [
        started.replayId,
        response,
      ]),
    ).toThrow('not allowlisted');
  });

  it('validates the operation response policy again when reading a replay', () => {
    const repository = createSqliteRequestReplayRepository(databasePath);
    const started = repository.begin(scope);
    if (started.kind !== 'execute') {
      throw new Error('The replay did not start.');
    }
    repository.complete(
      started.replayId,
      createFeatureNotImplementedResponse(),
    );
    const database = openCompanionDatabase(databasePath, true);
    try {
      database
        .prepare('UPDATE request_replays SET response_json = ? WHERE id = ?')
        .run(
          JSON.stringify({
            ...createFeatureNotImplementedResponse().body,
            detail: 'unexpected',
          }),
          started.replayId,
        );
    } finally {
      database.close();
    }
    expect(() => repository.begin(scope)).toThrow('not allowlisted');
  });
});

function createFeatureNotImplementedResponse(): RequestReplayResponse {
  return {
    contentType: 'application/problem+json',
    status: 501,
    body: {
      code: 'feature_not_implemented',
      message: 'This feature is not implemented yet.',
      retryable: false,
      requestId: randomUUID(),
    },
  };
}
