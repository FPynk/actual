import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { AccountPage } from './page-models/account-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

test.describe('Native finance workflows', () => {
  let page: Page;
  let navigation: Navigation;
  let accountPage: AccountPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new Navigation(page);

    await page.goto('/');
    await new ConfigurationPage(page).createTestFile();
    accountPage = await navigation.createAccount({
      name: 'Native finance review',
      balance: 0,
      offBudget: false,
    });
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('keeps categorization scope review local until OpenAI consent is possible', async () => {
    await page.getByRole('button', { name: 'Auto-categorize' }).click();

    await expect(
      page.getByRole('heading', { name: 'Auto-categorize expenses' }),
    ).toBeVisible();
    const categorizationScope = page.getByRole('button', {
      name: 'Transactions to classify',
    });
    await expect(categorizationScope).toBeVisible();
    await categorizationScope.click();
    await page
      .getByRole('menu')
      .getByRole('button', { name: 'Date range' })
      .click();
    await expect(categorizationScope).toContainText('Inclusive date range');
    await expect(page.getByLabel('Start date')).toBeVisible();
    await expect(page.getByLabel('End date')).toBeVisible();

    await page
      .getByRole('button', { name: 'Review eligible expenses' })
      .click();
    await expect(
      page.getByText(
        'Choose at least one expense category in OpenAI categorization settings.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    ).not.toBeVisible();
  });

  test('reviews duplicate and recurring candidates without changing transactions or schedules', async () => {
    await page.getByRole('button', { name: 'Review duplicates' }).click();
    const duplicateDialog = page.getByRole('dialog');
    await expect(duplicateDialog).toContainText('Same transaction date');
    await expect(duplicateDialog).toContainText('Same normalized merchant');
    const keepBothButtons = duplicateDialog.getByRole('button', {
      name: 'Keep both',
    });
    const candidateCount = await keepBothButtons.count();
    expect(candidateCount).toBeGreaterThan(0);
    const allAccountsBalance = await page
      .getByRole('link', { name: /^All accounts/ })
      .textContent();
    await keepBothButtons.first().click();
    await expect(keepBothButtons).toHaveCount(0);
    await expect(keepBothButtons.first()).toBeVisible();
    expect(
      await page.getByRole('link', { name: /^All accounts/ }).textContent(),
    ).toBe(allAccountsBalance);

    await page.getByRole('button', { name: 'Close' }).click();
    const recurringImportChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import' }).click();
    await (
      await recurringImportChooser
    ).setFiles({
      name: 'native-recurring-candidate.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'Date,Payee,Notes,Category,Amount',
          '2026-04-15,Native recurring charge,,Food,-12.34',
          '2026-05-15,Native recurring charge,,Food,-12.34',
          '2026-06-15,Native recurring charge,,Food,-12.34',
          '2026-07-15,Native recurring charge,,Food,-12.34',
        ].join('\n'),
      ),
    });
    const importRecurringTransactions = page.getByRole('button', {
      name: /Import 4 transactions/,
    });
    await expect(importRecurringTransactions).toBeVisible();
    await importRecurringTransactions.click();
    await expect(importRecurringTransactions).not.toBeVisible();

    const schedulesPage = await navigation.goToSchedulesPage();
    await schedulesPage.page
      .getByRole('button', { name: 'Review recurring payments' })
      .click();
    const recurringCandidate = page
      .locator('div')
      .filter({ hasText: 'Native recurring charge' })
      .filter({ has: page.getByRole('button', { name: 'Defer' }) })
      .last();
    await expect(recurringCandidate).toContainText('Monthly cadence');
    await expect(recurringCandidate).toContainText('Enough occurrences');
    await recurringCandidate.getByRole('button', { name: 'Defer' }).click();
    await expect(page.getByText('Review status: Deferred')).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  test('matches an Amazon JSON export in read-only review', async () => {
    const settingsPage = await navigation.goToSettingsPage();
    await settingsPage.enableExperimentalFeature('Currency support');
    const defaultCurrency = page
      .getByText('Default Currency', { exact: true })
      .locator('..');
    await defaultCurrency.getByRole('button').click();
    await page
      .getByRole('menu')
      .getByRole('button', { name: 'USD - US Dollar ($)' })
      .click();
    await expect(defaultCurrency).toContainText('USD - US Dollar ($)');

    accountPage = await navigation.goToAccountPage('Native finance review');
    await accountPage.createSingleTransaction({
      date: '01/01/2017',
      payee: 'Amazon E2E match',
      debit: '19.99',
    });
    await page.getByRole('button', { name: 'Amazon review' }).click();

    await page.getByLabel('Amazon file').setInputFiles({
      name: 'amazon-e2e-order.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          orders: [
            {
              marketplace: 'amazon.com',
              externalOrderId: 'E2E-123-1234567',
              orderDate: '2017-01-01',
              currencyCode: 'USD',
              itemSubtotal: 1999,
              taxTotal: 0,
              shippingTotal: 0,
              discountTotal: 0,
              giftCardTotal: 0,
              refundTotal: 0,
              orderTotal: 1999,
            },
          ],
          shipments: [],
          items: [],
          refunds: [],
        }),
      ),
    });

    await expect(page.getByText('Ready for review')).toBeVisible();
    await expect(
      page.getByText(/Suggested transaction: Amazon E2E match on/),
    ).toBeVisible();
    const amazonReviewDialog = page.getByRole('dialog');
    await expect(
      amazonReviewDialog.getByRole('button', { name: 'Close' }),
    ).toBeVisible();
    await expect(
      amazonReviewDialog.getByRole('button', {
        name: /Apply|Approve|Update transaction|Create splits/i,
      }),
    ).toHaveCount(0);
    await expect(
      accountPage.transactionTableRow.filter({ hasText: 'Amazon E2E match' }),
    ).toHaveCount(1);
  });
});
