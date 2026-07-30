import { createSyntheticFinanceWorkflowFixture } from '@actual-app/core/mocks';
import type { Page, TestInfo } from '@playwright/test';

import { expect, test } from './fixtures';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

const fixture = createSyntheticFinanceWorkflowFixture();

test.describe('Synthetic finance workflow', () => {
  let page: Page;
  let navigation: Navigation;
  let consoleMessages: string[];

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new Navigation(page);
    consoleMessages = [];
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', error => consoleMessages.push(`pageerror: ${error}`));

    await page.clock.install({ time: new Date(fixture.transactions[0].date) });
    await page.goto('/');
    await new ConfigurationPage(page).createTestFile();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('validates existing import, rule, report, schedule, split, and account workflows', async ({
    browser: _browser,
  }, testInfo: TestInfo) => {
    const checkingAccount = fixture.accounts[0];
    const ordinaryExpense = fixture.transactions.find(
      transaction =>
        transaction.id === fixture.ids.transactions.ordinaryExpense,
    );
    const refund = fixture.transactions.find(
      transaction => transaction.id === fixture.ids.transactions.refund,
    );
    const splitParent = fixture.transactions.find(
      transaction => transaction.id === fixture.ids.transactions.split.parent,
    );
    const splitChildren = fixture.transactions.filter(
      transaction => transaction.parent_id === splitParent?.id,
    );
    const monthlySchedule = fixture.schedules[0];

    if (
      !ordinaryExpense ||
      !refund ||
      !splitParent ||
      splitChildren.length !== 2 ||
      typeof monthlySchedule._amount !== 'number'
    ) {
      throw new Error('The synthetic finance workflow fixture is incomplete.');
    }

    let accountPage = await navigation.createAccount({
      name: checkingAccount.name,
      balance: 0,
      offBudget: false,
    });

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'synthetic-finance-workflow.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(toCsv([ordinaryExpense, splitParent])),
    });

    const importButton = page.getByRole('button', {
      name: /Import 2 transactions/,
    });
    await expect(importButton).toBeVisible();
    await testInfo.attach('structured-import-preview', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await importButton.click();
    await expect(importButton).not.toBeVisible();
    const importedOrdinaryExpenseRow = accountPage.transactionTableRow
      .filter({
        has: page
          .getByTestId('payee')
          .filter({ hasText: payeeName(ordinaryExpense.payee) }),
      })
      .filter({
        has: page
          .getByTestId('notes')
          .filter({ hasText: ordinaryExpense.notes ?? '' }),
      })
      .filter({
        has: page
          .getByTestId('debit')
          .filter({ hasText: amountToDecimal(ordinaryExpense.amount) }),
      });
    const importedSplitParentRow = accountPage.transactionTableRow
      .filter({
        has: page
          .getByTestId('payee')
          .filter({ hasText: payeeName(splitParent.payee) }),
      })
      .filter({
        has: page
          .getByTestId('notes')
          .filter({ hasText: splitParent.notes ?? '' }),
      })
      .filter({
        has: page
          .getByTestId('debit')
          .filter({ hasText: amountToDecimal(splitParent.amount) }),
      });
    await expect(importedOrdinaryExpenseRow).toHaveCount(1);
    await expect(importedSplitParentRow).toHaveCount(1);

    const rulesPage = await navigation.goToRulesPage();
    const ruleModal = await rulesPage.createNewRule();
    await ruleModal.fill({
      conditions: [
        { field: 'payee', op: 'is', value: payeeName(ordinaryExpense.payee) },
      ],
      actions: [
        { field: 'notes', op: 'set', value: ordinaryExpense.notes ?? '' },
      ],
    });
    await ruleModal.save();
    await rulesPage.searchFor(payeeName(ordinaryExpense.payee));
    await expect(rulesPage.getNthRule(0).conditions).toHaveText([
      `payee is ${payeeName(ordinaryExpense.payee)}`,
    ]);

    accountPage = await navigation.goToAccountPage(checkingAccount.name);
    const ruleTriggeredExpenseAmount = amountToDecimal(
      ordinaryExpense.amount * 2,
    );
    await accountPage.createSingleTransaction({
      payee: payeeName(ordinaryExpense.payee),
      debit: ruleTriggeredExpenseAmount,
    });
    const ruleTriggeredExpenseRow = accountPage.transactionTableRow
      .filter({
        has: page
          .getByTestId('payee')
          .filter({ hasText: payeeName(ordinaryExpense.payee) }),
      })
      .filter({
        has: page
          .getByTestId('debit')
          .filter({ hasText: ruleTriggeredExpenseAmount }),
      });
    await expect(ruleTriggeredExpenseRow).toHaveCount(1);
    await expect(ruleTriggeredExpenseRow.getByTestId('notes')).toHaveText(
      ordinaryExpense.notes ?? '',
    );

    await accountPage.createSplitTransaction([
      {
        payee: payeeName(splitParent.payee),
        debit: amountToDecimal(splitParent.amount),
      },
      { debit: amountToDecimal(splitChildren[0].amount), category: 'Food' },
      { debit: amountToDecimal(splitChildren[1].amount), category: 'General' },
    ]);
    const splitParentRow = accountPage.transactionTableRow.filter({
      has: page.getByTestId('category').filter({ hasText: /^Split$/ }),
    });
    await expect(splitParentRow.getByTestId('category')).toHaveText('Split');
    await expect(accountPage.transactionTable).toContainText(
      amountToDecimal(splitChildren[0].amount),
    );
    await expect(accountPage.transactionTable).toContainText(
      amountToDecimal(splitChildren[1].amount),
    );

    const schedulesPage = await navigation.goToSchedulesPage();
    const scheduleModal = await schedulesPage.addNewSchedule();
    await scheduleModal.fill({
      scheduleName: monthlySchedule.name,
      payee: payeeName(monthlySchedule._payee),
      account: checkingAccount.name,
      amount: Math.abs(monthlySchedule._amount) / 100,
    });
    await scheduleModal.add();
    const fixtureScheduleRow = schedulesPage.schedulesTableRow.filter({
      has: page
        .getByTestId('payee')
        .filter({ hasText: payeeName(monthlySchedule._payee) }),
    });
    await expect(fixtureScheduleRow).toHaveCount(1);
    await expect(fixtureScheduleRow.getByTestId('payee')).toHaveText(
      payeeName(monthlySchedule._payee),
    );
    await expect(fixtureScheduleRow.getByTestId('status')).toHaveText('Due');
    await fixtureScheduleRow.getByTestId('actions').getByRole('button').click();
    await page.getByRole('button', { name: 'Post transaction today' }).click();
    await expect(fixtureScheduleRow.getByTestId('status')).toHaveText('Paid');

    accountPage = await navigation.goToAccountPage(checkingAccount.name);
    await expect(
      accountPage.transactionTableRow.filter({
        hasText: payeeName(monthlySchedule._payee),
      }),
    ).toHaveCount(1);

    await accountPage.createSingleTransaction({
      payee: payeeName(refund.payee),
      credit: amountToDecimal(refund.amount),
    });
    await expect(accountPage.transactionTable).toContainText(
      amountToDecimal(refund.amount),
    );

    const reportsPage = await navigation.goToReportsPage();
    await reportsPage.waitToLoad();
    await reportsPage.goToNetWorthPage();
    const rangeTrigger = page.getByTestId('date-range-picker-trigger');
    await rangeTrigger.click();
    const datePicker = page.locator('[data-popover]');
    for (let year = 2016; year < 2025; year++) {
      await datePicker
        .getByRole('button', { name: 'Next', exact: true })
        .click();
    }
    await datePicker.getByRole('button', { name: 'December 2025' }).click();
    await datePicker.getByRole('button', { name: 'Next', exact: true }).click();
    await datePicker.getByRole('button', { name: 'January 2026' }).click();
    await page.keyboard.press('Escape');
    await expect(rangeTrigger).toContainText(/Dec.*2025.*Jan.*2026/);

    await navigation.goToAccountPage(checkingAccount.name);
    await page.reload();
    await expect(page.getByTestId('account-name')).toHaveText(
      checkingAccount.name,
    );
    await expect(page.getByTestId('transaction-table')).toContainText(
      payeeName(refund.payee),
    );
    await expect(importedOrdinaryExpenseRow).toHaveCount(1);
    await expect(importedSplitParentRow).toHaveCount(1);
    expect(consoleMessages).toEqual([]);
  });
});

function toCsv(
  transactions: ReadonlyArray<{
    amount: number;
    date: string;
    notes?: string;
    payee?: string;
  }>,
): string {
  return [
    'Date,Payee,Notes,Category,Amount',
    ...transactions.map(transaction =>
      [
        transaction.date,
        payeeName(transaction.payee),
        transaction.notes ?? '',
        'Food',
        (transaction.amount / 100).toFixed(2),
      ].join(','),
    ),
  ].join('\n');
}

function payeeName(payeeId: string | undefined): string {
  return fixture.payees.find(payee => payee.id === payeeId)?.name ?? '';
}

function amountToDecimal(amount: number): string {
  return (Math.abs(amount) / 100).toFixed(2);
}
