import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import { createFinanceCompanionHttpApplication } from '#http/server';
import type { ReconciliationCandidateRepository } from '#reconciliation/candidates';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';
import { SqliteSubscriptionCandidateRepository } from '#subscriptions/sqlite-subscription-candidate-repository';
import type { SubscriptionHistoryTransactionV1 } from '#subscriptions/subscription-detector';
import { scanSubscriptionCandidates } from '#subscriptions/subscription-scan-service';

import { createTestRequestReplayRepository } from './fixtures/request-replay-repository.ts';

const configuration: FinanceCompanionConfiguration = {
  bindAddress: '127.0.0.1',
  port: 4100,
  origin: 'http://127.0.0.1:4100',
  dataDirectory: 'C:\\synthetic',
  databasePath: 'C:\\synthetic\\companion.sqlite',
  integrityAnchorPath: 'C:\\synthetic\\anchor',
  integrityMacKeyFile: undefined,
  integrityMacKey: undefined,
  budgetKeyHash: 'a'.repeat(64),
  budgetCurrencyCode: 'USD',
  ownerBootstrapCredential: undefined,
  ownerBootstrapCredentialFile: undefined,
};

describe('subscription review HTTP routes', () => {
  it('enforces shared security and closed actions while Actual stays unchanged', async () => {
    const database = new Database(':memory:');
    database.exec(
      await readFile(
        path.resolve(
          import.meta.dirname,
          '../../migrations/004-review-candidates.sql',
        ),
        'utf8',
      ),
    );
    const subscriptionRepository = new SqliteSubscriptionCandidateRepository(
      database,
    );
    const history = monthlyHistory();
    const schedules = [monthlySchedule()] as const;
    await scanSubscriptionCandidates({
      clock: { now: () => new Date('2026-04-30T12:00:00.000Z') },
      repository: subscriptionRepository,
      schedules,
      transactions: history,
    });
    const credential = Buffer.alloc(32, 6).toString('base64url');
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
    });
    const actualBefore = JSON.stringify({ history, schedules });
    let actualMutationCount = 0;
    const adapter: ActualAdapter = {
      execute: async request => {
        if (request.kind !== 'read-budget-snapshot') {
          actualMutationCount += 1;
          throw new Error('Subscription review must not mutate Actual.');
        }
        const transactions =
          request.transactionRange === undefined
            ? undefined
            : history
                .filter(
                  transaction =>
                    transaction.date >= request.transactionRange!.startDate &&
                    transaction.date <
                      request.transactionRange!.endDateExclusive,
                )
                .map(transaction => ({
                  id: transaction.id,
                  accountId: transaction.accountId,
                  parentId: null,
                  transferId: null,
                  date: transaction.date,
                  amountMinorUnits: transaction.amount,
                  payeeId: transaction.payeeId,
                  categoryId: null,
                  notes: 'private transaction note',
                  importedId: 'private imported id',
                  importedPayee: 'private imported payee',
                  cleared: true,
                  reconciled: transaction.isReconciled,
                  isParent: false,
                  isChild: false,
                  isStartingBalance: false,
                  tombstone: false,
                }));
        return {
          kind: 'read-budget-snapshot',
          snapshot: {
            contractVersion: 1,
            budget: {
              budgetKeyHash: configuration.budgetKeyHash,
              capturedAt: '2026-04-30T12:00:00.000Z',
              currencyCode: 'USD',
            },
            ...(request.sections.includes('accounts')
              ? {
                  accounts: [
                    {
                      id: 'account-private',
                      name: 'Checking\u0007 account',
                      offBudget: false,
                      closed: false,
                      syncSource: null,
                      lastSync: null,
                      syncStatus: null,
                    },
                  ],
                }
              : {}),
            ...(request.sections.includes('payees')
              ? {
                  payees: [
                    {
                      id: 'payee-private',
                      name: '<img src=x onerror=alert(1)>',
                      transferAccountId: null,
                    },
                  ],
                }
              : {}),
            ...(request.sections.includes('schedules') ? { schedules } : {}),
            ...(transactions === undefined ? {} : { transactions }),
          },
        };
      },
      getActiveOperationStatus: () => null,
      getHealth: () => 'healthy',
    };
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
        undefined,
        {
          adapter,
          candidateRepository: unusedReconciliationRepository(),
          subscriptionRepository,
          now: () => new Date('2026-04-30T12:01:00.000Z'),
          sourceIdentityRepository: {
            createSourceNamespace: () => {
              throw new Error('not used');
            },
            readReconciliationSources: () => [],
            recordObservation: () => {
              throw new Error('not used');
            },
          },
        },
      ),
    );
    await listen(server);
    try {
      const unauthenticated = await request(
        server,
        'GET /api/v1/subscription-reviews HTTP/1.1',
        [],
      );
      expect(unauthenticated).toMatch(/^HTTP\/1.1 401 /);
      const badHost = await request(
        server,
        'GET /api/v1/subscription-reviews HTTP/1.1',
        [],
        '',
        'attacker.invalid',
      );
      expect(badHost).toMatch(/^HTTP\/1.1 400 /);

      const session = await login(server, credential);
      const list = await request(
        server,
        'GET /api/v1/subscription-reviews HTTP/1.1',
        [`Cookie: ${session.cookie}`],
      );
      expect(list).toMatch(/^HTTP\/1.1 200 /);
      const parsedList: unknown = JSON.parse(responseBody(list));
      if (!hasReviewRef(parsedList)) throw new Error('Review ref is missing.');
      const reviewRef = parsedList.reviews[0].reviewRef;
      expect(reviewRef).toMatch(/^subscription_[A-Za-z0-9_-]{43}$/);
      expect(list).not.toContain('account-private');
      expect(list).not.toContain('payee-private');
      expect(list).not.toContain('schedule-private');
      expect(list).not.toContain(configuration.budgetKeyHash);

      const detail = await request(
        server,
        `GET /api/v1/subscription-reviews/${reviewRef} HTTP/1.1`,
        [`Cookie: ${session.cookie}`],
      );
      expect(detail).toMatch(/^HTTP\/1.1 200 /);
      expect(detail).toContain('<img src=x onerror=alert(1)>');
      expect(detail).not.toContain('private transaction note');
      expect(detail).not.toContain('private imported id');
      expect(detail).not.toContain('Checking\\u0007');

      const invalidBody = JSON.stringify({
        kind: 'approve',
        userSelectedType: 'subscription',
        hiddenDefault: true,
      });
      expect(
        await request(
          server,
          `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
          decisionHeaders(session, invalidBody),
          invalidBody,
        ),
      ).toMatch(/^HTTP\/1.1 400 /);

      const decisionBody = JSON.stringify({
        kind: 'approve',
        userSelectedType: 'subscription',
      });
      expect(
        await request(
          server,
          `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
          decisionHeaders(session, decisionBody).filter(
            header => !header.startsWith('Origin:'),
          ),
          decisionBody,
        ),
      ).toMatch(/^HTTP\/1.1 403 /);
      expect(
        await request(
          server,
          `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
          decisionHeaders(session, decisionBody).filter(
            header => !header.startsWith('X-Finance-Csrf:'),
          ),
          decisionBody,
        ),
      ).toMatch(/^HTTP\/1.1 403 /);
      expect(
        await request(
          server,
          `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
          decisionHeaders(session, decisionBody).map(header =>
            header.startsWith('Content-Type:')
              ? 'Content-Type: application/json'
              : header,
          ),
          decisionBody,
        ),
      ).toMatch(/^HTTP\/1.1 415 /);

      const approved = await request(
        server,
        `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
        decisionHeaders(session, decisionBody),
        decisionBody,
      );
      expect(approved).toMatch(/^HTTP\/1.1 200 /);
      expect(approved).toContain('"status":"approved"');
      expect(approved).toContain('"selectedType":"subscription"');
      const replayedApproval = await request(
        server,
        `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
        decisionHeaders(session, decisionBody),
        decisionBody,
      );
      expect(replayedApproval).toMatch(/^HTTP\/1.1 409 /);
      expect(replayedApproval).toContain('"code":"review_conflict"');
      const reloaded = await request(
        server,
        `GET /api/v1/subscription-reviews/${reviewRef} HTTP/1.1`,
        [`Cookie: ${session.cookie}`],
      );
      expect(reloaded).toContain('"status":"approved"');

      const reopenBody = JSON.stringify({ kind: 'reopen' });
      const reopened = await request(
        server,
        `POST /api/v1/subscription-reviews/${reviewRef}/decision HTTP/1.1`,
        decisionHeaders(session, reopenBody),
        reopenBody,
      );
      expect(reopened).toMatch(/^HTTP\/1.1 200 /);
      expect(reopened).toContain('"status":"pending"');
      expect(reopened).toContain('"selectedType":null');
      expect(actualMutationCount).toBe(0);
      expect(JSON.stringify({ history, schedules })).toBe(actualBefore);
    } finally {
      await close(server);
      database.close();
    }
  });
});

