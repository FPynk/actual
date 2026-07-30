import {
  createSyntheticFinanceWorkflowFixture,
  fixedSyntheticFinanceClock,
} from './finance-workflow';

describe('synthetic finance workflow fixture', () => {
  test('returns identical values with fresh object identity', () => {
    const first = createSyntheticFinanceWorkflowFixture();
    const second = createSyntheticFinanceWorkflowFixture();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.ids).not.toBe(second.ids);
    expect(first.ids.transactions.split).not.toBe(
      second.ids.transactions.split,
    );
    expect(first.accounts).not.toBe(second.accounts);
    expect(first.accounts[0]).not.toBe(second.accounts[0]);
    expect(first.transactions[0]).not.toBe(second.transactions[0]);
    expect(first.schedules[0]).not.toBe(second.schedules[0]);
  });

  test('uses the fixed clock and accepts an injected clock', () => {
    expect(fixedSyntheticFinanceClock.currentDate()).toBe('2026-01-15');
    expect(fixedSyntheticFinanceClock.currentTimestamp()).toBe(
      '2026-01-15T12:00:00.000Z',
    );

    const fixture = createSyntheticFinanceWorkflowFixture({
      clock: {
        currentDate: () => '2030-04-05',
        currentTimestamp: () => '2030-04-05T06:07:08.000Z',
      },
    });
    const currentExpense = fixture.transactions.find(
      transaction =>
        transaction.id === fixture.ids.transactions.ordinaryExpense,
    );

    expect(currentExpense).toMatchObject({
      date: '2030-04-05',
      imported_id: '2030-04-05T06:07:08.000Z',
    });
  });

  test('provides valid, unique fixed UUIDs for every selectable entity', () => {
    const fixture = createSyntheticFinanceWorkflowFixture();
    const selectableIds = collectStringValues(fixture.ids);
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    expect(selectableIds).not.toHaveLength(0);
    expect(selectableIds.every(id => uuidPattern.test(id))).toBe(true);
    expect(new Set(selectableIds).size).toBe(selectableIds.length);
  });

  test('models balanced splits and paired credit-card transfers', () => {
    const fixture = createSyntheticFinanceWorkflowFixture();
    const splitParent = findTransaction(
      fixture,
      fixture.ids.transactions.split.parent,
    );
    const splitChildren = [
      findTransaction(fixture, fixture.ids.transactions.split.groceries),
      findTransaction(fixture, fixture.ids.transactions.split.household),
    ];
    const transferOut = findTransaction(
      fixture,
      fixture.ids.transactions.transferOut,
    );
    const transferIn = findTransaction(
      fixture,
      fixture.ids.transactions.transferIn,
    );

    expect(splitParent.is_parent).toBe(true);
    expect(
      splitChildren.reduce(
        (total, transaction) => total + transaction.amount,
        0,
      ),
    ).toBe(splitParent.amount);
    expect(
      splitChildren.every(
        transaction =>
          transaction.is_child && transaction.parent_id === splitParent.id,
      ),
    ).toBe(true);
    expect(transferOut.transfer_id).toBe(transferIn.id);
    expect(transferIn.transfer_id).toBe(transferOut.id);
    expect(transferOut.amount).toBe(-transferIn.amount);
    expect(transferOut.account).not.toBe(transferIn.account);
  });

  test('uses integer minor-unit amounts throughout the fixture', () => {
    const fixture = createSyntheticFinanceWorkflowFixture();
    const scheduleAmounts = fixture.schedules.flatMap(schedule =>
      typeof schedule._amount === 'number'
        ? [schedule._amount]
        : [schedule._amount.num1, schedule._amount.num2],
    );

    expect(
      fixture.transactions.every(transaction =>
        Number.isInteger(transaction.amount),
      ),
    ).toBe(true);
    expect(scheduleAmounts.every(Number.isInteger)).toBe(true);
  });

  test('names every required recurrence scenario for direct selection', () => {
    const fixture = createSyntheticFinanceWorkflowFixture();
    const scenarios = [
      ['monthly', fixture.ids.schedules.monthly],
      ['varying monthly', fixture.ids.schedules.varyingMonthly],
      ['weekly', fixture.ids.schedules.weekly],
      ['annual', fixture.ids.schedules.annual],
      ['irregular', fixture.ids.schedules.irregular],
      ['price increase', fixture.ids.schedules.priceIncrease],
      ['paused and resumed', fixture.ids.schedules.pausedAndResumed],
    ] as const;

    for (const [scenarioName, scheduleId] of scenarios) {
      const schedule = fixture.schedules.find(
        candidate => candidate.id === scheduleId,
      );

      expect(schedule?.name?.toLowerCase()).toContain(scenarioName);
    }
  });

  test('provides deterministic transaction histories for recurrence analysis', () => {
    const fixture = createSyntheticFinanceWorkflowFixture();
    const recurringIds = fixture.ids.transactions.recurring;
    const monthly = findTransactions(
      fixture,
      Object.values(recurringIds.monthly),
    );
    const varyingMonthly = findTransactions(
      fixture,
      Object.values(recurringIds.varyingMonthly),
    );
    const weekly = findTransactions(
      fixture,
      Object.values(recurringIds.weekly),
    );
    const annual = findTransactions(
      fixture,
      Object.values(recurringIds.annual),
    );
    const irregular = findTransactions(
      fixture,
      Object.values(recurringIds.irregular),
    );
    const priceIncrease = findTransactions(
      fixture,
      Object.values(recurringIds.priceIncrease),
    );
    const pausedAndResumed = findTransactions(
      fixture,
      Object.values(recurringIds.pausedAndResumed),
    );

    expect(new Set(monthly.map(transaction => transaction.amount)).size).toBe(
      1,
    );
    expect(
      new Set(varyingMonthly.map(transaction => transaction.amount)).size,
    ).toBeGreaterThan(1);
    expect(weekly.map(transaction => transaction.date)).toEqual([
      '2025-12-24',
      '2025-12-31',
      '2026-01-07',
      '2026-01-14',
    ]);
    expect(annual.map(transaction => transaction.date)).toEqual([
      '2025-01-01',
      '2026-01-01',
    ]);
    expect(irregular.map(transaction => transaction.date)).toEqual([
      '2025-08-04',
      '2025-09-19',
      '2025-12-01',
      '2026-01-11',
    ]);
    expect(priceIncrease.map(transaction => transaction.amount)).toEqual([
      -1_299, -1_299, -1_599, -1_599,
    ]);
    expect(pausedAndResumed.map(transaction => transaction.date)).toEqual([
      '2025-08-08',
      '2025-09-08',
      '2025-12-08',
      '2026-01-08',
    ]);

    for (const [scenario, transactionIds] of Object.entries(recurringIds)) {
      expect(
        findTransactions(fixture, Object.values(transactionIds)),
        scenario,
      ).not.toHaveLength(0);
    }
  });
});

type TestFixture = ReturnType<typeof createSyntheticFinanceWorkflowFixture>;

function findTransaction(fixture: TestFixture, id: string) {
  const transaction = fixture.transactions.find(
    candidate => candidate.id === id,
  );

  if (!transaction) {
    throw new Error(`Synthetic transaction ${id} was not found.`);
  }

  return transaction;
}

function findTransactions(fixture: TestFixture, ids: string[]) {
  return ids.map(id => findTransaction(fixture, id));
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.values(value).flatMap(collectStringValues);
}
