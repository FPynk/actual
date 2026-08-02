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
      name: 'Current filtered view',
    });
    await expect(categorizationScope).toBeVisible();
    await categorizationScope.click();
    await page
      .getByRole('menu')
      .getByRole('button', { name: 'Date range' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Date range' }),
    ).toBeVisible();
    await expect(page.getByLabel('Start date')).toBeVisible();
    await expect(page.getByLabel('End date')).toBeVisible();

    await page.getByRole('button', { name: 'Review eligible expenses' }).click();
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
    await accountPage.createSingleTransaction({
      payee: 'Native duplicate safeguard',
      debit: '19.99',
    });
    await accountPage.createSingleTransaction({
      payee: 'Native duplicate safeguard',
      debit: '19.99',
    });

    await page.getByRole('button', { name: 'Review duplicates' }).click();
    const duplicateCandidate = page
      .locator('div')
      .filter({ hasText: 'Native duplicate safeguard' })
      .filter({
        has: page.getByRole('button', { name: 'Keep both' }),
      })
      .last();
    await expect(duplicateCandidate).toContainText('Same transaction date');
    await expect(duplicateCandidate).toContainText('Same normalized merchant');
    await duplicateCandidate.getByRole('button', { name: 'Keep both' }).click();
    await expect(duplicateCandidate).not.toBeVisible();
    await expect(
      accountPage.transactionTableRow.filter({
        hasText: 'Native duplicate safeguard',
      }),
    ).toHaveCount(2);

    await page.getByRole('button', { name: 'Close' }).click();
    const schedulesPage = await navigation.goToSchedulesPage();
    await schedulesPage.page
      .getByRole('button', { name: 'Review recurring payments' })
      .click();
    const recurringCandidate = page
      .locator('div')
      .filter({ hasText: 'Dominion Power' })
      .filter({ has: page.getByRole('button', { name: 'Defer' }) })
      .last();
    await expect(recurringCandidate).toContainText('Monthly cadence');
    await expect(recurringCandidate).toContainText('Enough occurrences');
    await recurringCandidate.getByRole('button', { name: 'Defer' }).click();
    await expect(recurringCandidate).toContainText('Review status: Deferred');
    await recurringCandidate.getByRole('button', { name: 'Reopen' }).click();
    await expect(
      recurringCandidate.getByRole('button', { name: 'Approve' }),
    ).toBeVisible();
  });

  test('matches an Amazon JSON export in read-only review', async () => {
    await accountPage.createSingleTransaction({
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
              orderDate: new Date().toISOString().slice(0, 10),
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
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(
      accountPage.transactionTableRow.filter({ hasText: 'Amazon E2E match' }),
    ).toHaveCount(1);
  });
});
