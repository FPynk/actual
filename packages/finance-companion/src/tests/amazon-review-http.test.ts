import { request as createRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import type { ActualTransactionGraphV1 } from '#contracts/adapter';
import { createFinanceCompanionHttpApplication } from '#http/server';
import type { ReconciliationCandidateRepository } from '#reconciliation/candidates';
import { targetVersionHash } from '#reviews/classification';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';
import type {
  AmazonReviewRecordV1,
  AmazonReviewRepository,
} from '#service/amazon-review-repository';

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

describe('Amazon review HTTP routes', () => {
  it('enforces session, origin, CSRF, closed decisions, and privacy-safe DTOs while Actual remains read-only', async () => {
    const credential = Buffer.alloc(32, 23).toString('base64url');
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
    });
    const graphWithoutHash = {
      contractVersion: 1 as const,
      parent: {
        id: 'private-actual-id',
        accountId: 'private-account-id',
        parentId: null,
        transferId: null,
        date: '2026-01-02',
        amountMinorUnits: -100,
        payeeId: 'private-payee-id',
        categoryId: 'private-category-id',
        notes: 'private note',
        importedId: 'private imported id',
        importedPayee: 'private imported payee',
        cleared: true,
        reconciled: false,
        isParent: false,
        isChild: false,
        isStartingBalance: false,
        tombstone: false,
      },
      children: [],
    };
    const graph: ActualTransactionGraphV1 = {
      ...graphWithoutHash,
      targetVersionHash: targetVersionHash(graphWithoutHash),
    };
    let record: AmazonReviewRecordV1 = {
      id: 'private-match-id',
      matcherVersion: 2,
      currencyCode: 'USD',
      score: 100,
      reasonCodes: ['exact-parent-sum'],
      status: 'pending',
      createdAt: '2026-01-03T00:00:00.000Z',
      decidedAt: null,
      parents: [
        {
          actualTransactionId: graph.parent.id,
          actualTargetVersion: graph.targetVersionHash,
          allocatedAmountMinorUnits: -100,
          applicationStatus: 'pending',
          allocations: [
            {
              kind: 'merchandise',
              amountMinorUnits: -100,
              itemTitle: '<script>synthetic title</script>',
              proposedActualCategoryId: null,
            },
          ],
        },
      ],
    };
    const amazonRepository: AmazonReviewRepository = {
      listAmazonReviewRecords: () => [record],
      recordAmazonReviewDecision: (expected, action, decidedAt) => {
        if (expected.status !== record.status) {
          throw new Error('synthetic conflict');
        }
        record = {
          ...record,
          status:
            action.kind === 'approve'
              ? 'approved'
              : action.kind === 'reject'
                ? 'rejected'
                : action.kind === 'defer'
                  ? 'deferred'
                  : 'pending',
          decidedAt: action.kind === 'reopen' ? null : decidedAt,
        };
        return record;
      },
      markAmazonReviewStale: () => {
        record = { ...record, status: 'stale' };
      },
    };
    let mutationAttempts = 0;
    const adapter: ActualAdapter = {
      execute: async request => {
        if (request.kind === 'read-actual-target') {
          return { kind: 'read-actual-target', target: graph };
        }
        if (request.kind !== 'read-budget-snapshot') {
          mutationAttempts += 1;
          throw new Error('Amazon review attempted to mutate Actual.');
        }
        return {
          kind: 'read-budget-snapshot',
          snapshot: {
            contractVersion: 1,
            budget: {
              budgetKeyHash: configuration.budgetKeyHash,
              currencyCode: 'USD',
              capturedAt: '2026-01-03T00:00:00.000Z',
            },
            accounts: [
              {
                id: 'private-account-id',
                name: 'Synthetic card',
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
                name: 'Amazon & marketplace',
                transferAccountId: null,
              },
            ],
            categoryGroups: [],
            categories: [
              {
                id: 'private-category-id',
                name: 'Shopping',
                groupId: 'group-id',
                isIncome: false,
                hidden: false,
              },
            ],
          },
        };
      },
      getHealth: () => 'healthy',
      getActiveOperationStatus: () => null,
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
          amazonReviewRepository: amazonRepository,
          candidateRepository: unusedReconciliationRepository(),
          sourceIdentityRepository: {
            createSourceNamespace: () => {
              throw new Error('not used');
            },
            readReconciliationSources: () => [],
            recordObservation: () => {
              throw new Error('not used');
            },
          },
          now: () => new Date('2026-01-04T00:00:00.000Z'),
        },
      ),
    );
    await listen(server);
    try {
      expect(
        (await send(server, 'GET', '/api/v1/amazon-reviews')).statusCode,
      ).toBe(401);
      const session = await login(server, credential);
      const list = await send(server, 'GET', '/api/v1/amazon-reviews', {
        Cookie: session.cookie,
      });
      expect(list.statusCode).toBe(200);
      const listBody = list.body as {
        reviews?: readonly { reviewRef?: unknown }[];
      };
      const reviewRef = listBody.reviews?.[0]?.reviewRef;
      expect(reviewRef).toMatch(/^amazon_[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(list.body)).not.toContain('private-match-id');
      expect(JSON.stringify(list.body)).not.toContain('private-actual-id');
      expect(JSON.stringify(list.body)).not.toContain('synthetic title');
      if (typeof reviewRef !== 'string') throw new Error('Missing review ref.');

      const detail = await send(
        server,
        'GET',
        `/api/v1/amazon-reviews/${reviewRef}`,
        { Cookie: session.cookie },
      );
      expect(detail.statusCode).toBe(200);
      expect(JSON.stringify(detail.body)).toContain('synthetic title');
      expect(JSON.stringify(detail.body)).toContain('Synthetic card');
      expect(JSON.stringify(detail.body)).not.toContain('private-actual-id');
      expect(JSON.stringify(detail.body)).not.toContain('private note');
      expect(JSON.stringify(detail.body)).not.toContain('private imported id');

      const invalid = JSON.stringify({ kind: 'approve', apply: true });
      expect(
        (
          await send(
            server,
            'POST',
            `/api/v1/amazon-reviews/${reviewRef}/decision`,
            decisionHeaders(session, invalid),
            invalid,
          )
        ).statusCode,
      ).toBe(400);
      const decision = JSON.stringify({ kind: 'approve' });
      expect(
        (
          await send(
            server,
            'POST',
            `/api/v1/amazon-reviews/${reviewRef}/decision`,
            {
              ...decisionHeaders(session, decision),
              Origin: undefined,
            },
            decision,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await send(
            server,
            'POST',
            `/api/v1/amazon-reviews/${reviewRef}/decision`,
            {
              ...decisionHeaders(session, decision),
              'X-Finance-CSRF': undefined,
            },
            decision,
          )
        ).statusCode,
      ).toBe(403);
      const approved = await send(
        server,
        'POST',
        `/api/v1/amazon-reviews/${reviewRef}/decision`,
        decisionHeaders(session, decision),
        decision,
      );
      expect(approved.statusCode).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'approved',
        guidance: expect.stringContaining('did not change Actual'),
      });
      expect(mutationAttempts).toBe(0);
    } finally {
      await close(server);
    }
  });
});

