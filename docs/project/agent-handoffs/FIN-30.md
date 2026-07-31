# FIN-30 Expenditure Metrics Contract

This contract applies to one Custom Report selection. It does not add a saved
report option, exchange-rate conversion, or a second report editor.

## Calculation contract

All money is Actual integer money in its existing sign convention: an expense
is negative and a refund is positive. Every money result is an integer; divide
results use `Math.round`. A `YYYY-MM-DD` interval is inclusive at both ends.

`calculateExpenditureMetrics(input)` is a closed, synchronous pure function:

```ts
type ExpenditureMetricRow = {
  date: string;
  amount: number; // Actual integer money
  currency: string;
  isParent: boolean;
  isTransfer: boolean;
  isOffBudget: boolean;
};

type ExpenditureMetricsInput = {
  startDate: string;
  endDate: string;
  rows: readonly ExpenditureMetricRow[];
};

type ExpenditureMetrics = {
  state: 'ready' | 'empty' | 'multi-currency';
  currency: string | null;
  total: number | null;
  averagePerDay: number | null;
  averagePerWeek: number | null;
  medianExpense: number | null;
  monthOverMonth: {
    state: 'ready' | 'unavailable' | 'zero-prior';
    current: number | null;
    prior: number | null;
    change: number | null;
    percent: number | null;
  };
  rolling30Days: readonly { date: string; amount: number }[];
};
```

The adapter supplies rows that already satisfy the Custom Report's condition
filters, date range, hidden-category and uncategorized settings. The pure
function then includes only rows that are not split parents, transfers, or
off-budget. Thus normal on-budget expenses and positive refunds are included;
refunds offset total, averages, MoM, and rolling values. Transfer pairs,
including credit-card payments, are excluded. A split parent is excluded and
its child rows are included exactly once.

`total` is the signed sum of included rows. `averagePerDay` is
`round(total / inclusiveDayCount)`. `averagePerWeek` is
`round(total * 7 / inclusiveDayCount)`; partial ranges use their actual day
count, never a padded week. `medianExpense` uses only negative included rows,
sorts their absolute values, takes the middle value (or rounded mean of the two
middles), then returns it negative. It is `null` when there are no expense
rows; refunds never create a median expense.

MoM uses the final calendar month touched by `endDate` and the immediately
preceding calendar month, each intersected with the selected inclusive report
range. It is available only when both intersections are non-empty. `change` is
`current - prior`; `percent` is `round(change * 10000 / abs(prior)) / 100`.
When prior is zero, retain `current`, `prior`, and `change`, set `percent` to
`null`, and use `zero-prior`; do not divide by zero. It does not annualize or
normalize partial months.

`rolling30Days` contains one point for every calendar day in the selected
range. Each point is the signed sum from `max(startDate, point - 29 days)`
through the point, inclusive. The first 29 points are deliberately partial;
the function never reads transactions outside the report range.

No currency conversion is allowed. If included candidate rows contain more than
one currency, return `multi-currency`, `currency: null`, all money fields and
MoM amounts as `null`, and an empty series. With no included rows, return
`empty`, retain the one known input currency when present, return zero for
total/averages, `null` median, and the normal all-zero series. An invalid or
reversed interval is an implementation error, not a UI state.

## Fixed synthetic examples

For `2026-01-30` through `2026-02-03`, use these filtered rows:

| Date   |     Amount | Row                | Included reason    |
| ------ | ---------: | ------------------ | ------------------ |
| Jan 30 |      -1000 | expense            | expense            |
| Jan 31 |       -500 | expense            | expense            |
| Feb 1  |        200 | refund             | offsets spending   |
| Feb 2  |      -2000 | transfer           | excluded           |
| Feb 3  |       -700 | off-budget expense | excluded           |
| Feb 3  |      -1200 | split parent       | excluded           |
| Feb 3  | -900, -300 | split children     | included once each |

Expected: total `-2500`; five-day average `-500`; weekly average `-3500`;
median expense `-700`; Jan `-1500`, Feb `-1000`, MoM change `500`, percent
`33.33`; rolling points `[-1000, -1500, -1300, -1300, -2500]` for the five
dates. A Jan-zero/Feb-`-200` comparison is `zero-prior`, change `-200`, and
percent `null`. A USD row and an EUR row produce `multi-currency` with no
numeric cards or series.

## FIN-31 / FIN-32 seams

- FIN-31: add the pure module and its table tests beside
  `packages/desktop-client/src/components/reports/spreadsheets/`. Add a
  transaction-row query beside `makeQuery.ts`, invoked from
  `fetchSpreadsheetQueryData.ts` after the existing
  `make-filters-from-conditions` path in `custom-spreadsheet.ts`. Preserve its
  date bounds and report predicates; select date, integer amount, transfer
  account, account off-budget, split-parent flag, and currency. Do not reuse
  the grouped `QueryDataEntity` for median or split handling.
- FIN-32: calculate alongside the existing `useReport('default', getGraphData)`
  flow in `reports/CustomReport.tsx`; render cards in the existing
  `ReportSummary.tsx` sidebar and the rolling line with the existing report
  graph components. `ready` renders formatted financial integers; `empty`
  shows zero averages/total and No expenses for median; `zero-prior` shows the
  amount change and No prior spending for percent; `multi-currency`
  replaces every metric card and the series with a concise unsupported-currency
  message. Wrap money in `FinancialText` and `PrivacyFilter`.

No production code was changed by FIN-30.
