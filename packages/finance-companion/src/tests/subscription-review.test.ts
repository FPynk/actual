import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualAdapterRequest,
  ActualTransactionV1,
  SubscriptionScheduleSnapshotV1,
} from '#contracts/adapter';
import { SqliteSubscriptionCandidateRepository } from '#subscriptions/sqlite-subscription-candidate-repository';
import type { SubscriptionHistoryTransactionV1 } from '#subscriptions/subscription-detector';
import {
  createSubscriptionReviewRef,
  decideSubscriptionReview,
  readSubscriptionReviewDetail,
  readSubscriptionReviewList,
} from '#subscriptions/subscription-review-service';
import { scanSubscriptionCandidates } from '#subscriptions/subscription-scan-service';

const budgetKeyHash = 'a'.repeat(64);
const decidedAt = '2026-04-30T12:00:00.000Z';
const schedule = monthlySchedule();

describe('subscription review service', () => {
  let database: Database.Database;
  let repository: SqliteSubscriptionCandidateRepository;

  beforeEach(async () => {
    database = new Database(':memory:');
    database.exec(
      await readFile(
        path.resolve(
          import.meta.dirname,
          '../../migrations/004-review-candidates.sql',
        ),
        'utf8',
      ),
    );
    repository = new SqliteSubscriptionCandidateRepository(database);
  });

  afterEach(() => database.close());

  it('records every decision and undo durably without changing Actual', async () => {
    const history = monthlyHistory();
    await seedCandidate(repository, history, [schedule]);
    const actual = readOnlyActual(history, [schedule], {
      accountName: `${'A'.repeat(170)}\u0007`,
      payeeName: '</script><img src=x onerror=alert(1)>\u0000',
    });
    const dependencies = reviewDependencies(actual.adapter, repository);
    const actualBefore = JSON.stringify({
      schedules: actual.schedules,
      transactions: actual.transactions,
    });

    const list = await readSubscriptionReviewList(dependencies);
    expect(list.reviews).toHaveLength(1);
    expect(list.reviews[0]?.reviewRef).toMatch(
      /^subscription_[A-Za-z0-9_-]{43}$/,
    );
    const serializedList = JSON.stringify(list);
    expect(serializedList).not.toContain('account-private');
    expect(serializedList).not.toContain('payee-private');
    expect(serializedList).not.toContain(schedule.id);
    expect(serializedList).not.toContain(budgetKeyHash);

    const reviewRef = list.reviews[0]?.reviewRef;
    if (reviewRef === undefined) {
      throw new Error('Review reference is missing.');
    }
    const initialDetail = await readSubscriptionReviewDetail(
      reviewRef,
      dependencies,
    );
    expect(initialDetail).toMatchObject({
      allowedActions: ['approve', 'defer', 'reject'],
      evidence: {
        scheduleAssociation: 'existing',
      },
      selectedType: null,
      status: 'pending',
    });
    expect(initialDetail?.evidence.account).toHaveLength(160);
    expect(initialDetail?.evidence.payee).not.toContain('\u0000');
    expect(JSON.stringify(initialDetail)).not.toContain('private note');

    const approved = await decideSubscriptionReview(
      {
        action: {
          kind: 'approve',
          userSelectedType: 'household_bill',
        },
        decidedAt,
        reviewRef,
      },
      dependencies,
    );
    expect(approved).toMatchObject({
      selectedType: 'household_bill',
      status: 'approved',
    });
    expect(approved?.guidance).toContain('guidance only');
    expect(
      new SqliteSubscriptionCandidateRepository(
        database,
      ).listSubscriptionReviewRecords()[0],
    ).toMatchObject({
      candidate: {
        candidateType: 'household_bill',
        status: 'approved',
      },
      decidedAt,
    });

    const reopenedApproval = await decideSubscriptionReview(
      { action: { kind: 'reopen' }, decidedAt, reviewRef },
      dependencies,
    );
    expect(reopenedApproval).toMatchObject({
      selectedType: null,
      status: 'pending',
    });
    expect(repository.listSubscriptionReviewRecords()[0]).toMatchObject({
      candidate: { candidateType: 'unknown', status: 'pending' },
      decidedAt: null,
    });

    const deferred = await decideSubscriptionReview(
      { action: { kind: 'defer' }, decidedAt, reviewRef },
      dependencies,
    );
    expect(deferred?.status).toBe('deferred');
    expect(
      (
        await decideSubscriptionReview(
          { action: { kind: 'reopen' }, decidedAt, reviewRef },
          dependencies,
        )
      )?.status,
    ).toBe('pending');

    const rejected = await decideSubscriptionReview(
      {
        action: { kind: 'reject', reasonCode: 'not-recurring' },
        decidedAt,
        reviewRef,
      },
      dependencies,
    );
    expect(rejected?.status).toBe('rejected');
    expect(
      (
        await decideSubscriptionReview(
          { action: { kind: 'reopen' }, decidedAt, reviewRef },
          dependencies,
        )
      )?.status,
    ).toBe('pending');

    const explicitlyUnclassified = await decideSubscriptionReview(
      {
        action: { kind: 'approve', userSelectedType: 'unknown' },
        decidedAt,
        reviewRef,
      },
      dependencies,
    );
    expect(explicitlyUnclassified).toMatchObject({
      selectedType: 'unknown',
      status: 'approved',
    });

    expect(actual.mutationCount()).toBe(0);
    expect(
      JSON.stringify({
        schedules: actual.schedules,
        transactions: actual.transactions,
      }),
    ).toBe(actualBefore);
    expect(
      actual.requests.every(request => request.kind === 'read-budget-snapshot'),
    ).toBe(true);
  });

  it('marks missing history and a deleted approved schedule stale, then surfaces current evidence', async () => {
    const initialHistory = monthlyHistory();
    await seedCandidate(repository, initialHistory, [schedule]);
    const actual = readOnlyActual(initialHistory.slice(0, 2), [schedule]);
    const dependencies = reviewDependencies(actual.adapter, repository);
    const reviewRef = createSubscriptionReviewRef(
      repository.listSubscriptionReviewRecords()[0]!,
      budgetKeyHash,
    );

    expect(
      (await readSubscriptionReviewDetail(reviewRef, dependencies))?.status,
    ).toBe('stale');

    actual.replaceTransactions(
      actualTransactions(
        monthlyHistory(
          ['2026-01-15', '2026-02-15', '2026-04-15'],
          [-1_000, -1_000, -1_200],
          2,
        ),
      ),
    );
    const current = await readSubscriptionReviewDetail(reviewRef, dependencies);
    expect(current).toMatchObject({
      evidence: {
        hasReconciledHistory: true,
        recentPriceChangeBasisPoints: 2_000,
        scheduleAssociation: 'existing',
      },
      status: 'pending',
    });
    expect(current?.reasons).toEqual(
      expect.arrayContaining([
        'The most recent payment has a material price change',
        'One expected payment appears to be missing',
        'The evidence includes a reconciled transaction',
      ]),
    );

    await decideSubscriptionReview(
      {
        action: { kind: 'approve', userSelectedType: 'subscription' },
        decidedAt,
        reviewRef,
      },
      dependencies,
    );
    actual.replaceSchedules([]);
    const staleSchedule = await readSubscriptionReviewDetail(
      reviewRef,
      dependencies,
    );
    expect(staleSchedule).toMatchObject({
      evidence: { scheduleAssociation: 'stale' },
      status: 'stale',
    });
    expect(actual.mutationCount()).toBe(0);
  });

  it('partitions annual history into closed 90-day reads and refreshes schedules last', async () => {
    const annualHistory = monthlyHistory(['2025-01-15', '2026-01-15']);
    const annualSchedule: SubscriptionScheduleSnapshotV1 = {
      ...schedule,
      recurrence: {
        kind: 'recurring',
        frequency: 'yearly',
        interval: 1,
        start: '2025-01-15',
      },
    };
    await seedCandidate(repository, annualHistory, [annualSchedule]);
    const actual = readOnlyActual(annualHistory, [annualSchedule]);

    const list = await readSubscriptionReviewList({
      ...reviewDependencies(actual.adapter, repository),
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });

    expect(list.reviews[0]).toMatchObject({
      cadence: 'Annual',
      status: 'pending',
    });
    const ranges = actual.requests.flatMap(request =>
      request.kind === 'read-budget-snapshot' &&
      request.transactionRange !== undefined
        ? [request.transactionRange]
        : [],
    );
    expect(ranges.length).toBeGreaterThan(1);
    expect(
      ranges.every(range => {
        const days =
          (Date.parse(`${range.endDateExclusive}T00:00:00.000Z`) -
            Date.parse(`${range.startDate}T00:00:00.000Z`)) /
          86_400_000;
        return days >= 1 && days <= 90;
      }),
    ).toBe(true);
    expect(
      ranges.every(
        (range, index) =>
          index === 0 ||
          ranges[index - 1]?.endDateExclusive === range.startDate,
      ),
    ).toBe(true);
    expect(
      ranges.every(range => range.accountIds?.[0] === 'account-private'),
    ).toBe(true);
    expect(actual.requests.at(-1)).toMatchObject({
      kind: 'read-budget-snapshot',
      sections: ['schedules'],
    });
  });
});

