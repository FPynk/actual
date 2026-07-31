import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import type { ActualTransactionGraphV1 } from '#contracts/adapter';
import type { SourceIdentityRepository } from '#database/source-identity-repository';
import { createFinanceCompanionHttpApplication } from '#http/server';
import type {
  ReconciliationCandidateRepository,
  ReconciliationCandidateV1,
} from '#reconciliation/candidates';
import { targetVersionHash } from '#reviews/classification';
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

describe('reconciliation review HTTP routes', () => {
  it('requires the existing session protections, redacts private data, and only re-reads Actual before approval', async () => {
    const credential = Buffer.alloc(32, 4).toString('base64url');
    const security = await createFinanceCompanionSecurity({
      bootstrapCredential: credential,
      localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
    });
    const graph = graphForTarget();
    let candidate: ReconciliationCandidateV1 = {
      id: 'private-candidate',
      sourceTransactionId: 'private-source',
      actualTransactionId: 'private-actual',
      actualTargetVersion: graph.targetVersionHash,
      score: 95,
      reasonCodes: ['source-observation', 'exact-account'],
      matcherVersion: 1,
      status: 'pending',
      decisionNote: null,
      decidedAt: null,
      createdAt: '2026-07-31T12:00:00.000Z',
    };
    const repository: ReconciliationCandidateRepository = {
      findBySourceAndActual: () => undefined,
      save: item => item,
      list: () => [candidate],
      read: () => candidate,
      markStale: () => {
        candidate = { ...candidate, status: 'stale' };
        return candidate;
      },
      recordRevalidatedDecision: (_id, status, decisionNote, decidedAt) => {
        candidate = { ...candidate, status, decisionNote, decidedAt };
        return candidate;
      },
    };
    const requests: string[] = [];
    const adapter: ActualAdapter = {
      execute: async request => {
        requests.push(request.kind);
        if (request.kind === 'read-actual-target') {
          return { kind: 'read-actual-target', target: graph };
        }
        if (request.kind === 'read-budget-snapshot') {
          return {
            kind: 'read-budget-snapshot',
            snapshot: {
              contractVersion: 1,
              budget: {
                budgetKeyHash: configuration.budgetKeyHash,
                currencyCode: configuration.budgetCurrencyCode,
                capturedAt: '2026-07-31T12:00:00.000Z',
              },
              accounts: [
                {
                  id: 'account',
                  name: 'Synthetic checking',
                  offBudget: false,
                  closed: false,
                  syncSource: null,
                  lastSync: null,
                  syncStatus: null,
                },
              ],
              payees: [],
            },
          };
        }
        throw new Error('FIN-21 must not make a mutating Actual request.');
      },
      getHealth: () => 'healthy',
      getActiveOperationStatus: () => null,
    };
    const sourceIdentityRepository: SourceIdentityRepository = {
      createSourceNamespace: () => {
        throw new Error('not used');
      },
      recordObservation: () => {
        throw new Error('not used');
      },
      readReconciliationSources: () => [
        {
          id: 'private-source',
          actualAccountId: 'account',
          externalTransactionId: 'private-external-id',
          amount: 100,
          transactionDate: '2026-07-29',
          postedDate: '2026-07-30',
          bookingStatus: 'posted',
          importedPayee: 'Synthetic bank merchant',
          normalizedPayeeKey: 'private-normalized-payee',
          fingerprint: 'f'.repeat(64),
        },
      ],
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
          candidateRepository: repository,
          sourceIdentityRepository,
          now: () => new Date('2026-07-31T12:01:00.000Z'),
        },
      ),
    );
    await listen(server);
    try {
      const loginBody = JSON.stringify({ credential });
      const login = await rawRequest(
        server,
        [
          'POST /api/v1/session HTTP/1.1',
          'Host: 127.0.0.1:4100',
          'Origin: http://127.0.0.1:4100',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(loginBody)}`,
          'Connection: close',
          '',
          loginBody,
        ].join('\r\n'),
      );
      const cookie = /Set-Cookie: ([^;]+)/i.exec(login)?.[1];
      const csrf = (
        JSON.parse(login.slice(login.indexOf('\r\n\r\n') + 4)) as {
          csrfToken: string;
        }
      ).csrfToken;
      expect(cookie).toBeDefined();
      const list = await rawRequest(
        server,
        [
          'GET /api/v1/reconciliation-candidates HTTP/1.1',
          'Host: 127.0.0.1:4100',
          `Cookie: ${cookie}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      expect(list).toMatch(/^HTTP\/1\.1 200 /);
      const listBody = JSON.parse(responseBody(list)) as {
        candidates: readonly { reviewId: string }[];
      };
      const reviewId = listBody.candidates[0]?.reviewId;
      if (reviewId === undefined) throw new Error('Missing review fixture.');
      expect(reviewId).toMatch(/^review_[A-Za-z0-9_-]{43}$/);
      expect(list).not.toContain('private-source');
      expect(list).not.toContain('private-actual');
      expect(list).not.toContain('a'.repeat(64));
      const detail = await rawRequest(
        server,
        [
          `GET /api/v1/reconciliation-candidates/${reviewId} HTTP/1.1`,
          'Host: 127.0.0.1:4100',
          `Cookie: ${cookie}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      expect(detail).toMatch(/^HTTP\/1\.1 200 /);
      expect(detail).toContain('Synthetic bank merchant');
      expect(detail).toContain('Synthetic checking');
      expect(detail).toContain('"amountMinorUnits":100');
      expect(detail).toContain('"currencyCode":"USD"');
      expect(detail).not.toContain('private-source');
      expect(detail).not.toContain('private-actual');
      expect(detail).not.toContain('private-external-id');
      expect(detail).not.toContain('private-normalized-payee');
      expect(detail).not.toContain('f'.repeat(64));
      expect(detail).not.toContain(graph.targetVersionHash);
      const decisionBody = JSON.stringify({ status: 'approved' });
      const decision = await rawRequest(
        server,
        [
          `POST /api/v1/reconciliation-candidates/${reviewId}/decision HTTP/1.1`,
          'Host: 127.0.0.1:4100',
          'Origin: http://127.0.0.1:4100',
          `Cookie: ${cookie}`,
          `X-Finance-Csrf: ${csrf}`,
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(decisionBody)}`,
          'Connection: close',
          '',
          decisionBody,
        ].join('\r\n'),
      );
      expect(decision).toMatch(/^HTTP\/1\.1 200 /);
      expect(decision).toContain('approved');
      expect(requests).toEqual([
        'read-actual-target',
        'read-budget-snapshot',
        'read-actual-target',
        'read-actual-target',
        'read-budget-snapshot',
      ]);
    } finally {
      await close(server);
    }
  });
});

function graphForTarget(): ActualTransactionGraphV1 {
  const parent = {
    id: 'private-actual',
    accountId: 'account',
    parentId: null,
    transferId: null,
    date: '2026-07-30',
    amountMinorUnits: 100,
    payeeId: null,
    categoryId: null,
    notes: null,
    importedId: null,
    importedPayee: 'Synthetic Actual merchant',
    cleared: true,
    reconciled: false,
    isParent: false,
    isChild: false,
    isStartingBalance: false,
    tombstone: false,
  } as const;
  const base = { contractVersion: 1 as const, parent, children: [] as const };
  return { ...base, targetVersionHash: targetVersionHash(base) };
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
function rawRequest(server: Server, message: string): Promise<string> {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Missing port');
  }
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
