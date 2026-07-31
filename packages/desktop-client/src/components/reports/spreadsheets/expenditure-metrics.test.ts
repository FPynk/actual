import { describe, expect, it } from "vitest";

import {
  calculateExpenditureMetrics,
  type ExpenditureMetricRow,
} from "./expenditure-metrics";

function row(
  date: string,
  amount: number,
  overrides: Partial<ExpenditureMetricRow> = {}
): ExpenditureMetricRow {
  return {
    date,
    amount,
    currency: "USD",
    isParent: false,
    isTransfer: false,
    isOffBudget: false,
    ...overrides,
  };
}

describe("calculateExpenditureMetrics", () => {
  it("calculates the fixed report example after excluding unsupported rows", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2026-01-30",
      endDate: "2026-02-03",
      rows: [
        row("2026-01-30", -1000),
        row("2026-01-31", -500),
        row("2026-02-01", 200),
        row("2026-02-02", -2000, { isTransfer: true }),
        row("2026-02-03", -700, { isOffBudget: true }),
        row("2026-02-03", -1200, { isParent: true }),
        row("2026-02-03", -900),
        row("2026-02-03", -300),
      ],
    });

    expect(result).toEqual({
      state: "ready",
      currency: "USD",
      total: -2500,
      averagePerDay: -500,
      averagePerWeek: -3500,
      medianExpense: -700,
      monthOverMonth: {
        state: "ready",
        current: -1000,
        prior: -1500,
        change: 500,
        percent: 33.33,
      },
      rolling30Days: [
        { date: "2026-01-30", amount: -1000 },
        { date: "2026-01-31", amount: -1500 },
        { date: "2026-02-01", amount: -1300 },
        { date: "2026-02-02", amount: -1300 },
        { date: "2026-02-03", amount: -2500 },
      ],
    });
  });

  it("uses actual inclusive partial ranges and reports unavailable prior months", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2026-02-02",
      endDate: "2026-02-04",
      rows: [row("2026-02-02", -100), row("2026-02-04", -200)],
    });

    expect(result.averagePerDay).toBe(-100);
    expect(result.averagePerWeek).toBe(-700);
    expect(result.monthOverMonth).toEqual({
      state: "unavailable",
      current: null,
      prior: null,
      change: null,
      percent: null,
    });
    expect(result.rolling30Days).toEqual([
      { date: "2026-02-02", amount: -100 },
      { date: "2026-02-03", amount: -100 },
      { date: "2026-02-04", amount: -300 },
    ]);
  });

  it("uses the negative median for odd and even expense counts", () => {
    expect(
      calculateExpenditureMetrics({
        startDate: "2026-01-01",
        endDate: "2026-01-03",
        rows: [
          row("2026-01-01", -300),
          row("2026-01-02", -100),
          row("2026-01-03", -200),
        ],
      }).medianExpense
    ).toBe(-200);
    expect(
      calculateExpenditureMetrics({
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        rows: [row("2026-01-01", -100), row("2026-01-02", -200)],
      }).medianExpense
    ).toBe(-150);
  });

  it("keeps zero-prior month-over-month amounts without a percentage", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2026-01-01",
      endDate: "2026-02-02",
      rows: [row("2026-02-01", -200)],
    });

    expect(result.monthOverMonth).toEqual({
      state: "zero-prior",
      current: -200,
      prior: 0,
      change: -200,
      percent: null,
    });
  });

  it("returns empty metrics with a zero series and no median", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      rows: [row("2026-01-01", -100, { isTransfer: true })],
    });

    expect(result).toMatchObject({
      state: "empty",
      currency: "USD",
      total: 0,
      averagePerDay: 0,
      averagePerWeek: 0,
      medianExpense: null,
    });
    expect(result.rolling30Days).toEqual([
      { date: "2026-01-01", amount: 0 },
      { date: "2026-01-02", amount: 0 },
    ]);
  });

  it("rejects mixed included currencies without producing metrics", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      rows: [
        row("2026-01-01", -100),
        row("2026-01-02", -200, { currency: "EUR" }),
      ],
    });

    expect(result).toEqual({
      state: "multi-currency",
      currency: null,
      total: null,
      averagePerDay: null,
      averagePerWeek: null,
      medianExpense: null,
      monthOverMonth: {
        state: "unavailable",
        current: null,
        prior: null,
        change: null,
        percent: null,
      },
      rolling30Days: [],
    });
  });

  it("handles leap-day boundaries and counts identical expenses independently", () => {
    const result = calculateExpenditureMetrics({
      startDate: "2024-02-28",
      endDate: "2024-03-01",
      rows: [
        row("2024-02-29", -250),
        row("2024-02-29", -250),
        row("2024-03-01", -500, { isTransfer: true }),
      ],
    });

    expect(result).toMatchObject({
      total: -500,
      averagePerDay: -167,
      medianExpense: -250,
    });
    expect(result.rolling30Days).toEqual([
      { date: "2024-02-28", amount: 0 },
      { date: "2024-02-29", amount: -500 },
      { date: "2024-03-01", amount: -500 },
    ]);
  });
});