function decisionHeaders(
  session: Readonly<{ cookie: string; csrf: string }>,
  body: string,
): string[] {
  return [
    'Origin: http://127.0.0.1:4100',
    `Cookie: ${session.cookie}`,
    `X-Finance-Csrf: ${session.csrf}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
}

async function login(server: Server, credential: string) {
  const body = JSON.stringify({ credential });
  const response = await request(
    server,
    'POST /api/v1/session HTTP/1.1',
    [
      'Origin: http://127.0.0.1:4100',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
    ],
    body,
  );
  const cookie = /Set-Cookie: ([^;]+)/i.exec(response)?.[1];
  const parsed: unknown = JSON.parse(responseBody(response));
  if (
    cookie === undefined ||
    typeof parsed !== 'object' ||
    parsed === null ||
    !('csrfToken' in parsed) ||
    typeof parsed.csrfToken !== 'string'
  ) {
    throw new Error('Session response is invalid.');
  }
  return { cookie, csrf: parsed.csrfToken };
}

function hasReviewRef(value: unknown): value is Readonly<{
  reviews: readonly [Readonly<{ reviewRef: string }>, ...unknown[]];
}> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('reviews' in value) ||
    !Array.isArray(value.reviews) ||
    value.reviews.length === 0
  ) {
    return false;
  }
  const first: unknown = value.reviews[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'reviewRef' in first &&
    typeof first.reviewRef === 'string'
  );
}

function unusedReconciliationRepository(): ReconciliationCandidateRepository {
  return {
    findBySourceAndActual: () => undefined,
    list: () => [],
    markStale: () => {
      throw new Error('not used');
    },
    read: () => {
      throw new Error('not used');
    },
    recordRevalidatedDecision: () => {
      throw new Error('not used');
    },
    save: candidate => candidate,
  };
}

function monthlyHistory(): readonly SubscriptionHistoryTransactionV1[] {
  return ['2026-01-15', '2026-02-15', '2026-03-15'].map((date, index) => ({
    accountId: 'account-private',
    amount: -1_000,
    date,
    id: `transaction-private-${index}`,
    isReconciled: false,
    isSplitParent: false,
    isStartingBalance: false,
    isTombstone: false,
    isTransfer: false,
    payeeId: 'payee-private',
  }));
}

function monthlySchedule() {
  return {
    id: 'schedule-private',
    accountId: 'account-private',
    payeeId: 'payee-private',
    amount: -1_000,
    amountOperator: 'is' as const,
    recurrence: {
      kind: 'recurring' as const,
      frequency: 'monthly' as const,
      interval: 1,
      start: '2026-01-15',
    },
    isCompleted: false,
  };
}

function responseBody(response: string): string {
  return response.slice(response.indexOf('\r\n\r\n') + 4);
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

function request(
  server: Server,
  requestLine: string,
  headers: readonly string[],
  body = '',
  host = '127.0.0.1:4100',
): Promise<string> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Missing server port.');
  }
  const message = [
    requestLine,
    `Host: ${host}`,
    ...headers,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection(
      { host: '127.0.0.1', port: address.port },
      () => socket.write(message),
    );
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}
