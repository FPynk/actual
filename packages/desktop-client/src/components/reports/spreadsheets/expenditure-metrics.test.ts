import { describe, expect, it } from 'vitest';

import { calculateExpenditureMetrics } from './expenditure-metrics';
import type { ExpenditureMetricRow } from './expenditure-metrics';

function row(
  date: string,
  amount: number,
  overrides: Partial<ExpenditureMetricRow> = {},
): ExpenditureMetricRow {
  return {
    date,
    amount,
    currency: 'USD',
    categoryName: null,
    merchantName: null,
    isParent: false,
    isTransfer: false,
    isOffBudget: false,
    ...overrides,
  };
}

describe('calculateExpenditureMetrics', () => {
  it('calculates the fixed report example after excluding unsupported rows', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-01-30',
      endDate: '2026-02-03',
      rows: [
        row('2026-01-30', -1000),
        row('2026-01-31', -500),
        row('2026-02-01', 200),
        row('2026-02-02', -2000, { isTransfer: true }),
        row('2026-02-03', -700, { isOffBudget: true }),
        row('2026-02-03', -1200, { isParent: true }),
        row('2026-02-03', -900),
        row('2026-02-03', -300),
      ],
    });

    expect(result).toEqual({
      state: 'ready',
      currency: 'USD',
      total: -2500,
      averagePerDay: -500,
      averagePerWeek: -3500,
      averagePerMonth: -15218,
      medianExpense: -700,
      categoryBreakdown: [{ name: null, amount: -2500 }],
      merchantBreakdown: [{ name: null, amount: -2500 }],
      monthOverMonth: {
        state: 'ready',
        current: -1000,
        prior: -1500,
        change: 500,
        percent: 33.33,
      },
      rolling30Days: [
        { date: '2026-01-30', amount: -1000 },
        { date: '2026-01-31', amount: -1500 },
        { date: '2026-02-01', amount: -1300 },
        { date: '2026-02-02', amount: -1300 },
        { date: '2026-02-03', amount: -2500 },
      ],
    });
  });

  it('uses actual inclusive partial ranges and reports unavailable prior months', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-02-02',
      endDate: '2026-02-04',
      rows: [row('2026-02-02', -100), row('2026-02-04', -200)],
    });

    expect(result.averagePerDay).toBe(-100);
    expect(result.averagePerWeek).toBe(-700);
    expect(result.averagePerMonth).toBe(-3044);
    expect(result.monthOverMonth).toEqual({
      state: 'unavailable',
      current: null,
      prior: null,
      change: null,
      percent: null,
    });
    expect(result.rolling30Days).toEqual([
      { date: '2026-02-02', amount: -100 },
      { date: '2026-02-03', amount: -100 },
      { date: '2026-02-04', amount: -300 },
    ]);
  });

  it('uses the negative median for odd and even expense counts', () => {
    expect(
      calculateExpenditureMetrics({
        startDate: '2026-01-01',
        endDate: '2026-01-03',
        rows: [
          row('2026-01-01', -300),
          row('2026-01-02', -100),
          row('2026-01-03', -200),
        ],
      }).medianExpense,
    ).toBe(-200);
    expect(
      calculateExpenditureMetrics({
        startDate: '2026-01-01',
        endDate: '2026-01-02',
        rows: [row('2026-01-01', -100), row('2026-01-02', -200)],
      }).medianExpense,
    ).toBe(-150);
  });

  it('keeps zero-prior month-over-month amounts without a percentage', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-01-01',
      endDate: '2026-02-02',
      rows: [row('2026-02-01', -200)],
    });

    expect(result.monthOverMonth).toEqual({
      state: 'zero-prior',
      current: -200,
      prior: 0,
      change: -200,
      percent: null,
    });
  });

  it('returns empty metrics with a zero series and no median', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      rows: [row('2026-01-01', -100, { isTransfer: true })],
    });

    expect(result).toMatchObject({
      state: 'empty',
      currency: 'USD',
      total: 0,
      averagePerDay: 0,
      averagePerWeek: 0,
      averagePerMonth: 0,
      medianExpense: null,
    });
    expect(result.rolling30Days).toEqual([
      { date: '2026-01-01', amount: 0 },
      { date: '2026-01-02', amount: 0 },
    ]);
  });

  it('rejects mixed included currencies without producing metrics', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      rows: [
        row('2026-01-01', -100),
        row('2026-01-02', -200, { currency: 'EUR' }),
      ],
    });

    expect(result).toEqual({
      state: 'multi-currency',
      currency: null,
      total: null,
      averagePerDay: null,
      averagePerWeek: null,
      averagePerMonth: null,
      medianExpense: null,
      categoryBreakdown: [],
      merchantBreakdown: [],
      monthOverMonth: {
        state: 'unavailable',
        current: null,
        prior: null,
        change: null,
        percent: null,
      },
      rolling30Days: [],
    });
  });

  it('groups category and merchant spending while refunds offset their totals', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      rows: [
        row('2026-01-03', -1000, {
          categoryName: 'Groceries',
          merchantName: 'Market',
        }),
        row('2026-01-06', 200, {
          categoryName: 'Groceries',
          merchantName: 'Market',
        }),
        row('2026-01-10', -500, {
          categoryName: 'Dining',
          merchantName: 'Cafe',
        }),
        row('2026-01-12', -600, { isTransfer: true }),
      ],
    });

    expect(result.categoryBreakdown).toEqual([
      { name: 'Groceries', amount: -800 },
      { name: 'Dining', amount: -500 },
    ]);
    expect(result.merchantBreakdown).toEqual([
      { name: 'Market', amount: -800 },
      { name: 'Cafe', amount: -500 },
    ]);
  });

  it('handles leap-day boundaries and counts identical expenses independently', () => {
    const result = calculateExpenditureMetrics({
      startDate: '2024-02-28',
      endDate: '2024-03-01',
      rows: [
        row('2024-02-29', -250),
        row('2024-02-29', -250),
        row('2024-03-01', -500, { isTransfer: true }),
      ],
    });

    expect(result).toMatchObject({
      total: -500,
      averagePerDay: -167,
      medianExpense: -250,
    });
    expect(result.rolling30Days).toEqual([
      { date: '2024-02-28', amount: 0 },
      { date: '2024-02-29', amount: -500 },
      { date: '2024-03-01', amount: -500 },
    ]);
  });
});
