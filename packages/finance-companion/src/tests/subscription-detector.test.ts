import type { ActualTransactionV1 } from '#contracts/adapter';
import {
  detectSubscriptionCandidates,
  subscriptionDetectorVersion,
} from '#subscriptions/subscription-detector';
import type {
  SubscriptionCandidateV1,
  SubscriptionHistoryTransactionV1,
  SubscriptionScheduleSnapshotV1,
} from '#subscriptions/subscription-detector';
import {
  scanActualSubscriptionCandidates,
  scanSubscriptionCandidates,
} from '#subscriptions/subscription-scan-service';
import type { SubscriptionCandidateRepository } from '#subscriptions/subscription-scan-service';

const fixedClock = {
  now: () => new Date('2026-07-31T12:00:00.000Z'),
};

describe('subscription detector', () => {
  it.each([
    {
      cadence: 'monthly',
      dates: ['2026-01-15', '2026-02-15', '2026-03-15'],
      expectedConfidence: 80,
      name: 'stable monthly',
    },
    {
      cadence: 'weekly',
      dates: ['2026-01-03', '2026-01-10', '2026-01-17', '2026-01-24'],
      expectedConfidence: 80,
      name: 'weekly',
    },
    {
      cadence: 'quarterly',
      dates: ['2025-10-15', '2026-01-15', '2026-04-15'],
      expectedConfidence: 80,
      name: 'quarterly',
    },
    {
      cadence: 'annual',
      dates: ['2025-02-01', '2026-02-01'],
      expectedConfidence: 80,
      name: 'annual',
    },
  ] as const)(
    'detects $name cadence with deterministic evidence',
    ({ cadence, dates, expectedConfidence }) => {
      const candidates = detectSubscriptionCandidates(
        { schedules: [], transactions: transactions(dates) },
        fixedClock,
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        amountVarianceBasisPoints: 0,
        cadence,
        candidateType: 'unknown',
        confidence: expectedConfidence,
        dateVarianceDays: 0,
        detectorVersion: subscriptionDetectorVersion,
        evaluatedAt: '2026-07-31T12:00:00.000Z',
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        medianAmount: 1_000,
        occurrenceCount: dates.length,
        status: 'pending',
      });
      expect(candidates[0].reasonCodes).toEqual([
        `cadence-${cadence}`,
        'minimum-occurrences',
        'stable-amount',
      ]);
    },
  );

  it('keeps variable monthly bills as unknown user choices', () => {
    const [candidate] = detectSubscriptionCandidates(
      {
        schedules: [],
        transactions: transactions(
          ['2026-01-15', '2026-02-17', '2026-03-14'],
          [-800, -1_000, -900],
        ),
      },
      fixedClock,
    );
    expect(candidate).toMatchObject({
      amountVarianceBasisPoints: 1_111,
      cadence: 'monthly',
      candidateType: 'unknown',
      confidence: 50,
      dateVarianceDays: 3,
      medianAmount: 900,
      recentPriceChangeBasisPoints: null,
    });
    expect(candidate.reasonCodes).toEqual([
      'cadence-monthly',
      'minimum-occurrences',
      'billing-date-variance',
      'amount-variance',
    ]);
  });

  it('rejects irregular merchant purchases', () => {
    expect(
      detectSubscriptionCandidates(
        {
          schedules: [],
          transactions: transactions([
            '2026-01-01',
            '2026-01-20',
            '2026-03-07',
            '2026-05-13',
          ]),
        },
        fixedClock,
      ),
    ).toEqual([]);
  });

  it('preserves a recent price increase as explainable evidence', () => {
    const [candidate] = detectSubscriptionCandidates(
      {
        schedules: [],
        transactions: transactions(
          ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
          [-1_000, -1_000, -1_000, -1_200],
        ),
      },
      fixedClock,
    );
    expect(candidate).toMatchObject({
      amountVarianceBasisPoints: 2_000,
      cadence: 'monthly',
      confidence: 50,
      medianAmount: 1_000,
      recentPriceChangeBasisPoints: 2_000,
    });
    expect(candidate.reasonCodes).toEqual([
      'cadence-monthly',
      'minimum-occurrences',
      'amount-variance',
      'price-change',
    ]);
  });

  it('allows one paused occurrence and reports the gap', () => {
    const [candidate] = detectSubscriptionCandidates(
      {
        schedules: [],
        transactions: transactions([
          '2026-01-15',
          '2026-02-15',
          '2026-04-15',
          '2026-05-15',
        ]),
      },
      fixedClock,
    );
    expect(candidate).toMatchObject({
      cadence: 'monthly',
      confidence: 80,
      occurrenceCount: 4,
    });
    expect(candidate.reasonCodes).toContain('gap-detected');
  });

  it('emits two signatures for non-overlapping cadences at one payee', () => {
    const dates = [
      '2026-01-01',
      '2026-01-08',
      '2026-01-15',
      '2026-01-22',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
    ];
    const candidates = detectSubscriptionCandidates(
      { schedules: [], transactions: transactions(dates) },
      fixedClock,
    );
    expect(candidates.map(candidate => candidate.cadence).sort()).toEqual([
      'monthly',
      'weekly',
    ]);
    expect(new Set(candidates.map(candidate => candidate.signature)).size).toBe(
      2,
    );
  });

  it('emits one ambiguous candidate when qualifying cadences share an occurrence', () => {
    const [candidate] = detectSubscriptionCandidates(
      {
        schedules: [],
        transactions: transactions([
          '2026-01-01',
          '2026-01-08',
          '2026-01-15',
          '2026-01-22',
          '2026-02-22',
          '2026-03-22',
        ]),
      },
      fixedClock,
    );
    expect(candidate).toMatchObject({
      cadence: 'unknown',
      candidateType: 'unknown',
      occurrenceCount: 6,
    });
    expect(candidate.reasonCodes[0]).toBe('cadence-ambiguous');
  });

  it('matches exactly one active Actual schedule without writing it', () => {
    const schedule = monthlySchedule('schedule-1');
    const [candidate] = detectSubscriptionCandidates(
      {
        schedules: [schedule],
        transactions: transactions(['2026-01-15', '2026-02-15', '2026-03-15']),
      },
      fixedClock,
    );
    expect(candidate).toMatchObject({
      actualScheduleId: 'schedule-1',
      confidence: 85,
    });
    expect(candidate.reasonCodes).toContain('existing-schedule');
    expect(schedule).toEqual(monthlySchedule('schedule-1'));
  });

  it('marks reconciled-derived candidates as read-only evidence', () => {
    const history = transactions([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
    ]).map((transaction, index) => ({
      ...transaction,
      isReconciled: index === 0,
    }));
    const [candidate] = detectSubscriptionCandidates(
      { schedules: [], transactions: history },
      fixedClock,
    );
    expect(candidate.candidateType).toBe('unknown');
    expect(candidate.reasonCodes).toContain('reconciled-history');
  });

  it('does not mutate transaction or schedule inputs', () => {
    const input = {
      schedules: [monthlySchedule('schedule-1')],
      transactions: transactions(['2026-03-15', '2026-01-15', '2026-02-15']),
    };
    const original = structuredClone(input);
    detectSubscriptionCandidates(input, fixedClock);
    expect(input).toEqual(original);
  });
});