function reviewDependencies(
  adapter: ActualAdapter,
  candidateRepository: SqliteSubscriptionCandidateRepository,
) {
  return {
    adapter,
    budgetKeyHash,
    currencyCode: 'USD',
    now: () => new Date(decidedAt),
    repository: candidateRepository,
  };
}

async function seedCandidate(
  candidateRepository: SqliteSubscriptionCandidateRepository,
  history: readonly SubscriptionHistoryTransactionV1[],
  schedules: readonly SubscriptionScheduleSnapshotV1[],
): Promise<void> {
  await scanSubscriptionCandidates({
    clock: { now: () => new Date(decidedAt) },
    repository: candidateRepository,
    schedules,
    transactions: history,
  });
}

function readOnlyActual(
  history: readonly SubscriptionHistoryTransactionV1[],
  initialSchedules: readonly SubscriptionScheduleSnapshotV1[],
  names: Readonly<{ accountName?: string; payeeName?: string }> = {},
) {
  const requests: ActualAdapterRequest[] = [];
  let mutationCount = 0;
  let transactions = actualTransactions(history);
  let schedules = [...initialSchedules];
  const adapter: ActualAdapter = {
    execute: async request => {
      requests.push(request);
      if (request.kind !== 'read-budget-snapshot') {
        mutationCount += 1;
        throw new Error('Subscription review must not mutate Actual.');
      }
      const selectedTransactions =
        request.transactionRange === undefined
          ? undefined
          : transactions.filter(
              transaction =>
                transaction.date >= request.transactionRange!.startDate &&
                transaction.date < request.transactionRange!.endDateExclusive &&
                (request.transactionRange!.accountIds === undefined ||
                  request.transactionRange!.accountIds.includes(
                    transaction.accountId,
                  )),
            );
      return {
        kind: 'read-budget-snapshot',
        snapshot: {
          contractVersion: 1,
          budget: {
            budgetKeyHash,
            capturedAt: decidedAt,
            currencyCode: 'USD',
          },
          ...(request.sections.includes('accounts')
            ? {
                accounts: [
                  {
                    id: 'account-private',
                    name: names.accountName ?? 'Checking',
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
                    name: names.payeeName ?? 'Utility Company',
                    transferAccountId: null,
                  },
                ],
              }
            : {}),
          ...(request.sections.includes('schedules') ? { schedules } : {}),
          ...(selectedTransactions === undefined
            ? {}
            : { transactions: selectedTransactions }),
        },
      };
    },
    getActiveOperationStatus: () => null,
    getHealth: () => 'healthy',
  };
  return {
    adapter,
    mutationCount: () => mutationCount,
    requests,
    get schedules() {
      return schedules;
    },
    get transactions() {
      return transactions;
    },
    replaceSchedules: (value: readonly SubscriptionScheduleSnapshotV1[]) => {
      schedules = [...value];
    },
    replaceTransactions: (value: readonly ActualTransactionV1[]) => {
      transactions = [...value];
    },
  };
}

