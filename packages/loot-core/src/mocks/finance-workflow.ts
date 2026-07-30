import type {
  AccountEntity,
  CategoryEntity,
  CategoryGroupEntity,
  PayeeEntity,
  ScheduleEntity,
  TransactionEntity,
} from '#types/models';

export type SyntheticFinanceClock = Readonly<{
  currentDate: () => string;
  currentTimestamp: () => string;
}>;

export type SyntheticFinanceWorkflowIds = Readonly<{
  accounts: Readonly<{
    checking: string;
    card: string;
  }>;
  payees: Readonly<{
    market: string;
    streaming: string;
    utility: string;
    employer: string;
    weeklyMarket: string;
    annualInsurer: string;
    maintenance: string;
    priceIncreaseStreaming: string;
    pausedStreaming: string;
    transferToCard: string;
    transferToChecking: string;
  }>;
  categoryGroups: Readonly<{
    expenses: string;
    income: string;
  }>;
  categories: Readonly<{
    groceries: string;
    entertainment: string;
    utilities: string;
    household: string;
    salary: string;
  }>;
  transactions: Readonly<{
    ordinaryExpense: string;
    ordinaryIncome: string;
    refund: string;
    transferOut: string;
    transferIn: string;
    split: Readonly<{
      parent: string;
      groceries: string;
      household: string;
    }>;
    recurring: Readonly<{
      monthly: Readonly<{
        october: string;
        november: string;
        december: string;
        january: string;
      }>;
      varyingMonthly: Readonly<{
        october: string;
        november: string;
        december: string;
        january: string;
      }>;
      weekly: Readonly<{
        december24: string;
        december31: string;
        january07: string;
        january14: string;
      }>;
      annual: Readonly<{
        previous: string;
        current: string;
      }>;
      irregular: Readonly<{
        august: string;
        september: string;
        december: string;
        january: string;
      }>;
      priceIncrease: Readonly<{
        october: string;
        november: string;
        december: string;
        january: string;
      }>;
      pausedAndResumed: Readonly<{
        august: string;
        september: string;
        december: string;
        january: string;
      }>;
    }>;
  }>;
  schedules: Readonly<{
    monthly: string;
    varyingMonthly: string;
    weekly: string;
    annual: string;
    irregular: string;
    priceIncrease: string;
    pausedAndResumed: string;
  }>;
}>;

export type SyntheticFinanceWorkflowFixture = Readonly<{
  ids: SyntheticFinanceWorkflowIds;
  accounts: readonly AccountEntity[];
  payees: readonly PayeeEntity[];
  categoryGroups: readonly CategoryGroupEntity[];
  categories: readonly CategoryEntity[];
  transactions: readonly TransactionEntity[];
  schedules: readonly ScheduleEntity[];
}>;

export const fixedSyntheticFinanceClock: SyntheticFinanceClock = {
  currentDate: () => '2026-01-15',
  currentTimestamp: () => '2026-01-15T12:00:00.000Z',
};

