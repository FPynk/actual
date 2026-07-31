import { q } from "@actual-app/core/shared/query";

import { aqlQuery } from "#queries/aqlQuery";

import type { ExpenditureMetricRow } from "./expenditure-metrics";

type ExpenditureMetricQueryRow = {
  date: string;
  amount: number;
  isParent: boolean;
  transferAccount: string | null;
  accountOffBudget: boolean;
};

export function makeExpenditureMetricsQuery({
  startDate,
  endDate,
  conditionsOpKey,
  filters,
}: {
  startDate: string;
  endDate: string;
  conditionsOpKey: string;
  filters: unknown[];
}) {
  return q("transactions")
    .filter({ [conditionsOpKey]: filters })
    .filter({
      $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
    })
    .select([
      "date",
      "amount",
      { isParent: { $id: "$is_parent" } },
      { transferAccount: { $id: "$payee.transfer_acct.id" } },
      { accountOffBudget: { $id: "$account.offbudget" } },
    ]);
}

export async function fetchExpenditureMetricRows({
  startDate,
  endDate,
  conditionsOpKey,
  filters,
  currency,
}: {
  startDate: string;
  endDate: string;
  conditionsOpKey: string;
  filters: unknown[];
  currency: string;
}): Promise<ExpenditureMetricRow[]> {
  const { data } = await aqlQuery(
    makeExpenditureMetricsQuery({
      startDate,
      endDate,
      conditionsOpKey,
      filters,
    })
  );

  return data.map((row: ExpenditureMetricQueryRow) => ({
    date: row.date,
    amount: row.amount,
    currency,
    isParent: row.isParent,
    isTransfer: Boolean(row.transferAccount),
    isOffBudget: Boolean(row.isOffBudget),
  }));
}