function decisionHeaders(
  session: Readonly<{ cookie: string; csrf: string }>,
  body: string,
): Record<string, string | undefined> {
  return {
    Origin: configuration.origin,
    Cookie: session.cookie,
    'X-Finance-CSRF': session.csrf,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  };
}

async function login(server: Server, credential: string) {
  const body = JSON.stringify({ credential });
  const response = await send(
    server,
    'POST',
    '/api/v1/session',
    {
      Origin: configuration.origin,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  );
  const cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
  const csrf = (response.body as { csrfToken?: unknown }).csrfToken;
  if (cookie === undefined || typeof csrf !== 'string') {
    throw new Error('Synthetic login failed.');
  }
  return { cookie, csrf };
}

function send(
  server: Server,
  method: string,
  pathname: string,
  headers: Record<string, string | undefined> = {},
  body = '',
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server address unavailable.');
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
          ...Object.fromEntries(
            Object.entries(headers).filter(([, value]) => value !== undefined),
          ),
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: text === '' ? null : JSON.parse(text),
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

function unusedReconciliationRepository(): ReconciliationCandidateRepository {
  return {
    findBySourceAndActual: () => undefined,
    list: () => [],
    read: () => {
      throw new Error('not used');
    },
    recordRevalidatedDecision: () => {
      throw new Error('not used');
    },
    save: value => value,
    markStale: () => {
      throw new Error('not used');
    },
  };
}