const fixedIds: SyntheticFinanceWorkflowIds = {
  accounts: {
    checking: '10000000-0000-4000-8000-000000000001',
    card: '10000000-0000-4000-8000-000000000002',
  },
  payees: {
    market: '20000000-0000-4000-8000-000000000001',
    streaming: '20000000-0000-4000-8000-000000000002',
    utility: '20000000-0000-4000-8000-000000000003',
    employer: '20000000-0000-4000-8000-000000000004',
    transferToCard: '20000000-0000-4000-8000-000000000005',
    transferToChecking: '20000000-0000-4000-8000-000000000006',
    weeklyMarket: '20000000-0000-4000-8000-000000000007',
    annualInsurer: '20000000-0000-4000-8000-000000000008',
    maintenance: '20000000-0000-4000-8000-000000000009',
    priceIncreaseStreaming: '20000000-0000-4000-8000-000000000010',
    pausedStreaming: '20000000-0000-4000-8000-000000000011',
  },
  categoryGroups: {
    expenses: '30000000-0000-4000-8000-000000000001',
    income: '30000000-0000-4000-8000-000000000002',
  },
  categories: {
    groceries: '40000000-0000-4000-8000-000000000001',
    entertainment: '40000000-0000-4000-8000-000000000002',
    utilities: '40000000-0000-4000-8000-000000000003',
    household: '40000000-0000-4000-8000-000000000004',
    salary: '40000000-0000-4000-8000-000000000005',
  },
  transactions: {
    ordinaryExpense: '50000000-0000-4000-8000-000000000001',
    ordinaryIncome: '50000000-0000-4000-8000-000000000002',
    refund: '50000000-0000-4000-8000-000000000003',
    transferOut: '50000000-0000-4000-8000-000000000004',
    transferIn: '50000000-0000-4000-8000-000000000005',
    split: {
      parent: '50000000-0000-4000-8000-000000000006',
      groceries: '50000000-0000-4000-8000-000000000007',
      household: '50000000-0000-4000-8000-000000000008',
    },
    recurring: {
      monthly: {
        october: '50000000-0000-4000-8000-000000000009',
        november: '50000000-0000-4000-8000-000000000010',
        december: '50000000-0000-4000-8000-000000000011',
        january: '50000000-0000-4000-8000-000000000012',
      },
      varyingMonthly: {
        october: '50000000-0000-4000-8000-000000000013',
        november: '50000000-0000-4000-8000-000000000014',
        december: '50000000-0000-4000-8000-000000000015',
        january: '50000000-0000-4000-8000-000000000016',
      },
      weekly: {
        december24: '50000000-0000-4000-8000-000000000017',
        december31: '50000000-0000-4000-8000-000000000018',
        january07: '50000000-0000-4000-8000-000000000019',
        january14: '50000000-0000-4000-8000-000000000020',
      },
      annual: {
        previous: '50000000-0000-4000-8000-000000000021',
        current: '50000000-0000-4000-8000-000000000022',
      },
      irregular: {
        august: '50000000-0000-4000-8000-000000000023',
        september: '50000000-0000-4000-8000-000000000024',
        december: '50000000-0000-4000-8000-000000000025',
        january: '50000000-0000-4000-8000-000000000026',
      },
      priceIncrease: {
        october: '50000000-0000-4000-8000-000000000027',
        november: '50000000-0000-4000-8000-000000000028',
        december: '50000000-0000-4000-8000-000000000029',
        january: '50000000-0000-4000-8000-000000000030',
      },
      pausedAndResumed: {
        august: '50000000-0000-4000-8000-000000000031',
        september: '50000000-0000-4000-8000-000000000032',
        december: '50000000-0000-4000-8000-000000000033',
        january: '50000000-0000-4000-8000-000000000034',
      },
    },
  },
  schedules: {
    monthly: '60000000-0000-4000-8000-000000000001',
    varyingMonthly: '60000000-0000-4000-8000-000000000002',
    weekly: '60000000-0000-4000-8000-000000000003',
    annual: '60000000-0000-4000-8000-000000000004',
    irregular: '60000000-0000-4000-8000-000000000005',
    priceIncrease: '60000000-0000-4000-8000-000000000006',
    pausedAndResumed: '60000000-0000-4000-8000-000000000007',
  },
};

