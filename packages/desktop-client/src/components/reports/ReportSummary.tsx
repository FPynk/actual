import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type {
  balanceTypeOpType,
  DataEntity,
} from '@actual-app/core/types/models';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { LineGraph } from '#components/reports/graphs/LineGraph';
import type { ExpenditureMetrics } from '#components/reports/spreadsheets/expenditure-metrics';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';

import { ReportOptions } from './ReportOptions';

type ReportSummaryProps = {
  startDate: string;
  endDate: string;
  data: DataEntity;
  balanceTypeOp: balanceTypeOpType;
  interval: string;
  intervalsCount: number;
  expenditureMetrics?: ExpenditureMetrics | 'error' | null;
};

function createRollingExpenditureData(
  expenditureMetrics: ExpenditureMetrics,
): DataEntity {
  const lastAmount =
    expenditureMetrics.rolling30Days[
      expenditureMetrics.rolling30Days.length - 1
    ]?.amount ?? 0;

  return {
    data: [],
    intervalData: expenditureMetrics.rolling30Days.map(({ date, amount }) => ({
      date,
      totalAssets: 0,
      totalDebts: amount,
      netAssets: amount > 0 ? amount : 0,
      netDebts: amount < 0 ? amount : 0,
      totalTotals: amount,
      totalBudgeted: amount,
    })),
    legend: [
      {
        name: 'Rolling 30-day expenditure',
        id: null,
        color: 'var(--color-chartQual1)',
        dataKey: 'totalDebts',
      },
    ],
    totalAssets: 0,
    totalDebts: lastAmount,
    netAssets: lastAmount > 0 ? lastAmount : 0,
    netDebts: lastAmount < 0 ? lastAmount : 0,
    totalTotals: lastAmount,
    totalBudgeted: lastAmount,
  };
}

type ExpenditureMetricCardProps = {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
};

function ExpenditureMetricCard({
  label,
  value,
  detail,
}: ExpenditureMetricCardProps) {
  return (
    <View
      style={{
        backgroundColor: theme.tableBackground,
        flex: '1 1 120px',
        minWidth: 120,
        padding: 10,
      }}
    >
      <Text style={{ ...styles.smallText, fontWeight: 600 }}>{label}</Text>
      <FinancialText style={{ ...styles.largeText, fontWeight: 700 }}>
        <PrivacyFilter>{value}</PrivacyFilter>
      </FinancialText>
      {detail && <Text style={{ ...styles.smallText }}>{detail}</Text>}
    </View>
  );
}

function ExpenditureBreakdown({
  title,
  entries,
  emptyLabel,
}: {
  title: ReactNode;
  entries: ExpenditureMetrics['categoryBreakdown'];
  emptyLabel: ReactNode;
}) {
  const { t } = useTranslation();
  const format = useFormat();

  return (
    <View style={{ flex: '1 1 180px', gap: 4 }}>
      <Text style={{ ...styles.smallText, fontWeight: 600 }}>{title}</Text>
      {entries.length === 0 ? (
        <Text style={styles.smallText}>{emptyLabel}</Text>
      ) : (
        entries.map(entry => (
          <View
            key={entry.name ?? 'uncategorized'}
            style={{ flexDirection: 'row', justifyContent: 'space-between' }}
          >
            <Text style={styles.smallText}>
              {entry.name ?? t('Uncategorized')}
            </Text>
            <FinancialText style={styles.smallText}>
              <PrivacyFilter>{format(entry.amount, 'financial')}</PrivacyFilter>
            </FinancialText>
          </View>
        ))
      )}
    </View>
  );
}

function ExpenditureMetricsSummary({
  expenditureMetrics,
}: {
  expenditureMetrics: ExpenditureMetrics;
}) {
  const { t } = useTranslation();
  const format = useFormat();

  if (expenditureMetrics.state === 'multi-currency') {
    return (
      <View
        style={{
          backgroundColor: theme.pageBackground,
          marginTop: 10,
          padding: 15,
        }}
      >
        <Text style={{ ...styles.mediumText, fontWeight: 600 }}>
          <Trans>Expenditure metrics</Trans>
        </Text>
        <Text>
          <Trans>
            Expenditure metrics are unavailable for reports with multiple
            currencies.
          </Trans>
        </Text>
      </View>
    );
  }

  const monthOverMonth = expenditureMetrics.monthOverMonth;
  const monthOverMonthValue =
    monthOverMonth.change == null
      ? t('No comparison')
      : format(monthOverMonth.change, 'financial-with-sign');
  const monthOverMonthDetail =
    monthOverMonth.state === 'zero-prior'
      ? t('No prior spending')
      : monthOverMonth.percent == null
        ? t('No comparison')
        : format(monthOverMonth.percent, 'percentage');

  return (
    <View
      style={{
        backgroundColor: theme.pageBackground,
        marginTop: 10,
        padding: 10,
      }}
    >
      <Text
        style={{
          ...styles.mediumText,
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        <Trans>Expenditure metrics</Trans>
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <ExpenditureMetricCard
          label={<Trans>Total expenditure</Trans>}
          value={format(expenditureMetrics.total ?? 0, 'financial')}
          detail={<Trans>For this time period</Trans>}
        />
        <ExpenditureMetricCard
          label={<Trans>Average per day</Trans>}
          value={format(expenditureMetrics.averagePerDay ?? 0, 'financial')}
        />
        <ExpenditureMetricCard
          label={<Trans>Average per week</Trans>}
          value={format(expenditureMetrics.averagePerWeek ?? 0, 'financial')}
        />
        <ExpenditureMetricCard
          label={<Trans>Average per month</Trans>}
          value={format(expenditureMetrics.averagePerMonth ?? 0, 'financial')}
          detail={<Trans>Monthly rate based on the selected days</Trans>}
        />
        <ExpenditureMetricCard
          label={<Trans>Median expense</Trans>}
          value={
            expenditureMetrics.medianExpense == null
              ? t('No expenses')
              : format(expenditureMetrics.medianExpense, 'financial')
          }
        />
        <ExpenditureMetricCard
          label={<Trans>Month over month</Trans>}
          value={monthOverMonthValue}
          detail={monthOverMonthDetail}
        />
      </View>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 16,
          marginTop: 12,
        }}
      >
        <ExpenditureBreakdown
          title={<Trans>Spending by category</Trans>}
          entries={expenditureMetrics.categoryBreakdown}
          emptyLabel={<Trans>No category spending</Trans>}
        />
        <ExpenditureBreakdown
          title={<Trans>Spending by merchant</Trans>}
          entries={expenditureMetrics.merchantBreakdown}
          emptyLabel={<Trans>No merchant spending</Trans>}
        />
      </View>
      <Text
        style={{
          ...styles.smallText,
          fontWeight: 600,
          marginBottom: 4,
          marginTop: 12,
        }}
      >
        <Trans>Rolling 30-day expenditure</Trans>
      </Text>
      <LineGraph
        data={createRollingExpenditureData(expenditureMetrics)}
        filters={[]}
        groupBy="Interval"
        balanceTypeOp="totalDebts"
        interval="Daily"
        showTooltip
        style={{ height: 180 }}
      />
    </View>
  );
}

