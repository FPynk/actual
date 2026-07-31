import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteSourceIdentityRepository } from '#database/source-identity-repository';
import type {
  SourceIdentityRepository,
  SourceTransactionForReconciliation,
} from '#database/source-identity-repository';
import {
  decideReconciliationCandidate,
  generateReconciliationCandidates,
  scoreCandidate,
} from '#reconciliation/candidates';
import { SqliteReconciliationCandidateRepository } from '#reconciliation/sqlite-reconciliation-candidate-repository';
import { targetVersionHash } from '#reviews/classification';

const createdAt = '2026-07-31T12:00:00.000Z';
const accountId = 'checking-account';
let temporaryDirectory: string;
let databasePath: string;
let sourceIdentityRepository: SourceIdentityRepository;
let sourceNamespaceId: string;
let nextSourceRowIndex: number;

describe('FIN-20 read-only reconciliation candidates', () => {
  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-reconciliation-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    await initializeCompanionDatabaseAndAnchor({
      anchorMacKey: randomBytes(32),
      anchorPath: path.join(temporaryDirectory, 'anchor.json'),
      budgetCurrencyCode: 'USD',
      budgetKeyHash: 'a'.repeat(64),
      createOwnerCredentialHash: async () => 'test-owner-hash',
      databasePath,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        '../../migrations',
      ),
    });
    sourceIdentityRepository =
      createSqliteSourceIdentityRepository(databasePath);
    sourceNamespaceId = randomUUID();
    sourceIdentityRepository.createSourceNamespace({
      createdAt,
      displayName: 'Synthetic Bank',
      id: sourceNamespaceId,
      kind: 'statement',
      namespace: 'synthetic-bank',
    });
    nextSourceRowIndex = 0;
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('generates competing, separate review-only candidates without changing the Actual snapshot', async () => {
    const firstSourceId = recordSourceObservation('purchase-one', '2026-07-30');
    const secondSourceId = recordSourceObservation(
      'purchase-two',
      '2026-07-30',
    );
    const firstTarget = transaction({ id: 'actual-one' });
    const secondTarget = transaction({ id: 'actual-two', date: '2026-07-28' });
    const snapshot = snapshotOf([firstTarget, secondTarget]);
    const snapshotBeforeRead = JSON.stringify(snapshot);
    const requests: string[] = [];
    const adapter = readOnlyAdapter([firstTarget, secondTarget], requests);
    const database = openCompanionDatabase(databasePath, true);
    try {
      const repository = new SqliteReconciliationCandidateRepository(database);
      const candidates = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: sequentialIds('candidate'),
        createdAt,
        snapshot,
        sourceIdentityRepository,
      });

      expect(candidates).toHaveLength(4);
      expect(
        candidates.filter(
          candidate => candidate.sourceTransactionId === firstSourceId,
        ),
      ).toHaveLength(2);
      expect(
        candidates.filter(
          candidate => candidate.sourceTransactionId === secondSourceId,
        ),
      ).toHaveLength(2);
      expect(candidates[0]?.reasonCodes).toContain('fingerprint-review-only');
      expect(candidates[0]?.reasonCodes).toContain('changed-id-review-only');
      expect(candidates[0]?.status).toBe('pending');
      expect(requests).toEqual([
        'read-actual-target',
        'read-actual-target',
        'read-actual-target',
        'read-actual-target',
      ]);
      expect(snapshotBeforeRead).toBe(JSON.stringify(snapshot));

      const rerun = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: () => 'must-not-be-used',
        createdAt,
        snapshot,
        sourceIdentityRepository,
      });
      expect(rerun).toEqual(candidates);
      expect(requests).toHaveLength(8);
      expect(repository.list()).toEqual(candidates);
    } finally {
      database.close();
    }
  });

  it.each([
    {
      bookingStatus: 'pending' as const,
      cleared: false,
      date: '2026-07-30',
      expectedReasons: ['date-exact', 'payee-match', 'pending-compatible'],
      expectedScore: 100,
      sourceDate: '2026-07-30',
    },
    {
      bookingStatus: 'posted' as const,
      cleared: false,
      date: '2026-07-26',
      expectedReasons: [
        'date-outside-window',
        'payee-mismatch',
        'posted-uncleared',
      ],
      expectedScore: 60,
      sourceDate: '2026-07-30',
    },
    {
      bookingStatus: 'unknown' as const,
      cleared: true,
      date: '2026-07-28',
      expectedReasons: [
        'date-within-three-days',
        'payee-unavailable',
        'booking-status-unknown',
      ],
      expectedScore: 70,
      sourceDate: '2026-07-30',
    },
  ])(
    'scores date, normalized payee, and booking compatibility deterministically',
    ({
      bookingStatus,
      cleared,
      date,
      expectedReasons,
      expectedScore,
      sourceDate,
    }) => {
      const source: SourceTransactionForReconciliation = {
        actualAccountId: accountId,
        amount: -1250,
        bookingStatus,
        externalTransactionId: 'stable-source-id',
        fingerprint: 'f'.repeat(64),
        id: 'source',
        importedPayee:
          expectedScore === 70
            ? null
            : expectedScore === 60
              ? 'Other Shop'
              : '  COFFEE\u00a0SHOP ',
        normalizedPayeeKey: null,
        postedDate: null,
        transactionDate: sourceDate,
      };
      const target = transaction({
        cleared,
        date,
        importedPayee: 'coffee shop',
      });
      const result = scoreCandidate(source, target);
      expect(result.score).toBe(expectedScore);
      expect(result.reasonCodes).toEqual(
        expect.arrayContaining(expectedReasons),
      );
    },
  );

  it('rejects reconciled targets and account or amount mismatches before target reads', async () => {
    recordSourceObservation('source', '2026-07-30');
    const reconciled = transaction({ id: 'reconciled', reconciled: true });
    const otherAccount = transaction({
      accountId: 'other',
      id: 'other-account',
    });
    const differentAmount = transaction({
      amountMinorUnits: -99,
      id: 'other-amount',
    });
    const requests: string[] = [];
    const database = openCompanionDatabase(databasePath, true);
    try {
      const candidates = await generateReconciliationCandidates({
        adapter: readOnlyAdapter(
          [reconciled, otherAccount, differentAmount],
          requests,
        ),
        candidateRepository: new SqliteReconciliationCandidateRepository(
          database,
        ),
        createId: sequentialIds('candidate'),
        createdAt,
        snapshot: snapshotOf([reconciled, otherAccount, differentAmount]),
        sourceIdentityRepository,
      });
      expect(candidates).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('marks a stored candidate stale when regeneration observes an edited target', async () => {
    recordSourceObservation('source', '2026-07-30');
    let currentTarget = transaction({ id: 'actual-one' });
    const requests: string[] = [];
    const adapter = dynamicReadOnlyAdapter(() => [currentTarget], requests);
    const database = openCompanionDatabase(databasePath, true);
    try {
      const repository = new SqliteReconciliationCandidateRepository(database);
      const [candidate] = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: () => 'candidate-one',
        createdAt,
        snapshot: snapshotOf([currentTarget]),
        sourceIdentityRepository,
      });
      expect(candidate?.status).toBe('pending');

      currentTarget = { ...currentTarget, notes: 'target changed' };
      const regenerated = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: () => 'must-not-be-used',
        createdAt,
        snapshot: snapshotOf([currentTarget]),
        sourceIdentityRepository,
      });
      expect(regenerated).toHaveLength(1);
      expect(regenerated[0]?.status).toBe('stale');
      expect(requests).toEqual(['read-actual-target', 'read-actual-target']);
    } finally {
      database.close();
    }
  });

  it('revalidates the authoritative target before recording a decision', async () => {
    recordSourceObservation('source', '2026-07-30');
    let currentTarget = transaction({ id: 'actual-one' });
    const requests: string[] = [];
    const adapter = dynamicReadOnlyAdapter(() => [currentTarget], requests);
    const database = openCompanionDatabase(databasePath, true);
    try {
      const repository = new SqliteReconciliationCandidateRepository(database);
      const [candidate] = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: () => 'candidate-one',
        createdAt,
        snapshot: snapshotOf([currentTarget]),
        sourceIdentityRepository,
      });
      if (candidate === undefined) throw new Error('Candidate is missing.');

      currentTarget = { ...currentTarget, reconciled: true };
      const decision = await decideReconciliationCandidate({
        adapter,
        candidateId: candidate.id,
        candidateRepository: repository,
        decidedAt: '2026-07-31T13:00:00.000Z',
        decisionNote: 'must not be recorded',
        status: 'approved',
      });
      expect(decision).toMatchObject({
        decidedAt: null,
        decisionNote: null,
        status: 'stale',
      });
      expect(requests).toEqual(['read-actual-target', 'read-actual-target']);
    } finally {
      database.close();
    }
  });

  it('marks a candidate stale when the authoritative target was deleted', async () => {
    recordSourceObservation('source', '2026-07-30');
    let currentTargets: readonly ActualTransactionV1[] = [
      transaction({ id: 'actual-one' }),
    ];
    const adapter = dynamicReadOnlyAdapter(() => currentTargets, []);
    const database = openCompanionDatabase(databasePath, true);
    try {
      const repository = new SqliteReconciliationCandidateRepository(database);
      const [candidate] = await generateReconciliationCandidates({
        adapter,
        candidateRepository: repository,
        createId: () => 'candidate-one',
        createdAt,
        snapshot: snapshotOf(currentTargets),
        sourceIdentityRepository,
      });
      if (candidate === undefined) throw new Error('Candidate is missing.');

      currentTargets = [];
      const decision = await decideReconciliationCandidate({
        adapter,
        candidateId: candidate.id,
        candidateRepository: repository,
        decidedAt: '2026-07-31T13:00:00.000Z',
        decisionNote: null,
        status: 'rejected',
      });
      expect(decision.status).toBe('stale');
    } finally {
      database.close();
    }
  });

  it('persists decisions across restart, marks changed hashes stale, and fails closed on corrupt rows or ID conflicts', async () => {
    recordSourceObservation('source', '2026-07-30');
    const target = transaction({ id: 'actual-one' });
    const database = openCompanionDatabase(databasePath, true);
    let candidateId: string;
    try {
      const repository = new SqliteReconciliationCandidateRepository(database);
      const [candidate] = await generateReconciliationCandidates({
        adapter: readOnlyAdapter([target], []),
        candidateRepository: repository,
        createId: () => 'candidate-one',
        createdAt,
        snapshot: snapshotOf([target]),
        sourceIdentityRepository,
      });
      if (candidate === undefined) {
        throw new Error('Synthetic candidate is missing.');
      }
      candidateId = candidate.id;
      expect(
        repository.recordRevalidatedDecision(
          candidate.id,
          'approved',
          'reviewed manually',
          '2026-07-31T13:00:00.000Z',
        ).status,
      ).toBe('approved');
      expect(repository.markStale(candidate.id).status).toBe('stale');
      const rejected = repository.save({
        ...candidate,
        actualTransactionId: 'actual-rejected',
        id: 'candidate-rejected',
      });
      expect(
        repository.recordRevalidatedDecision(
          rejected.id,
          'rejected',
          null,
          '2026-07-31T14:00:00.000Z',
        ).status,
      ).toBe('rejected');
      expect(() =>
        repository.save({
          ...candidate,
          actualTransactionId: 'actual-conflict',
        }),
      ).toThrow('Reconciliation candidate ID conflicts with stored data.');
    } finally {
      database.close();
    }

    const restartedDatabase = openCompanionDatabase(databasePath, true);
    try {
      const repository = new SqliteReconciliationCandidateRepository(
        restartedDatabase,
      );
      expect(repository.list()[0]).toMatchObject({
        id: candidateId,
        status: 'stale',
      });
      restartedDatabase
        .prepare(
          'UPDATE reconciliation_candidates SET reason_codes_json = \'["unsafe"]\' WHERE id = ?',
        )
        .run(candidateId);
      expect(() => repository.list()).toThrow(
        'Stored reconciliation candidate reasons are invalid.',
      );
    } finally {
      restartedDatabase.close();
    }
  });
});