export function createSyntheticFinanceWorkflowFixture(options?: {
  clock?: SyntheticFinanceClock;
}): SyntheticFinanceWorkflowFixture {
  const clock = options?.clock ?? fixedSyntheticFinanceClock;
  const ids: SyntheticFinanceWorkflowIds = structuredClone(fixedIds);

  return {
    ids,
    accounts: [
      createAccount(ids.accounts.checking, 'Synthetic Checking', 1),
      createAccount(ids.accounts.card, 'Synthetic Card', 2),
    ],
    payees: [
      { id: ids.payees.market, name: 'Example Market' },
      { id: ids.payees.streaming, name: 'Example Streaming' },
      { id: ids.payees.utility, name: 'Example Utility' },
      { id: ids.payees.employer, name: 'Example Employer' },
      { id: ids.payees.weeklyMarket, name: 'Example Weekly Market' },
      { id: ids.payees.annualInsurer, name: 'Example Annual Insurer' },
      { id: ids.payees.maintenance, name: 'Example Maintenance' },
      {
        id: ids.payees.priceIncreaseStreaming,
        name: 'Example Streaming Price Change',
      },
      {
        id: ids.payees.pausedStreaming,
        name: 'Example Streaming Paused',
      },
      {
        id: ids.payees.transferToCard,
        name: 'Transfer: Synthetic Card',
        transfer_acct: ids.accounts.card,
      },
      {
        id: ids.payees.transferToChecking,
        name: 'Transfer: Synthetic Checking',
        transfer_acct: ids.accounts.checking,
      },
    ],
    categoryGroups: [
      {
        id: ids.categoryGroups.expenses,
        name: 'Synthetic Expenses',
        is_income: false,
        sort_order: 1,
      },
      {
        id: ids.categoryGroups.income,
        name: 'Synthetic Income',
        is_income: true,
        sort_order: 2,
      },
    ],
    categories: [
      createCategory(
        ids.categories.groceries,
        'Groceries',
        ids.categoryGroups.expenses,
        1,
      ),
      createCategory(
        ids.categories.entertainment,
        'Entertainment',
        ids.categoryGroups.expenses,
        2,
      ),
      createCategory(
        ids.categories.utilities,
        'Utilities',
        ids.categoryGroups.expenses,
        3,
      ),
      createCategory(
        ids.categories.household,
        'Household',
        ids.categoryGroups.expenses,
        4,
      ),
      createCategory(
        ids.categories.salary,
        'Salary',
        ids.categoryGroups.income,
        5,
        true,
      ),
    ],
    transactions: createTransactions(ids, clock),
    schedules: createSchedules(ids),
  };
}

function createAccount(
  id: string,
  name: string,
  sortOrder: number,
): AccountEntity {
  return {
    id,
    name,
    offbudget: 0,
    closed: 0,
    sort_order: sortOrder,
    last_reconciled: null,
    tombstone: 0,
    account_id: null,
    bank: null,
    bankName: null,
    bankId: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null,
  };
}

function createCategory(
  id: string,
  name: string,
  group: string,
  sortOrder: number,
  isIncome = false,
): CategoryEntity {
  return { id, name, group, sort_order: sortOrder, is_income: isIncome };
}