describe('subscription scan state', () => {
  it('maps the closed Actual snapshot and persists only after the read', async () => {
    const schedule = monthlySchedule('schedule-1');
    const actualTransactions = transactions([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
    ]).map(projectActualTransaction);
    const snapshot = {
      budget: {
        budgetKeyHash: 'b'.repeat(64),
        capturedAt: '2026-07-31T12:00:00.000Z',
        currencyCode: 'USD',
      },
      contractVersion: 1 as const,
      schedules: [schedule],
      transactions: actualTransactions,
    };
    const originalSnapshot = structuredClone(snapshot);
    const persistedScans: (readonly SubscriptionCandidateV1[])[] = [];
    const results = await scanActualSubscriptionCandidates({
      adapter: {
        execute: async request => {
          expect(request).toMatchObject({
            kind: 'read-budget-snapshot',
            sections: ['schedules'],
          });
          return { kind: 'read-budget-snapshot', snapshot };
        },
      },
      clock: fixedClock,
      historyRanges: [
        {
          endDateExclusive: '2026-04-01',
          startDate: '2026-01-01',
        },
      ],
      repository: {
        persistCandidates: candidates => {
          persistedScans.push(candidates);
        },
        readCandidates: () => [],
      },
    });
    expect(results[0]).toMatchObject({
      actualScheduleId: 'schedule-1',
      cadence: 'monthly',
      status: 'pending',
    });
    expect(persistedScans).toEqual([results]);
    expect(snapshot).toEqual(originalSnapshot);
  });

  it('does not touch candidate persistence when the schedule read fails', async () => {
    let readCount = 0;
    let persistCount = 0;
    const repository: SubscriptionCandidateRepository = {
      persistCandidates: () => {
        persistCount += 1;
      },
      readCandidates: () => {
        readCount += 1;
        return [];
      },
    };
    await expect(
      scanActualSubscriptionCandidates({
        adapter: {
          execute: async request => {
            expect(request).toMatchObject({
              kind: 'read-budget-snapshot',
              sections: ['schedules'],
            });
            throw new Error('synthetic schedule read failure');
          },
        },
        clock: fixedClock,
        historyRanges: [
          {
            endDateExclusive: '2026-04-01',
            startDate: '2026-01-01',
          },
        ],
        repository,
      }),
    ).rejects.toThrow('synthetic schedule read failure');
    expect({ persistCount, readCount }).toEqual({
      persistCount: 0,
      readCount: 0,
    });
  });

  it('leaves a rejected signature suppressed and unchanged', async () => {
    const input = {
      schedules: [],
      transactions: transactions(['2026-01-15', '2026-02-15', '2026-03-15']),
    };
    const [detected] = detectSubscriptionCandidates(input, fixedClock);
    const rejected = {
      ...detected,
      evaluatedAt: '2026-04-01T00:00:00.000Z',
      status: 'rejected',
    } satisfies SubscriptionCandidateV1;
    const results = await scanSubscriptionCandidates({
      ...input,
      clock: fixedClock,
      repository: inMemoryRepository([rejected]),
    });
    expect(results).toEqual([rejected]);
  });

  it('preserves an approved link and marks it stale when its schedule disappears', async () => {
    const input = {
      schedules: [monthlySchedule('schedule-1')],
      transactions: transactions(['2026-01-15', '2026-02-15', '2026-03-15']),
    };
    const [detected] = detectSubscriptionCandidates(input, fixedClock);
    const approved = {
      ...detected,
      candidateType: 'subscription',
      status: 'approved',
    } satisfies SubscriptionCandidateV1;
    const [result] = await scanSubscriptionCandidates({
      clock: fixedClock,
      repository: inMemoryRepository([approved]),
      schedules: [],
      transactions: input.transactions,
    });
    expect(result).toMatchObject({
      actualScheduleId: 'schedule-1',
      candidateType: 'subscription',
      status: 'stale',
    });
  });
});