function recordSourceObservation(
  externalTransactionId: string,
  transactionDate: string,
): string {
  const importBatchId = randomUUID();
  const database = openCompanionDatabase(databasePath, true);
  try {
    database
      .prepare(
        'INSERT INTO import_batches (id, source_namespace_id, actual_account_id, source_kind, content_sha256, parser_name, parser_version, source_display_name, started_at, completed_at, status, row_count, accepted_count, rejected_count, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        importBatchId,
        sourceNamespaceId,
        accountId,
        'statement',
        randomBytes(32).toString('hex'),
        'synthetic',
        1,
        'synthetic.csv',
        createdAt,
        createdAt,
        'applied',
        1,
        1,
        0,
        null,
      );
  } finally {
    database.close();
  }
  const result = sourceIdentityRepository.recordObservation({
    actualAccountId: accountId,
    amount: -1250,
    bookingStatus: 'pending',
    currencyCode: 'USD',
    externalTransactionId,
    fingerprint: 'f'.repeat(63) + String(nextSourceRowIndex % 10),
    fingerprintVersion: 1,
    id: randomUUID(),
    importBatchId,
    importedPayee: 'Coffee Shop',
    normalizedPayeeKey: 'coffee shop',
    observedAt: createdAt,
    postedDate: null,
    sourceNamespaceId,
    sourcePayloadHash: 'a'.repeat(64),
    sourceRowIndex: nextSourceRowIndex++,
    transactionDate,
  });
  return result.sourceTransactionId;
}