function monthlyHistory(
  dates: readonly string[] = ['2026-01-15', '2026-02-15', '2026-03-15'],
  amounts: readonly number[] = dates.map(() => -1_000),
  reconciledIndex = -1,
): readonly SubscriptionHistoryTransactionV1[] {
  return dates.map((date, index) => ({
    accountId: 'account-private',
    amount: amounts[index] ?? -1_000,
    date,
    id: `transaction-private-${index}`,
    isReconciled: index === reconciledIndex,
    isSplitParent: false,
    isStartingBalance: false,
    isTombstone: false,
    isTransfer: false,
    payeeId: 'payee-private',
  }));
}

function actualTransactions(
  history: readonly SubscriptionHistoryTransactionV1[],
): readonly ActualTransactionV1[] {
  return history.map(transaction => ({
    id: transaction.id,
    accountId: transaction.accountId,
    parentId: null,
    transferId: transaction.isTransfer ? 'transfer-private' : null,
    date: transaction.date,
    amountMinorUnits: transaction.amount,
    payeeId: transaction.payeeId,
    categoryId: null,
    notes: 'private note',
    importedId: 'private imported id',
    importedPayee: 'private imported payee',
    cleared: true,
    reconciled: transaction.isReconciled,
    isParent: transaction.isSplitParent,
    isChild: false,
    isStartingBalance: transaction.isStartingBalance,
    tombstone: transaction.isTombstone,
  }));
}

function monthlySchedule(): SubscriptionScheduleSnapshotV1 {
  return {
    id: 'schedule-private',
    accountId: 'account-private',
    payeeId: 'payee-private',
    amount: -1_000,
    amountOperator: 'is',
    recurrence: {
      kind: 'recurring',
      frequency: 'monthly',
      interval: 1,
      start: '2026-01-15',
    },
    isCompleted: false,
  };
}