function transactions(
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

function monthlySchedule(id: string): SubscriptionScheduleSnapshotV1 {
  return {
    accountId: 'account-1',
    amount: 1_000,
    amountOperator: 'is',
    id,
    isCompleted: false,
    payeeId: 'payee-1',
    recurrence: {
      frequency: 'monthly',
      interval: 1,
      kind: 'recurring',
      start: '2026-01-15',
    },
  };
}

function projectActualTransaction(
  transaction: SubscriptionHistoryTransactionV1,
): ActualTransactionV1 {
  return {
    accountId: transaction.accountId,
    amountMinorUnits: transaction.amount,
    categoryId: null,
    cleared: false,
    date: transaction.date,
    id: transaction.id,
    importedId: null,
    importedPayee: null,
    isChild: false,
    isParent: transaction.isSplitParent,
    isStartingBalance: transaction.isStartingBalance,
    notes: null,
    parentId: null,
    payeeId: transaction.payeeId,
    reconciled: transaction.isReconciled,
    tombstone: transaction.isTombstone,
    transferId: transaction.isTransfer ? 'transfer-1' : null,
  };
}

function inMemoryRepository(
  candidates: readonly SubscriptionCandidateV1[],
): SubscriptionCandidateRepository {
  return {
    persistCandidates: () => undefined,
    readCandidates: async detectorVersion =>
      candidates.filter(
        candidate => candidate.detectorVersion === detectorVersion,
      ),
  };
}