function transaction(
  overrides: Partial<ActualTransactionV1> = {},
): ActualTransactionV1 {
  return {
    accountId,
    amountMinorUnits: -1250,
    categoryId: null,
    cleared: false,
    date: '2026-07-30',
    id: 'actual-default',
    importedId: 'different-actual-id',
    importedPayee: 'Coffee Shop',
    isChild: false,
    isParent: false,
    isStartingBalance: false,
    notes: null,
    parentId: null,
    payeeId: null,
    reconciled: false,
    tombstone: false,
    transferId: null,
    ...overrides,
  };
}

function snapshotOf(
  transactions: readonly ActualTransactionV1[],
): ActualBudgetSnapshotV1 {
  return {
    budget: {
      budgetKeyHash: 'a'.repeat(64),
      capturedAt: createdAt,
      currencyCode: 'USD',
    },
    contractVersion: 1,
    transactions,
  };
}

function readOnlyAdapter(
  transactions: readonly ActualTransactionV1[],
  requests: string[],
): ActualAdapter {
  return dynamicReadOnlyAdapter(() => transactions, requests);
}

function dynamicReadOnlyAdapter(
  readTransactions: () => readonly ActualTransactionV1[],
  requests: string[],
): ActualAdapter {
  return {
    async execute(request) {
      requests.push(request.kind);
      if (request.kind !== 'read-actual-target') {
        throw new Error('FIN-20 must not make a mutating Actual request.');
      }
      const parent = readTransactions().find(
        transaction => transaction.id === request.target.id,
      );
      if (parent === undefined) {
        return { kind: 'read-actual-target', target: null };
      }
      const graph: Omit<ActualTransactionGraphV1, 'targetVersionHash'> = {
        children: [],
        contractVersion: 1,
        parent,
      };
      return {
        kind: 'read-actual-target',
        target: { ...graph, targetVersionHash: targetVersionHash(graph) },
      };
    },
    getActiveOperationStatus: () => null,
    getHealth: () => 'healthy',
  };
}

function sequentialIds(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
