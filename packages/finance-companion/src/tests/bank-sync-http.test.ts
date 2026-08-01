import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as createRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import { openCompanionDatabase } from '#database/connection';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import { createSqliteLocalPrincipalRepository } from '#database/sqlite-local-principal-repository';
import { createFinanceCompanionHttpApplication } from '#http/server';
import { SqliteReconciliationCandidateRepository } from '#reconciliation/sqlite-reconciliation-candidate-repository';
import {
  createFinanceCompanionSecurity,
  hashOwnerBootstrapCredential,
} from '#security/local-security';
import { createSqliteRequestReplayRepository } from '#service/request-replay-repository';

const credential = Buffer.alloc(32, 31).toString('base64url');

describe('FIN-61 bank-sync HTTP API and maintenance admission', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let configuration: FinanceCompanionConfiguration;
  let server: Server;
  let reviewDatabase: ReturnType<typeof openCompanionDatabase>;
  let adapterRequests: string[];
  let holdBankSync: Promise<void> | undefined;
  let reportHeldBankSyncStarted: (() => void) | undefined;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-bank-sync-http-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    configuration = {
      bindAddress: '127.0.0.1',
      port: 4100,
      origin: 'http://127.0.0.1:4100',
      dataDirectory: temporaryDirectory,
      databasePath,
      integrityAnchorPath: path.join(temporaryDirectory, 'anchor.json'),
      integrityMacKeyFile: undefined,
      integrityMacKey: randomBytes(32).toString('base64url'),
      budgetKeyHash: 'a'.repeat(64),
      budgetCurrencyCode: 'USD',
      ownerBootstrapCredential: undefined,
      ownerBootstrapCredentialFile: undefined,
    };
    await initializeCompanionDatabaseAndAnchor({
      databasePath,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        '../../migrations',
      ),
      anchorPath: configuration.integrityAnchorPath,
      anchorMacKey: randomBytes(32),
      budgetKeyHash: configuration.budgetKeyHash,
      budgetCurrencyCode: configuration.budgetCurrencyCode,
      createOwnerCredentialHash: async () =>
        hashOwnerBootstrapCredential(credential, undefined),
    });
    const security = await createFinanceCompanionSecurity({
      localPrincipalRepository:
        createSqliteLocalPrincipalRepository(databasePath),
    });
    adapterRequests = [];
    const adapter = createSyntheticAdapter(() => {
      adapterRequests.push('run-account-bank-sync');
      reportHeldBankSyncStarted?.();
      return holdBankSync;
    });
    reviewDatabase = openCompanionDatabase(databasePath, true);
    server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createSqliteRequestReplayRepository(databasePath),
        temporaryDirectory,
        {
          adapter: {
            ...adapter,
            execute: async (request, context) => {
              adapterRequests.push(request.kind);
              return adapter.execute(request, context);
            },
          },
          candidateRepository: new SqliteReconciliationCandidateRepository(
            reviewDatabase,
          ),
          databasePath,
          sourceIdentityRepository:
            createSqliteSourceIdentityRepository(databasePath),
          now: createClock(),
        },
      ),
    );
    await listen(server);
  });

  afterEach(async () => {
    await close(server);
    reviewDatabase.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('enforces the route boundary, replays durably, and lists bounded pages without private text', async () => {
    expect((await send(server, 'GET', '/api/v1/runs')).statusCode).toBe(401);
    const session = await login(server);

    expect(
      (
        await submitBankSync(
          server,
          session,
          'missing-origin-key',
          ['success'],
          {
            Origin: undefined,
          },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await submitBankSync(
          server,
          session,
          'missing-csrf-key-',
          ['success'],
          {
            'X-Finance-CSRF': undefined,
          },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await submitBankSync(
          server,
          session,
          'rejected-host-key',
          ['success'],
          {
            Host: 'localhost:4100',
          },
        )
      ).statusCode,
    ).toBe(400);

    const first = await submitBankSync(server, session, 'successful-run-key', [
      'success',
    ]);
    expect(first.statusCode).toBe(202);
    expect(first.body).toMatchObject({
      kind: 'bank-sync',
      status: 'succeeded',
      retryable: false,
    });
    const callsAfterFirst = adapterRequests.length;
    const replay = await submitBankSync(server, session, 'successful-run-key', [
      'success',
    ]);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(adapterRequests).toHaveLength(callsAfterFirst);
    const conflict = await submitBankSync(
      server,
      session,
      'successful-run-key',
      ['timeout'],
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'idempotency_conflict' });

    const timedOut = await submitBankSync(
      server,
      session,
      'timed-out-run-key',
      ['timeout'],
    );
    expect(timedOut.body).toMatchObject({ status: 'failed', retryable: true });
    const unknown = await submitBankSync(server, session, 'unknown-run-key-', [
      'unknown',
    ]);
    expect(unknown.body).toMatchObject({
      status: 'outcome_unknown',
      retryable: false,
    });

    const firstPage = await send(server, 'GET', '/api/v1/runs?limit=2', {
      Cookie: session.cookie,
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(typeof firstPage.body.nextCursor).toBe('string');
    const secondPage = await send(
      server,
      'GET',
      `/api/v1/runs?limit=2&cursor=${String(firstPage.body.nextCursor)}`,
      { Cookie: session.cookie },
    );
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();
    expect(
      (
        await send(server, 'GET', '/api/v1/runs?limit=101', {
          Cookie: session.cookie,
        })
      ).body,
    ).toMatchObject({ code: 'invalid_request' });

    const publicJson = JSON.stringify([
      first.body,
      timedOut.body,
      unknown.body,
      firstPage.body,
      secondPage.body,
    ]);
    expect(publicJson).not.toContain('Private checking account');
    expect(publicJson).not.toContain(credential);
    const storedOperationIds = reviewDatabase
      .prepare(
        'SELECT DISTINCT operation_id AS operationId FROM job_runs ORDER BY operation_id',
      )
      .all();
    expect(storedOperationIds).toEqual([
      { operationId: 'finance-companion/http/bank-sync/v1' },
    ]);
  });

  it('fails maintenance-first and request-first races closed', async () => {
    const session = await login(server);
    await withExclusiveMaintenanceLock(databasePath, async () => {
      const refused = await send(server, 'GET', '/api/v1/runs', {
        Cookie: session.cookie,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.headers['retry-after']).toBe('1');
      expect(refused.body).toMatchObject({
        code: 'operation_in_progress',
        retryable: true,
      });
    });

    let releaseBankSync: () => void = () => undefined;
    holdBankSync = new Promise<void>(resolve => {
      releaseBankSync = resolve;
    });
    const bankSyncStarted = new Promise<void>(resolve => {
      reportHeldBankSyncStarted = resolve;
    });
    const pendingRequest = submitBankSync(
      server,
      session,
      'request-first-key',
      ['success'],
    );
    await bankSyncStarted;
    expect(existsSync(`${databasePath}.maintenance.lock`)).toBe(true);
    await expect(
      withExclusiveMaintenanceLock(databasePath, async () => undefined),
    ).rejects.toThrow('Exclusive maintenance is required');
    releaseBankSync();
    expect((await pendingRequest).statusCode).toBe(202);
    expect(existsSync(`${databasePath}.maintenance.lock`)).toBe(false);
  });
});

function createSyntheticAdapter(
  beforeBankSync: () => Promise<void> | undefined,
): ActualAdapter {
  return {
    execute: async request => {
      if (request.kind === 'read-budget-snapshot') {
        return {
          kind: 'read-budget-snapshot',
          snapshot: {
            contractVersion: 1,
            budget: {
              budgetKeyHash: 'a'.repeat(64),
              currencyCode: 'USD',
              capturedAt: '2026-08-01T12:00:00.000Z',
            },
            accounts: ['success', 'timeout', 'unknown'].map(id => ({
              id,
              name: 'Private checking account',
              offBudget: false,
              closed: false,
              syncSource: 'simpleFin' as const,
              lastSync: null,
              syncStatus: null,
            })),
          },
        };
      }
      if (request.kind === 'read-actual-target') {
        return { kind: 'read-actual-target', target: null };
      }
      await beforeBankSync();
      const outcomeCode =
        request.accountId === 'timeout'
          ? ('timed-out' as const)
          : request.accountId === 'unknown'
            ? ('outcome-unknown' as const)
            : ('succeeded' as const);
      return {
        kind: 'run-account-bank-sync',
        result: {
          contractVersion: 1,
          accountId: request.accountId,
          startedAt: '2026-08-01T12:00:00.000Z',
          completedAt: '2026-08-01T12:00:01.000Z',
          outcomeCode,
          transactionCounts: null,
          finalSyncCode:
            outcomeCode === 'outcome-unknown'
              ? ('outcome-unknown' as const)
              : ('succeeded' as const),
        },
      };
    },
    getHealth: () => 'healthy',
    getActiveOperationStatus: () => null,
  };
}

function createClock() {
  let milliseconds = 0;
  return () => new Date(Date.UTC(2026, 7, 1, 12, 0, 0, milliseconds++));
}

async function login(
  server: Server,
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await send(
    server,
    'POST',
    '/api/v1/session',
    {
      Origin: 'http://127.0.0.1:4100',
      'Content-Type': 'application/json; charset=utf-8',
    },
    JSON.stringify({ credential }),
  );
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
  const csrfToken = response.body.csrfToken;
  if (
    response.statusCode !== 201 ||
    cookie === undefined ||
    typeof csrfToken !== 'string'
  ) {
    throw new Error('Synthetic login did not return a session.');
  }
  return { cookie, csrfToken };
}

function submitBankSync(
  server: Server,
  session: { cookie: string; csrfToken: string },
  idempotencyKey: string,
  accountIds: readonly string[],
  overrides: Readonly<Record<string, string | undefined>> = {},
) {
  return send(
    server,
    'POST',
    '/api/v1/jobs/bank-sync',
    {
      Host: '127.0.0.1:4100',
      Origin: 'http://127.0.0.1:4100',
      Cookie: session.cookie,
      'X-Finance-CSRF': session.csrfToken,
      'Content-Type': 'application/json; charset=utf-8',
      'Idempotency-Key': idempotencyKey,
      ...overrides,
    },
    JSON.stringify({ accountIds }),
  );
}

function send(
  server: Server,
  method: string,
  pathname: string,
  headers: Readonly<Record<string, string | undefined>> = {},
  body = '',
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not expose an IPv4 address.');
  }
  const filteredHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return new Promise((resolve, reject) => {
    const request = createRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path: pathname,
        headers: {
          Host: '127.0.0.1:4100',
          ...filteredHeaders,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body:
              responseBody.length === 0
                ? {}
                : (JSON.parse(responseBody) as Record<string, unknown>),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close(error => (error === undefined ? resolve() : reject(error))),
  );
}
