import { describe, expect, it } from 'vitest';

import {
  detectRecurringPayments,
  validateRecurringPaymentCandidateForApply,
} from './recurring-detector';
import type {
  RecurringPaymentSchedule,
  RecurringPaymentTransaction,
} from './recurring-detector';

describe('detectRecurringPayments', () => {
  it.each([
    ['weekly', ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22']],
    ['monthly', ['2026-01-05', '2026-02-05', '2026-03-05']],
    ['quarterly', ['2026-01-05', '2026-04-05', '2026-07-05']],
    ['annual', ['2025-01-05', '2026-01-05']],
  ] as const)('detects %s cadence', (cadence, dates) => {
    expect(detectRecurringPayments(transactions(dates))[0]).toMatchObject({
      cadence,
      occurrenceCount: dates.length,
    });
  });

  it('classifies optional subscriptions, household bills, and financial bills', () => {
    const candidates = detectRecurringPayments([
      ...transactions(monthlyDates, {
        payeeId: 'streaming',
        payeeName: 'Streaming Service',
      }),
      ...transactions(monthlyDates, {
        payeeId: 'utility',
        payeeName: 'City Electric',
      }),
      ...transactions(monthlyDates, {
        payeeId: 'loan',
        payeeName: 'Bank Loan',
      }),
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payeeName: 'Streaming Service',
          type: 'optional-subscription',
        }),
        expect.objectContaining({
          payeeName: 'City Electric',
          type: 'household-bill',
        }),
        expect.objectContaining({
          payeeName: 'Bank Loan',
          type: 'financial-bill',
        }),
      ]),
    );
  });

  it('records one missed occurrence, date variance, and a recent price change', () => {
    const [candidate] = detectRecurringPayments(
      transactions(['2026-01-05', '2026-02-07', '2026-04-05'], {
        amounts: [-1_000, -1_000, -1_200],
      }),
    );

    expect(candidate).toMatchObject({
      cadence: 'monthly',
      recentPriceChangeBasisPoints: 2_000,
    });
    expect(candidate.dateVarianceDays).toBeGreaterThan(0);
    expect(candidate.reasons).toEqual(
      expect.arrayContaining([
        'billing-date-variance',
        'price-change',
        'gap-detected',
      ]),
    );
  });

  it('emits one ambiguous candidate when qualifying cadence runs overlap', () => {
    const [candidate] = detectRecurringPayments(
      transactions([
        '2026-01-01',
        '2026-01-08',
        '2026-01-15',
        '2026-01-22',
        '2026-02-22',
        '2026-03-22',
      ]),
    );

    expect(candidate).toMatchObject({
      cadence: 'ambiguous',
      occurrenceCount: 6,
    });
    expect(candidate.reasons).toContain('cadence-ambiguous');
  });

  it('uses active schedules as evidence and ignores completed schedules', () => {
    const [candidate] = detectRecurringPayments(transactions(monthlyDates), [
      schedule('active'),
      schedule('completed', { isCompleted: true }),
    ]);

    expect(candidate.matchingScheduleIds).toEqual(['active']);
    expect(candidate.relatedScheduleIds).toEqual(['active']);
    expect(candidate.reasons).toContain('existing-schedule');
  });

  it('excludes ineligible rows without excluding cleared but unreconciled history', () => {
    const eligible = transactions(monthlyDates);
    const ineligibleFlags = [
      'isTransfer',
      'isSplitParent',
      'isStartingBalance',
      'isTombstone',
    ] as const;
    const ineligible = ineligibleFlags.flatMap((flag, flagIndex) =>
      transactions(monthlyDates, {
        payeeId: `ineligible-${flagIndex}`,
        payeeName: `Ineligible ${flagIndex}`,
      }).map(transaction => ({ ...transaction, [flag]: true })),
    );

    expect(detectRecurringPayments([...eligible, ...ineligible])).toHaveLength(
      1,
    );
  });

  it('rejects runs with excessive amount variance', () => {
    expect(
      detectRecurringPayments(
        transactions(monthlyDates, { amounts: [-1_000, -2_000, -4_000] }),
      ),
    ).toEqual([]);
  });
});

describe('validateRecurringPaymentCandidateForApply', () => {
  it('accepts unchanged eligible evidence', () => {
    const candidates = detectRecurringPayments(transactions(monthlyDates));
    const candidate = candidates[0];

    expect(
      validateRecurringPaymentCandidateForApply(
        candidate.candidateKey,
        candidate.evidenceFingerprint,
        candidates,
      ),
    ).toMatchObject({ status: 'ready' });
  });

  it('blocks stale, reconciled, ambiguous-cadence, and multiple-schedule evidence', () => {
    const [current] = detectRecurringPayments(transactions(monthlyDates));
    expect(
      validateRecurringPaymentCandidateForApply(
        current.candidateKey,
        `${current.evidenceFingerprint}-changed`,
        [current],
      ),
    ).toEqual({ status: 'stale' });

    const [reconciled] = detectRecurringPayments(
      transactions(monthlyDates).map(transaction => ({
        ...transaction,
        isReconciled: true,
      })),
    );
    expect(
      validateRecurringPaymentCandidateForApply(
        reconciled.candidateKey,
        reconciled.evidenceFingerprint,
        [reconciled],
      ),
    ).toEqual({ status: 'blocked-reconciled' });

    const [ambiguous] = detectRecurringPayments(
      transactions([
        '2026-01-01',
        '2026-01-08',
        '2026-01-15',
        '2026-01-22',
        '2026-02-22',
        '2026-03-22',
      ]),
    );
    expect(
      validateRecurringPaymentCandidateForApply(
        ambiguous.candidateKey,
        ambiguous.evidenceFingerprint,
        [ambiguous],
      ),
    ).toEqual({ status: 'blocked-ambiguous-cadence' });

    const [multipleSchedules] = detectRecurringPayments(
      transactions(monthlyDates),
      [schedule('first'), schedule('second')],
    );
    expect(
      validateRecurringPaymentCandidateForApply(
        multipleSchedules.candidateKey,
        multipleSchedules.evidenceFingerprint,
        [multipleSchedules],
      ),
    ).toEqual({ status: 'blocked-ambiguous-schedules' });
  });
});

const monthlyDates = ['2026-01-05', '2026-02-05', '2026-03-05'] as const;

function transactions(
  dates: readonly string[],
  options: {
    amounts?: readonly number[];
    payeeId?: string;
    payeeName?: string;
  } = {},
): RecurringPaymentTransaction[] {
  const payeeId = options.payeeId ?? 'payee';
  return dates.map((date, index) => ({
    accountId: 'account',
    amount: options.amounts?.[index] ?? -1_000,
    date,
    id: `${payeeId}-${index}`,
    isReconciled: false,
    isSplitParent: false,
    isStartingBalance: false,
    isTombstone: false,
    isTransfer: false,
    payeeId,
    payeeName: options.payeeName ?? 'Synthetic Merchant',
  }));
}

function schedule(
  id: string,
  options: { isCompleted?: boolean } = {},
): RecurringPaymentSchedule {
  return {
    accountId: 'account',
    amount: -1_000,
    amountOperator: 'isapprox',
    id,
    isCompleted: options.isCompleted ?? false,
    payeeId: 'payee',
    recurrence: {
      frequency: 'monthly',
      interval: 1,
      start: '2026-01-05',
    },
  };
}
