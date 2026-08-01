import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import { createFinanceCompanionHttpApplication } from '#http/server';
import type { ReconciliationCandidateRepository } from '#reconciliation/candidates';
import { targetVersionHash } from '#reviews/classification';
import type {
  ClassificationReviewRecordV1,
  ClassificationReviewRepository,
} from '#reviews/classification-review';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';

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

describe('classification review HTTP routes', () => {
  it('uses shared security, records explicit guidance, and sends Actual read requests only', async () => {
    const credential = Buffer.alloc(32, 5).toString('base64url');
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
    });
    const graph = currentGraph();
    let record = categoryRecord(graph.targetVersionHash);
    const classificationRepository: ClassificationReviewRepository = {
      listClassificationReviews: () => [record],
      markClassificationReviewStale: () => {
        record = { ...record, status: 'stale' };
        return record;
      },
      recordClassificationDecision: (
        _record,
        status,
        selectedAction,
        decidedAt,
      ) => {
        record = { ...record, decidedAt, selectedAction, status };
        return record;
      },
    };
    const actualBefore = JSON.stringify(graph);
    const requests: string[] = [];
    const adapter: ActualAdapter = {
      execute: async request => {
        requests.push(request.kind);
        if (request.kind === 'read-actual-target') {
          return { kind: 'read-actual-target', target: graph };
        }
        if (request.kind === 'read-budget-snapshot') {
          return { kind: 'read-budget-snapshot', snapshot: snapshot() };
        }
        throw new Error('Classification review must not write Actual.');
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
          classificationRepository,
          now: () => new Date('2026-07-31T12:01:00.000Z'),
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
      const session = await login(server, credential);
      const list = await request(
        server,
        'GET /api/v1/classification-reviews HTTP/1.1',
        [`Cookie: ${session.cookie}`],
      );
      expect(list).toMatch(/^HTTP\/1.1 200 /);
      const reviewRef = (
        JSON.parse(responseBody(list)) as {
          reviews: readonly { reviewRef: string }[];
        }
      ).reviews[0]?.reviewRef;
      if (reviewRef === undefined) {
        throw new Error('Missing classification review.');
      }
      expect(reviewRef).toMatch(/^classification_[A-Za-z0-9_-]{43}$/);
      expect(list).not.toContain('private-target-id');
      expect(list).not.toContain('private-category-id');

      const detail = await request(
        server,
        `GET /api/v1/classification-reviews/${reviewRef} HTTP/1.1`,
        [`Cookie: ${session.cookie}`],
      );
      expect(detail).toMatch(/^HTTP\/1.1 200 /);
      expect(detail).toContain('Dining');
      expect(detail).toContain('Uncategorized');
      expect(detail).not.toContain('private note');
      expect(detail).not.toContain('private-target-id');
      expect(detail).not.toContain(graph.targetVersionHash);

      const invalidBody = JSON.stringify({ decision: 'approve' });
      const invalid = await request(
        server,
        `POST /api/v1/classification-reviews/${reviewRef}/decision HTTP/1.1`,
        decisionHeaders(session, invalidBody),
        invalidBody,
      );
      expect(invalid).toMatch(/^HTTP\/1.1 400 /);
      expect(record.status).toBe('pending');

      const decisionBody = JSON.stringify({
        action: 'categorize_once',
        decision: 'approve',
      });
      const decision = await request(
        server,
        `POST /api/v1/classification-reviews/${reviewRef}/decision HTTP/1.1`,
        decisionHeaders(session, decisionBody),
        decisionBody,
      );
      expect(decision).toMatch(/^HTTP\/1.1 200 /);
      expect(decision).toContain('categorize_once');
      expect(decision).toContain('Finance Companion did not change');

      const reloaded = await request(
        server,
        `GET /api/v1/classification-reviews/${reviewRef} HTTP/1.1`,
        [`Cookie: ${session.cookie}`],
      );
      expect(reloaded).toContain('categorize_once');
      expect(reloaded).toContain('approved');
      expect(requests).toEqual([
        'read-actual-target',
        'read-budget-snapshot',
        'read-actual-target',
        'read-budget-snapshot',
        'read-actual-target',
        'read-budget-snapshot',
      ]);
      expect(JSON.stringify(graph)).toBe(actualBefore);
    } finally {
      await close(server);
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
  const csrf = (JSON.parse(responseBody(response)) as { csrfToken: string })
    .csrfToken;
  if (cookie === undefined) throw new Error('Missing session cookie.');
  return { cookie, csrf };
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

function categoryRecord(targetHash: string): ClassificationReviewRecordV1 {
  return {
    createdAt: '2026-07-31T12:00:00.000Z',
    decidedAt: null,
    proposal: {
      accountId: 'private-account-id',
      confidence: 100,
      detectorVersion: 1,
      eligibleHistoryCount: 4,
      kind: 'category',
      payeeId: 'private-payee-id',
      proposedCategoryCount: 4,
      proposedCategoryId: 'private-category-id',
      reasonCodes: ['dominant-category-history'],
      reviewId: 'private-review-id',
      targetVersionHash: targetHash,
      transactionId: 'private-target-id',
    },
    selectedAction: null,
    status: 'pending',
  };
}

function currentGraph() {
  const parent = {
    id: 'private-target-id',
    accountId: 'private-account-id',
    parentId: null,
    transferId: null,
    date: '2026-07-30',
    amountMinorUnits: -1250,
    payeeId: 'private-payee-id',
    categoryId: null,
    notes: 'private note',
    importedId: 'private imported id',
    importedPayee: 'Coffee Shop',
    cleared: true,
    reconciled: false,
    isParent: false,
    isChild: false,
    isStartingBalance: false,
    tombstone: false,
  } as const;
  const canonical = { children: [], contractVersion: 1 as const, parent };
  return { ...canonical, targetVersionHash: targetVersionHash(canonical) };
}

function snapshot() {
  return {
    contractVersion: 1 as const,
    budget: {
      budgetKeyHash: configuration.budgetKeyHash,
      capturedAt: '2026-07-31T12:00:30.000Z',
      currencyCode: 'USD',
    },
    accounts: [
      {
        id: 'private-account-id',
        name: 'Checking',
        offBudget: false,
        closed: false,
        syncSource: null,
        lastSync: null,
        syncStatus: null,
      },
    ],
    payees: [
      {
        id: 'private-payee-id',
        name: 'Coffee Payee',
        transferAccountId: null,
      },
    ],
    categories: [
      {
        id: 'private-category-id',
        name: 'Dining',
        groupId: 'private-group-id',
        isIncome: false,
        hidden: false,
      },
    ],
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
): Promise<string> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Missing server port.');
  }
  const message = [
    requestLine,
    'Host: 127.0.0.1:4100',
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
