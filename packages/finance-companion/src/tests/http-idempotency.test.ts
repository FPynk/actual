import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request as createRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { FinanceCompanionConfiguration } from '#config';
import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import { createSqliteLocalPrincipalRepository } from '#database/sqlite-local-principal-repository';
import { calculateRequestReplayHash } from '#http/request-idempotency';
import { createFinanceCompanionHttpApplication } from '#http/server';
import { SqliteReconciliationCandidateRepository } from '#reconciliation/sqlite-reconciliation-candidate-repository';
import {
  createFinanceCompanionSecurity,
  hashOwnerBootstrapCredential,
} from '#security/local-security';
import { createSqliteRequestReplayRepository } from '#service/request-replay-repository';

const credential = Buffer.alloc(32, 19).toString('base64url');

describe('FIN-13 HTTP request idempotency', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let server: Server;
  let reviewDatabase: ReturnType<typeof openCompanionDatabase>;
  let validExport: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-http-replay-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    const configuration: FinanceCompanionConfiguration = {
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
    const ownerCredentialHash = await hashOwnerBootstrapCredential(
      credential,
      undefined,
    );
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
      createOwnerCredentialHash: async () => ownerCredentialHash,
    });
    const security = await createFinanceCompanionSecurity({
      localPrincipalRepository:
        createSqliteLocalPrincipalRepository(databasePath),
    });
    validExport = await readFile(
      path.resolve(
        import.meta.dirname,
        'fixtures/amazon-export-one-order.json',
      ),
      'utf8',
    );
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
            execute: async request => {
              if (request.kind !== 'read-budget-snapshot') {
                return { kind: 'read-actual-target', target: null };
              }
              return {
                kind: 'read-budget-snapshot',
                snapshot: {
                  contractVersion: 1,
                  budget: {
                    budgetKeyHash: configuration.budgetKeyHash,
                    currencyCode: configuration.budgetCurrencyCode,
                    capturedAt: '2026-01-10T00:00:00.000Z',
                  },
                  transactions: [],
                },
              };
            },
            getHealth: () => 'healthy',
            getActiveOperationStatus: () => null,
          },
          amazonDatabasePath: databasePath,
          candidateRepository: new SqliteReconciliationCandidateRepository(
            reviewDatabase,
          ),
          sourceIdentityRepository:
            createSqliteSourceIdentityRepository(databasePath),
          now: () => new Date('2026-01-10T00:00:00.000Z'),
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

  it('requires a valid key, replays the exact terminal response, and conflicts on changed uploads', async () => {
    const session = await login(server);
    const first = await upload(
      server,
      session,
      'a-valid-idempotency-key',
      validExport,
    );
    expect(first.statusCode).toBe(201);
    expect(first.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(first.body).toMatchObject({
      status: 'completed',
      replayed: false,
      receipt: { acceptedCount: 3, rejectedCount: 0 },
    });
    expect(Object.keys(first.body).sort()).toEqual([
      'candidateCount',
      'receipt',
      'replayed',
      'status',
      'version',
    ]);
    expect(JSON.stringify(first.body)).not.toContain(credential);
    expect(JSON.stringify(first.body)).not.toContain(session.csrfToken);
    expect(
      reviewDatabase
        .prepare(
          'SELECT request_hash AS requestHash FROM request_replays WHERE idempotency_key = ?',
        )
        .get('a-valid-idempotency-key'),
    ).toEqual({
      requestHash: calculateRequestReplayHash({
        adapterVersion: 'amazon-import/v1',
        byteHash: createHash('sha256')
          .update(Buffer.from(validExport, 'ascii'))
          .digest('hex'),
        mediaKind: 'amazon-export-json',
      }),
    });

    const replay = await upload(
      server,
      session,
      'a-valid-idempotency-key',
      validExport,
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(replay.body).toEqual(first.body);

    const changed = await upload(
      server,
      session,
      'a-valid-idempotency-key',
      `${validExport}\n`,
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.body).toMatchObject({
      code: 'idempotency_conflict',
      message: 'The idempotency key was reused for a different request.',
    });

    const database = openCompanionDatabase(databasePath, true);
    try {
      database
        .prepare(
          "UPDATE request_replays SET status = 'in_progress', response_status = NULL, response_json = NULL, completed_at = NULL, expires_at = NULL WHERE idempotency_key = ?",
        )
        .run('a-valid-idempotency-key');
    } finally {
      database.close();
    }
    const inProgress = await upload(
      server,
      session,
      'a-valid-idempotency-key',
      validExport,
    );
    expect(inProgress.statusCode).toBe(409);
    expect(inProgress.body).toMatchObject({
      code: 'operation_in_progress',
      message: 'The operation is already in progress.',
    });
    expect(
      (await readdir(temporaryDirectory)).filter(name =>
        name.startsWith('finance-companion-upload-'),
      ),
    ).toEqual([]);

    const missing = await upload(server, session, undefined, validExport);
    expect(missing.statusCode).toBe(400);
    const invalid = await upload(server, session, 'short', validExport);
    expect(invalid.statusCode).toBe(400);
  });
});

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
    Buffer.from(JSON.stringify({ credential })),
  );
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
  const csrfToken = (response.body as { csrfToken?: unknown }).csrfToken;
  if (
    response.statusCode !== 201 ||
    cookie === undefined ||
    typeof csrfToken !== 'string'
  ) {
    throw new Error('Synthetic login did not return a session.');
  }
  return { cookie, csrfToken };
}

function upload(
  server: Server,
  session: { cookie: string; csrfToken: string },
  idempotencyKey: string | undefined,
  content: string,
) {
  const boundary = 'replay-boundary';
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="orders.json"',
      'Content-Type: application/json',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'ascii',
  );
  return send(
    server,
    'POST',
    '/api/v1/imports/amazon',
    {
      Origin: 'http://127.0.0.1:4100',
      Cookie: session.cookie,
      'X-Finance-CSRF': session.csrfToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...(idempotencyKey === undefined
        ? {}
        : { 'Idempotency-Key': idempotencyKey }),
    },
    body,
  );
}

function send(
  server: Server,
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not expose an IPv4 address.');
  }
  return new Promise((resolve, reject) => {
    const request = createRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path: pathname,
        headers: {
          Host: '127.0.0.1:4100',
          ...headers,
          'Content-Length': body.length,
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
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
