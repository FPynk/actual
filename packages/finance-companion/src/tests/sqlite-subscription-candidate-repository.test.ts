import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { SqliteSubscriptionCandidateRepository } from '#subscriptions/sqlite-subscription-candidate-repository';
import { subscriptionDetectorVersion } from '#subscriptions/subscription-detector';
import type { SubscriptionHistoryTransactionV1 } from '#subscriptions/subscription-detector';
import { scanSubscriptionCandidates } from '#subscriptions/subscription-scan-service';

describe('SQLite subscription candidate repository', () => {
  let databasePath: string;
  let openDatabases: Database.Database[];
  let temporaryDirectory: string;

  beforeEach(async () => {
    openDatabases = [];
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-subscriptions-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    const database = new Database(databasePath);
    database.exec(
      await readFile(
        path.resolve(
          import.meta.dirname,
          '../../migrations/004-review-candidates.sql',
        ),
        'utf8',
      ),
    );
    database.close();
  });

  afterEach(async () => {
    for (const database of openDatabases) {
      if (database.open) database.close();
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('survives restart with the same durable candidate', async () => {
    const initialDatabase = openDatabase();
    const initialRepository = repository(initialDatabase);
    const firstScan = await scan(initialRepository, initialHistory, firstClock);
    const storedId = readStoredId(initialDatabase);
    initialDatabase.close();

    const restartedDatabase = openDatabase();
    const restartedRepository = repository(restartedDatabase);
    expect(
      restartedRepository.readCandidates(subscriptionDetectorVersion),
    ).toEqual(firstScan);
    expect(readStoredId(restartedDatabase)).toBe(storedId);
  });

  it('refreshes evidence in place and preserves a deferred user choice', async () => {
    const database = openDatabase();
    const candidateRepository = repository(database);
    await scan(candidateRepository, initialHistory, firstClock);
    const storedId = readStoredId(database);
    database
      .prepare(
        "UPDATE subscription_candidates SET status = 'deferred', candidate_type = 'subscription', decided_at = ?",
      )
      .run('2026-04-01T00:00:00.000Z');

    const [refreshed] = await scan(
      candidateRepository,
      history(
        ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
        [-1_000, -1_000, -1_000, -1_200],
      ),
      secondClock,
    );
    expect(refreshed).toMatchObject({
      candidateType: 'subscription',
      evaluatedAt: '2026-08-01T12:00:00.000Z',
      occurrenceCount: 4,
      recentPriceChangeBasisPoints: 2_000,
      status: 'deferred',
    });
    expect(
      database
        .prepare(
          'SELECT COUNT(*) AS count, MIN(id) AS id, MAX(occurrence_count) AS occurrenceCount FROM subscription_candidates',
        )
        .get(),
    ).toEqual({ count: 1, id: storedId, occurrenceCount: 4 });
  });

  it('keeps a rejected signature and all its evidence unchanged', async () => {
    const database = openDatabase();
    const candidateRepository = repository(database);
    const [candidate] = await scan(
      candidateRepository,
      initialHistory,
      firstClock,
    );
    candidateRepository.rejectCandidate(
      candidate.signature,
      candidate.detectorVersion,
      '2026-04-01T00:00:00.000Z',
    );
    const beforeRefresh = database
      .prepare('SELECT * FROM subscription_candidates')
      .get();

    const [suppressed] = await scan(
      candidateRepository,
      history(
        ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
        [-1_000, -1_000, -1_000, -1_200],
      ),
      secondClock,
    );
    expect(suppressed).toMatchObject({
      evaluatedAt: '2026-07-31T12:00:00.000Z',
      occurrenceCount: 3,
      status: 'rejected',
    });
    expect(
      database.prepare('SELECT * FROM subscription_candidates').get(),
    ).toEqual(beforeRefresh);
    database.close();

    const restartedRepository = repository(openDatabase());
    expect(
      restartedRepository.readCandidates(subscriptionDetectorVersion)[0].status,
    ).toBe('rejected');
  });

  it('persists stale state when a qualifying run disappears', async () => {
    const database = openDatabase();
    const candidateRepository = repository(database);
    await scan(candidateRepository, initialHistory, firstClock);
    const [stale] = await scan(candidateRepository, [], secondClock);
    expect(stale).toMatchObject({
      evaluatedAt: '2026-08-01T12:00:00.000Z',
      status: 'stale',
    });
    database.close();

    const restartedRepository = repository(openDatabase());
    expect(
      restartedRepository.readCandidates(subscriptionDetectorVersion)[0],
    ).toMatchObject({
      evaluatedAt: '2026-08-01T12:00:00.000Z',
      status: 'stale',
    });

    const [pending] = await scan(
      restartedRepository,
      initialHistory,
      secondClock,
    );
    expect(pending).toMatchObject({
      evaluatedAt: '2026-08-01T12:00:00.000Z',
      status: 'pending',
    });
  });

  it('atomically persists review decisions and reopen across restart', async () => {
    const database = openDatabase();
    const candidateRepository = repository(database);
    await scan(candidateRepository, initialHistory, firstClock);
    const pending = candidateRepository.listSubscriptionReviewRecords()[0]!;
    const approved = candidateRepository.recordSubscriptionReviewDecision(
      pending,
      { kind: 'approve', userSelectedType: 'financial_bill' },
      '2026-07-31T12:01:00.000Z',
    );
    expect(approved).toMatchObject({
      candidate: {
        candidateType: 'financial_bill',
        status: 'approved',
      },
      decidedAt: '2026-07-31T12:01:00.000Z',
    });
    expect(() =>
      candidateRepository.recordSubscriptionReviewDecision(
        pending,
        { kind: 'defer' },
        '2026-07-31T12:02:00.000Z',
      ),
    ).toThrow('Subscription review state changed.');
    database.close();

    const restartedRepository = repository(openDatabase());
    const restarted = restartedRepository.listSubscriptionReviewRecords()[0]!;
    expect(restarted).toEqual(approved);
    const reopened = restartedRepository.recordSubscriptionReviewDecision(
      restarted,
      { kind: 'reopen' },
      '2026-07-31T12:03:00.000Z',
    );
    expect(reopened).toMatchObject({
      candidate: { candidateType: 'unknown', status: 'pending' },
      decidedAt: null,
    });
  });

  it('rejects a decision replay after a competing scan refreshes pending evidence', async () => {
    const database = openDatabase();
    const candidateRepository = repository(database);
    await scan(candidateRepository, initialHistory, firstClock);
    const stalePending =
      candidateRepository.listSubscriptionReviewRecords()[0]!;

    await scan(
      candidateRepository,
      history(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']),
      secondClock,
    );

    expect(() =>
      candidateRepository.recordSubscriptionReviewDecision(
        stalePending,
        { kind: 'approve', userSelectedType: 'subscription' },
        '2026-08-01T12:01:00.000Z',
      ),
    ).toThrow('Subscription review state changed.');
    const currentPending =
      candidateRepository.listSubscriptionReviewRecords()[0]!;
    expect(currentPending.candidate.occurrenceCount).toBe(4);
    expect(
      candidateRepository.recordSubscriptionReviewDecision(
        currentPending,
        { kind: 'approve', userSelectedType: 'subscription' },
        '2026-08-01T12:01:00.000Z',
      ).candidate.status,
    ).toBe('approved');
  });

  function openDatabase(): Database.Database {
    const database = new Database(databasePath);
    openDatabases.push(database);
    return database;
  }
});

const firstClock = {
  now: () => new Date('2026-07-31T12:00:00.000Z'),
};
const secondClock = {
  now: () => new Date('2026-08-01T12:00:00.000Z'),
};
const initialHistory = history(['2026-01-15', '2026-02-15', '2026-03-15']);

function repository(database: Database.Database) {
  return new SqliteSubscriptionCandidateRepository(database);
}

async function scan(
  candidateRepository: SqliteSubscriptionCandidateRepository,
  transactions: readonly SubscriptionHistoryTransactionV1[],
  clock: Readonly<{ now(): Date }>,
) {
  return scanSubscriptionCandidates({
    clock,
    repository: candidateRepository,
    schedules: [],
    transactions,
  });
}

function history(
  dates: readonly string[],
  amounts: readonly number[] = dates.map(() => -1_000),
): readonly SubscriptionHistoryTransactionV1[] {
  return dates.map((date, index) => ({
    accountId: 'account-1',
    amount: amounts[index],
    date,
    id: `transaction-${String(index).padStart(2, '0')}`,
    isReconciled: false,
    isSplitParent: false,
    isStartingBalance: false,
    isTombstone: false,
    isTransfer: false,
    payeeId: 'payee-1',
  }));
}

function readStoredId(database: Database.Database): string {
  const row = database
    .prepare('SELECT id FROM subscription_candidates')
    .get() as Readonly<{ id: string }>;
  return row.id;
}