function createTransactions(
  ids: SyntheticFinanceWorkflowIds,
  clock: SyntheticFinanceClock,
): TransactionEntity[] {
  const splitParent: TransactionEntity = {
    id: ids.transactions.split.parent,
    account: ids.accounts.checking,
    amount: -12_345,
    payee: ids.payees.market,
    date: '2026-01-12',
    is_parent: true,
    notes: 'Split Example Market purchase',
  };

  const splitChildren: TransactionEntity[] = [
    {
      id: ids.transactions.split.groceries,
      parent_id: splitParent.id,
      account: ids.accounts.checking,
      category: ids.categories.groceries,
      amount: -10_000,
      date: splitParent.date,
      is_child: true,
    },
    {
      id: ids.transactions.split.household,
      parent_id: splitParent.id,
      account: ids.accounts.checking,
      category: ids.categories.household,
      amount: -2_345,
      date: splitParent.date,
      is_child: true,
    },
  ];

  return [
    {
      id: ids.transactions.ordinaryExpense,
      account: ids.accounts.checking,
      category: ids.categories.groceries,
      amount: -6_789,
      payee: ids.payees.market,
      date: clock.currentDate(),
      imported_id: clock.currentTimestamp(),
      notes: 'Ordinary grocery expense',
    },
    {
      id: ids.transactions.ordinaryIncome,
      account: ids.accounts.checking,
      category: ids.categories.salary,
      amount: 250_000,
      payee: ids.payees.employer,
      date: '2026-01-01',
      notes: 'Ordinary salary income',
    },
    {
      id: ids.transactions.refund,
      account: ids.accounts.card,
      category: ids.categories.entertainment,
      amount: 1_299,
      payee: ids.payees.streaming,
      date: '2026-01-10',
      notes: 'Refund from Example Streaming',
    },
    {
      id: ids.transactions.transferOut,
      account: ids.accounts.checking,
      amount: -50_000,
      payee: ids.payees.transferToCard,
      date: '2026-01-14',
      transfer_id: ids.transactions.transferIn,
      notes: 'Credit card payment',
    },
    {
      id: ids.transactions.transferIn,
      account: ids.accounts.card,
      amount: 50_000,
      payee: ids.payees.transferToChecking,
      date: '2026-01-14',
      transfer_id: ids.transactions.transferOut,
      notes: 'Credit card payment received',
    },
    splitParent,
    ...splitChildren,
    ...createRecurringTransactions(
      ids.schedules.monthly,
      ids.accounts.checking,
      ids.payees.streaming,
      ids.categories.entertainment,
      [
        {
          id: ids.transactions.recurring.monthly.october,
          amount: -1_299,
          date: '2025-10-15',
        },
        {
          id: ids.transactions.recurring.monthly.november,
          amount: -1_299,
          date: '2025-11-15',
        },
        {
          id: ids.transactions.recurring.monthly.december,
          amount: -1_299,
          date: '2025-12-15',
        },
        {
          id: ids.transactions.recurring.monthly.january,
          amount: -1_299,
          date: '2026-01-15',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.varyingMonthly,
      ids.accounts.checking,
      ids.payees.utility,
      ids.categories.utilities,
      [
        {
          id: ids.transactions.recurring.varyingMonthly.october,
          amount: -12_100,
          date: '2025-10-16',
        },
        {
          id: ids.transactions.recurring.varyingMonthly.november,
          amount: -16_800,
          date: '2025-11-14',
        },
        {
          id: ids.transactions.recurring.varyingMonthly.december,
          amount: -10_900,
          date: '2025-12-17',
        },
        {
          id: ids.transactions.recurring.varyingMonthly.january,
          amount: -14_200,
          date: '2026-01-15',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.weekly,
      ids.accounts.checking,
      ids.payees.weeklyMarket,
      ids.categories.groceries,
      [
        {
          id: ids.transactions.recurring.weekly.december24,
          amount: -7_500,
          date: '2025-12-24',
        },
        {
          id: ids.transactions.recurring.weekly.december31,
          amount: -7_500,
          date: '2025-12-31',
        },
        {
          id: ids.transactions.recurring.weekly.january07,
          amount: -7_500,
          date: '2026-01-07',
        },
        {
          id: ids.transactions.recurring.weekly.january14,
          amount: -7_500,
          date: '2026-01-14',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.annual,
      ids.accounts.checking,
      ids.payees.annualInsurer,
      ids.categories.utilities,
      [
        {
          id: ids.transactions.recurring.annual.previous,
          amount: -120_000,
          date: '2025-01-01',
        },
        {
          id: ids.transactions.recurring.annual.current,
          amount: -120_000,
          date: '2026-01-01',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.irregular,
      ids.accounts.checking,
      ids.payees.maintenance,
      ids.categories.household,
      [
        {
          id: ids.transactions.recurring.irregular.august,
          amount: -4_500,
          date: '2025-08-04',
        },
        {
          id: ids.transactions.recurring.irregular.september,
          amount: -21_000,
          date: '2025-09-19',
        },
        {
          id: ids.transactions.recurring.irregular.december,
          amount: -8_250,
          date: '2025-12-01',
        },
        {
          id: ids.transactions.recurring.irregular.january,
          amount: -19_500,
          date: '2026-01-11',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.priceIncrease,
      ids.accounts.checking,
      ids.payees.priceIncreaseStreaming,
      ids.categories.entertainment,
      [
        {
          id: ids.transactions.recurring.priceIncrease.october,
          amount: -1_299,
          date: '2025-10-05',
        },
        {
          id: ids.transactions.recurring.priceIncrease.november,
          amount: -1_299,
          date: '2025-11-05',
        },
        {
          id: ids.transactions.recurring.priceIncrease.december,
          amount: -1_599,
          date: '2025-12-05',
        },
        {
          id: ids.transactions.recurring.priceIncrease.january,
          amount: -1_599,
          date: '2026-01-05',
        },
      ],
    ),
    ...createRecurringTransactions(
      ids.schedules.pausedAndResumed,
      ids.accounts.checking,
      ids.payees.pausedStreaming,
      ids.categories.entertainment,
      [
        {
          id: ids.transactions.recurring.pausedAndResumed.august,
          amount: -899,
          date: '2025-08-08',
        },
        {
          id: ids.transactions.recurring.pausedAndResumed.september,
          amount: -899,
          date: '2025-09-08',
        },
        {
          id: ids.transactions.recurring.pausedAndResumed.december,
          amount: -899,
          date: '2025-12-08',
        },
        {
          id: ids.transactions.recurring.pausedAndResumed.january,
          amount: -899,
          date: '2026-01-08',
        },
      ],
    ),
  ];
}

function createRecurringTransactions(
  schedule: string,
  account: string,
  payee: string,
  category: string,
  occurrences: ReadonlyArray<
    Readonly<{ id: string; amount: number; date: string }>
  >,
): TransactionEntity[] {
  return occurrences.map(occurrence => ({
    ...occurrence,
    account,
    schedule,
    payee,
    category,
  }));
}

function createSchedules(ids: SyntheticFinanceWorkflowIds): ScheduleEntity[] {
  return [
    createSchedule(
      ids.schedules.monthly,
      'Monthly Example Streaming',
      ids.payees.streaming,
      ids.accounts.checking,
      -1_299,
      { frequency: 'monthly', start: '2026-01-15' },
      '2026-02-15',
    ),
    createSchedule(
      ids.schedules.varyingMonthly,
      'Varying monthly Example Utility bill',
      ids.payees.utility,
      ids.accounts.checking,
      { num1: -10_000, num2: -18_000 },
      { frequency: 'monthly', start: '2026-01-15' },
      '2026-02-15',
    ),
    createSchedule(
      ids.schedules.weekly,
      'Weekly Example Market',
      ids.payees.weeklyMarket,
      ids.accounts.checking,
      -7_500,
      { frequency: 'weekly', interval: 1, start: '2026-01-14' },
      '2026-01-21',
    ),
    createSchedule(
      ids.schedules.annual,
      'Annual Example Utility insurance',
      ids.payees.annualInsurer,
      ids.accounts.checking,
      -120_000,
      { frequency: 'yearly', start: '2026-01-01' },
      '2027-01-01',
    ),
    createSchedule(
      ids.schedules.irregular,
      'Irregular Example Utility maintenance',
      ids.payees.maintenance,
      ids.accounts.checking,
      -19_500,
      { frequency: 'monthly', interval: 3, start: '2025-12-01' },
      '2026-03-01',
    ),
    createSchedule(
      ids.schedules.priceIncrease,
      'Example Streaming price increase',
      ids.payees.priceIncreaseStreaming,
      ids.accounts.checking,
      -1_599,
      { frequency: 'monthly', start: '2026-01-15' },
      '2026-02-15',
    ),
    createSchedule(
      ids.schedules.pausedAndResumed,
      'Paused and resumed Example Streaming',
      ids.payees.pausedStreaming,
      ids.accounts.checking,
      -899,
      { frequency: 'monthly', start: '2025-08-08' },
      '2026-02-08',
    ),
  ];
}

function createSchedule(
  id: string,
  name: string,
  payee: string,
  account: string,
  amount: ScheduleEntity['_amount'],
  date: Exclude<ScheduleEntity['_date'], string>,
  nextDate: string,
): ScheduleEntity {
  return {
    id,
    name,
    rule: `7${id.slice(1)}`,
    next_date: nextDate,
    completed: false,
    posts_transaction: true,
    tombstone: false,
    _payee: payee,
    _account: account,
    _amount: amount,
    _amountOp: 'is',
    _date: date,
    _conditions: [],
    _actions: [],
  };
}