export function ReportSummary({
  startDate,
  endDate,
  data,
  balanceTypeOp,
  interval,
  intervalsCount,
  expenditureMetrics,
}: ReportSummaryProps) {
  const locale = useLocale();
  const { t } = useTranslation();
  const format = useFormat();

  const net =
    balanceTypeOp === 'netAssets'
      ? t('DEPOSIT')
      : balanceTypeOp === 'netDebts'
        ? t('PAYMENT')
        : Math.abs(data.totalDebts) > Math.abs(data.totalAssets)
          ? t('PAYMENT')
          : t('DEPOSIT');
  const average = Math.round(data[balanceTypeOp] / intervalsCount);
  return (
    <View
      style={{
        flexDirection: 'column',
        marginBottom: 10,
      }}
    >
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            ...styles.largeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 600,
          }}
        >
          {monthUtils.format(
            startDate,
            ReportOptions.intervalFormat.get(interval) || '',
            locale,
          )}
          {monthUtils.format(
            startDate,
            ReportOptions.intervalFormat.get(interval) || '',
            locale,
          ) !==
            monthUtils.format(
              endDate,
              ReportOptions.intervalFormat.get(interval) || '',
              locale,
            ) &&
            ` ${t('to')} ` +
              monthUtils.format(
                endDate,
                ReportOptions.intervalFormat.get(interval) || '',
                locale,
              )}
        </Text>
      </View>
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 10,
        }}
      >
        <Text
          style={{
            ...styles.mediumText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 400,
          }}
        >
          {balanceTypeOp === 'totalDebts'
            ? t('TOTAL SPENDING')
            : balanceTypeOp === 'totalAssets'
              ? t('TOTAL DEPOSITS')
              : balanceTypeOp === 'totalBudgeted'
                ? t('TOTAL BUDGETED')
                : t('NET {{net}}', { net })}
        </Text>
        <FinancialText
          style={{
            ...styles.veryLargeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 800,
          }}
        >
          <PrivacyFilter>
            {format(data[balanceTypeOp], 'financial')}
          </PrivacyFilter>
        </FinancialText>
        <Text style={{ fontWeight: 600 }}>
          <Trans>For this time period</Trans>
        </Text>
      </View>
      <View
        style={{
          backgroundColor: theme.pageBackground,
          padding: 15,
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 10,
        }}
      >
        <Text
          style={{
            ...styles.mediumText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 400,
          }}
        >
          {balanceTypeOp === 'totalDebts'
            ? t('AVERAGE SPENDING')
            : balanceTypeOp === 'totalAssets'
              ? t('AVERAGE DEPOSIT')
              : balanceTypeOp === 'totalBudgeted'
                ? t('AVERAGE BUDGETED')
                : t('AVERAGE NET')}
        </Text>
        <FinancialText
          style={{
            ...styles.veryLargeText,
            alignItems: 'center',
            marginBottom: 2,
            fontWeight: 800,
          }}
        >
          <PrivacyFilter>
            {!isNaN(average) && format(average, 'financial')}
          </PrivacyFilter>
        </FinancialText>
        <Text style={{ fontWeight: 600 }}>
          <Trans>
            Per{' '}
            {{
              interval: (
                ReportOptions.intervalMap.get(interval) || ''
              ).toLowerCase(),
            }}
          </Trans>
        </Text>
      </View>
      {expenditureMetrics === null && (
        <View
          style={{
            backgroundColor: theme.pageBackground,
            marginTop: 10,
            padding: 15,
          }}
        >
          <Text>
            <Trans>Calculating expenditure metrics...</Trans>
          </Text>
        </View>
      )}
      {expenditureMetrics === 'error' && (
        <View
          style={{
            backgroundColor: theme.pageBackground,
            marginTop: 10,
            padding: 15,
          }}
        >
          <Text>
            <Trans>Expenditure metrics could not be calculated.</Trans>
          </Text>
        </View>
      )}
      {expenditureMetrics && expenditureMetrics !== 'error' && (
        <ExpenditureMetricsSummary expenditureMetrics={expenditureMetrics} />
      )}
    </View>
  );
}
