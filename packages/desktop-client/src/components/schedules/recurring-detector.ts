import * as d from 'date-fns';

export type RecurringPaymentTransaction = Readonly<{
  id: string;
  accountId: string;
  payeeId: string | null;
  payeeName: string | null;
  date: string;
  amount: number;
  isTransfer: boolean;
  isSplitParent: boolean;
  isReconciled: boolean;
}>;

export type RecurringPaymentCadence =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'ambiguous';

export type RecurringPaymentType =
  | 'optional-subscription'
  | 'household-bill'
  | 'financial-bill';

export type RecurringPaymentCandidate = Readonly<{
  accountId: string;
  payeeId: string;
  payeeName: string;
  cadence: RecurringPaymentCadence;
  type: RecurringPaymentType;
  occurrenceCount: number;
  medianAmount: number;
  amountVarianceBasisPoints: number;
  dateVarianceDays: number;
  hasReconciledHistory: boolean;
  reasons: readonly string[];
}>;

type CadenceDefinition = Readonly<{
  cadence: Exclude<RecurringPaymentCadence, 'ambiguous'>;
  minimumOccurrences: number;
  toleranceDays: number;
  nextDate: (date: Date) => Date;
}>;

const cadenceDefinitions: readonly CadenceDefinition[] = [
  {
    cadence: 'weekly',
    minimumOccurrences: 4,
    toleranceDays: 2,
    nextDate: date => d.addWeeks(date, 1),
  },
  {
    cadence: 'monthly',
    minimumOccurrences: 3,
    toleranceDays: 4,
    nextDate: date => d.addMonths(date, 1),
  },
  {
    cadence: 'quarterly',
    minimumOccurrences: 3,
    toleranceDays: 4,
    nextDate: date => d.addMonths(date, 3),
  },
  {
    cadence: 'annual',
    minimumOccurrences: 2,
    toleranceDays: 7,
    nextDate: date => d.addYears(date, 1),
  },
];

export function detectRecurringPayments(
  transactions: readonly RecurringPaymentTransaction[],
): readonly RecurringPaymentCandidate[] {
  const transactionsByPayee = new Map<
    string,
    RecurringPaymentTransaction[]
  >();
  for (const transaction of transactions) {
    if (
      transaction.payeeId == null ||
      transaction.payeeName == null ||
      transaction.amount >= 0 ||
      transaction.isTransfer ||
      transaction.isSplitParent
    ) {
      continue;
    }
    const key = `${transaction.accountId}\0${transaction.payeeId}`;
    const payeeTransactions = transactionsByPayee.get(key) ?? [];
    payeeTransactions.push(transaction);
    transactionsByPayee.set(key, payeeTransactions);
  }

  return [...transactionsByPayee.values()]
    .map(createCandidate)
    .filter((candidate): candidate is RecurringPaymentCandidate => candidate != null)
    .sort((left, right) => left.payeeName.localeCompare(right.payeeName));
}

function createCandidate(
  transactions: readonly RecurringPaymentTransaction[],
): RecurringPaymentCandidate | null {
  const sortedTransactions = [...transactions].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const cadenceMatches = cadenceDefinitions.filter(definition =>
    matchesCadence(sortedTransactions, definition),
  );
  if (cadenceMatches.length === 0) return null;

  const cadence =
    cadenceMatches.length === 1 ? cadenceMatches[0].cadence : 'ambiguous';
  const amounts = sortedTransactions
    .map(transaction => Math.abs(transaction.amount))
    .sort((left, right) => left - right);
  const medianAmount = median(amounts);
  const amountVarianceBasisPoints = Math.max(
    ...amounts.map(amount =>
      Math.round((Math.abs(amount - medianAmount) * 10_000) / medianAmount),
    ),
  );
  const selectedCadence = cadenceMatches[0];
  const dateVarianceDays = Math.max(
    0,
    ...sortedTransactions.slice(1).map((transaction, index) =>
      Math.abs(
        d.differenceInCalendarDays(
          d.parseISO(transaction.date),
          selectedCadence.nextDate(d.parseISO(sortedTransactions[index].date)),
        ),
      ),
    ),
  );
  const payeeName = sortedTransactions[0].payeeName;
  const hasReconciledHistory = sortedTransactions.some(
    transaction => transaction.isReconciled,
  );

  return {
    accountId: sortedTransactions[0].accountId,
    payeeId: sortedTransactions[0].payeeId!,
    payeeName,
    cadence,
    type: classifyRecurringPayment(payeeName),
    occurrenceCount: sortedTransactions.length,
    medianAmount,
    amountVarianceBasisPoints,
    dateVarianceDays,
    hasReconciledHistory,
    reasons: [
      cadence === 'ambiguous' ? 'Ambiguous cadence' : `${cadence} cadence`,
      `${sortedTransactions.length} occurrences`,
      amountVarianceBasisPoints === 0
        ? 'Stable amount'
        : 'Amount varies',
      dateVarianceDays === 0 ? 'Stable date' : 'Date varies',
      ...(hasReconciledHistory ? ['Reconciled history'] : []),
    ],
  };
}

function matchesCadence(
  transactions: readonly RecurringPaymentTransaction[],
  definition: CadenceDefinition,
): boolean {
  if (transactions.length < definition.minimumOccurrences) return false;
  return transactions.slice(1).every((transaction, index) => {
    const expected = definition.nextDate(d.parseISO(transactions[index].date));
    return (
      Math.abs(d.differenceInCalendarDays(d.parseISO(transaction.date), expected)) <=
      definition.toleranceDays
    );
  });
}

function median(amounts: readonly number[]): number {
  const middle = Math.floor(amounts.length / 2);
  return amounts.length % 2 === 1
    ? amounts[middle]
    : Math.round((amounts[middle - 1] + amounts[middle]) / 2);
}

function classifyRecurringPayment(name: string): RecurringPaymentType {
  const normalizedName = name.toLowerCase();
  if (/bank|loan|mortgage|insurance|credit/.test(normalizedName)) {
    return 'financial-bill';
  }
  if (/utility|electric|water|gas|internet|phone|rent/.test(normalizedName)) {
    return 'household-bill';
  }
  return 'optional-subscription';
}
