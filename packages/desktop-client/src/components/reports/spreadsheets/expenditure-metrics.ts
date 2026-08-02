import * as d from 'date-fns';

const averageCalendarDaysPerMonth = 365.2425 / 12;

export type ExpenditureMetricRow = {
  date: string;
  amount: number;
  currency: string;
  categoryName: string | null;
  merchantName: string | null;
  isParent: boolean;
  isTransfer: boolean;
  isOffBudget: boolean;
};

export type ExpenditureMetricsInput = {
  startDate: string;
  endDate: string;
  rows: readonly ExpenditureMetricRow[];
};

export type ExpenditureMetrics = {
  state: 'ready' | 'empty' | 'multi-currency';
  currency: string | null;
  total: number | null;
  averagePerDay: number | null;
  averagePerWeek: number | null;
  averagePerMonth: number | null;
  medianExpense: number | null;
  categoryBreakdown: readonly ExpenditureBreakdownEntry[];
  merchantBreakdown: readonly ExpenditureBreakdownEntry[];
  monthOverMonth: {
    state: 'ready' | 'unavailable' | 'zero-prior';
    current: number | null;
    prior: number | null;
    change: number | null;
    percent: number | null;
  };
  rolling30Days: readonly { date: string; amount: number }[];
};

export type ExpenditureBreakdownEntry = Readonly<{
  name: string | null;
  amount: number;
}>;

function parseDate(date: string) {
  const parsedDate = d.parseISO(date);
  if (!d.isValid(parsedDate) || d.format(parsedDate, 'yyyy-MM-dd') !== date) {
    throw new Error(`Invalid expenditure metric date: ${date}`);
  }
  return parsedDate;
}

function createUnavailableMonthOverMonth(): ExpenditureMetrics['monthOverMonth'] {
  return {
    state: 'unavailable',
    current: null,
    prior: null,
    change: null,
    percent: null,
  };
}

function getMonthOverMonth({
  startDate,
  endDate,
  rows,
}: {
  startDate: string;
  endDate: string;
  rows: readonly ExpenditureMetricRow[];
}): ExpenditureMetrics['monthOverMonth'] {
  const end = parseDate(endDate);
  const currentMonthStart = d.startOfMonth(end);
  const priorMonthStart = d.subMonths(currentMonthStart, 1);
  const priorMonthEnd = d.endOfMonth(priorMonthStart);
  const currentStartDate = d.format(
    d.max([parseDate(startDate), currentMonthStart]),
    'yyyy-MM-dd',
  );
  const priorEndDate = d.format(d.min([end, priorMonthEnd]), 'yyyy-MM-dd');

  if (parseDate(startDate) > priorMonthEnd || currentStartDate > endDate) {
    return createUnavailableMonthOverMonth();
  }

  const priorStartDate = d.format(
    d.max([parseDate(startDate), priorMonthStart]),
    'yyyy-MM-dd',
  );

  if (priorStartDate > priorEndDate) {
    return createUnavailableMonthOverMonth();
  }

  const current = rows
    .filter(row => row.date >= currentStartDate && row.date <= endDate)
    .reduce((total, row) => total + row.amount, 0);
  const prior = rows
    .filter(row => row.date >= priorStartDate && row.date <= priorEndDate)
    .reduce((total, row) => total + row.amount, 0);
  const change = current - prior;

  if (prior === 0) {
    return { state: 'zero-prior', current, prior, change, percent: null };
  }

  return {
    state: 'ready',
    current,
    prior,
    change,
    percent: Math.round((change * 10000) / Math.abs(prior)) / 100,
  };
}

function getRolling30Days({
  startDate,
  endDate,
  rows,
}: {
  startDate: string;
  endDate: string;
  rows: readonly ExpenditureMetricRow[];
}) {
  const totalsByDate = new Map<string, number>();
  for (const row of rows) {
    totalsByDate.set(row.date, (totalsByDate.get(row.date) ?? 0) + row.amount);
  }

  const dates = d.eachDayOfInterval({
    start: parseDate(startDate),
    end: parseDate(endDate),
  });

  return dates.map((date, index) => {
    const windowStartIndex = Math.max(0, index - 29);
    const amount = dates
      .slice(windowStartIndex, index + 1)
      .reduce(
        (total, windowDate) =>
          total + (totalsByDate.get(d.format(windowDate, 'yyyy-MM-dd')) ?? 0),
        0,
      );

    return { date: d.format(date, 'yyyy-MM-dd'), amount };
  });
}

function getExpenditureBreakdown(
  rows: readonly ExpenditureMetricRow[],
  nameKey: 'categoryName' | 'merchantName',
): readonly ExpenditureBreakdownEntry[] {
  const totalsByName = new Map<string | null, number>();
  for (const row of rows) {
    const name = row[nameKey];
    totalsByName.set(name, (totalsByName.get(name) ?? 0) + row.amount);
  }

  return [...totalsByName.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((first, second) => first.amount - second.amount);
}

export function calculateExpenditureMetrics({
  startDate,
  endDate,
  rows,
}: ExpenditureMetricsInput): ExpenditureMetrics {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start > end) {
    throw new Error(
      'Expenditure metric start date must not be after end date.',
    );
  }

  const includedRows = rows.filter(
    row => !row.isParent && !row.isTransfer && !row.isOffBudget,
  );
  const currencies = new Set(includedRows.map(row => row.currency));
  const currency = includedRows[0]?.currency ?? rows[0]?.currency ?? null;
  const rolling30Days = getRolling30Days({
    startDate,
    endDate,
    rows: includedRows,
  });

  if (currencies.size > 1) {
    return {
      state: 'multi-currency',
      currency: null,
      total: null,
      averagePerDay: null,
      averagePerWeek: null,
      averagePerMonth: null,
      medianExpense: null,
      categoryBreakdown: [],
      merchantBreakdown: [],
      monthOverMonth: createUnavailableMonthOverMonth(),
      rolling30Days: [],
    };
  }

  const total = includedRows.reduce((sum, row) => sum + row.amount, 0);
  const dayCount = d.differenceInCalendarDays(end, start) + 1;
  const expenses = includedRows
    .filter(row => row.amount < 0)
    .map(row => Math.abs(row.amount))
    .sort((first, second) => first - second);
  const middle = Math.floor(expenses.length / 2);
  const medianExpense =
    expenses.length === 0
      ? null
      : expenses.length % 2 === 1
        ? -expenses[middle]
        : -Math.round((expenses[middle - 1] + expenses[middle]) / 2);

  return {
    state: includedRows.length === 0 ? 'empty' : 'ready',
    currency,
    total,
    averagePerDay: Math.round(total / dayCount),
    averagePerWeek: Math.round((total * 7) / dayCount),
    averagePerMonth: Math.round((total * averageCalendarDaysPerMonth) / dayCount),
    medianExpense,
    categoryBreakdown: getExpenditureBreakdown(
      includedRows,
      'categoryName',
    ),
    merchantBreakdown: getExpenditureBreakdown(
      includedRows,
      'merchantName',
    ),
    monthOverMonth: getMonthOverMonth({
      startDate,
      endDate,
      rows: includedRows,
    }),
    rolling30Days,
  };
}
