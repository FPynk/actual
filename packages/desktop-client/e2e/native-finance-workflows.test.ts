import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { AccountPage } from './page-models/account-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

async function expectSeparatedModalActions(
  cancelButton: Locator,
  continueButton: Locator,
) {
  const [cancelBox, continueBox] = await Promise.all([
    cancelButton.boundingBox(),
    continueButton.boundingBox(),
  ]);
  if (!cancelBox || !continueBox) {
    throw new Error('expected visible auto-categorize modal actions');
  }

  const horizontallySeparated =
    cancelBox.x + cancelBox.width + 7 <= continueBox.x ||
    continueBox.x + continueBox.width + 7 <= cancelBox.x;
  const verticallySeparated =
    cancelBox.y + cancelBox.height + 7 <= continueBox.y ||
    continueBox.y + continueBox.height + 7 <= cancelBox.y;
  expect(horizontallySeparated || verticallySeparated).toBe(true);
}

function boxesDoNotOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return (
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

async function configureCategorizationReviewFixture(page: Page) {
  await page.route('**/finance/categorize', async route => {
    const request = route.request().postDataJSON() as {
      candidates: Array<{ candidate_id: string }>;
      categories: Array<{ category_id: string }>;
    };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          proposals: request.candidates.map(candidate => ({
            candidate_id: candidate.candidate_id,
            category_id: request.categories[0].category_id,
            confidence: 'high',
            explanation:
              'A deliberately long deterministic explanation must remain separate from the current category and category control.',
          })),
          usage: null,
        },
        status: 'ok',
      }),
    });
  });

  await page.evaluate(async serverUrl => {
    const categories = await window.$send('get-categories');
    const categoryId = categories.list[0]?.id;
    if (!categoryId) throw new Error('expected a demo category');

    const settings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: [categoryId],
      masterPrompt: 'Choose the most suitable category.',
      model: 'gpt-4.1-mini',
    });
    await window.$send('set-server-url', { url: serverUrl, validate: false });
    await window.$send('subscribe-set-token', { token: 'e2e-token' });
    await window.$send('save-prefs', { cloudFileId: 'e2e-file-id' });
    await window.$send('preferences/save', {
      id: 'finance.openai-categorization',
      value: settings,
    });
    window.__actionsForMenu.mergeSyncedPrefs({
      'finance.openai-categorization': settings,
    });
  }, new URL('/', page.url()).origin);
}

async function openCategorizationReview(page: Page, accountPage: AccountPage) {
  await configureCategorizationReviewFixture(page);
  await accountPage.createSingleTransaction({
    date: '01/01/2017',
    debit: '12.34',
    payee:
      'A deliberately long merchant description that must wrap without covering categorization controls',
  });
  await page.getByRole('button', { name: 'Auto-categorize' }).click();
  await page
    .getByRole('button', { name: 'Review eligible transactions' })
    .click();
  await page
    .getByRole('checkbox', {
      name: 'I understand and want to generate suggestions for this run',
    })
    .check();
  await page.getByRole('button', { name: 'Generate suggestions' }).click();
  await expect(page.getByText('1 suggestions selected.')).toBeVisible();
}

async function expectCategorizationReviewControlsDoNotOverlap(page: Page) {
  const dialog = page.getByRole('dialog');
  const payee = dialog.getByText(
    'A deliberately long merchant description that must wrap without covering categorization controls',
  );
  const direction = dialog.getByText('Outflow');
  const amount = dialog.getByText(/12\.34/);
  const date = dialog.getByText('2017-01-01');
  const currentCategory = dialog.getByText('Current: Uncategorized');
  const categoryLabel = dialog.locator(
    'label[for^="categorization-category-"]',
  );
  const categoryControl = dialog.locator('[id^="categorization-category-"]');
  const explanation = dialog.getByText(
    'A deliberately long deterministic explanation must remain separate from the current category and category control.',
  );
  const confidence = dialog.getByText('high confidence');

  await expect(categoryLabel).toHaveCount(1);
  await expect(categoryControl).toHaveCount(1);
  await expect(categoryLabel).toHaveAttribute(
    'for',
    await categoryControl.getAttribute('id'),
  );

  const namedLocators = {
    payee,
    direction,
    amount,
    date,
    currentCategory,
    categoryLabel,
    categoryControl,
    confidence,
    explanation,
  };
  const dialogBox = await dialog.boundingBox();
  const boxes = Object.fromEntries(
    await Promise.all(
      Object.entries(namedLocators).map(async ([name, locator]) => [
        name,
        await locator.boundingBox(),
      ]),
    ),
  );
  if (!dialogBox || Object.values(boxes).some(box => box === null)) {
    throw new Error('expected visible categorization review controls');
  }

  const visibleBoxes = boxes as Record<
    keyof typeof namedLocators,
    NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>
  >;
  const nonOverlappingPairs: Array<
    readonly [keyof typeof namedLocators, keyof typeof namedLocators]
  > = [
    ['payee', 'direction'],
    ['payee', 'amount'],
    ['payee', 'date'],
    ['currentCategory', 'categoryLabel'],
    ['currentCategory', 'categoryControl'],
    ['currentCategory', 'confidence'],
    ['categoryLabel', 'categoryControl'],
    ['categoryControl', 'confidence'],
    ['currentCategory', 'explanation'],
    ['categoryControl', 'explanation'],
    ['confidence', 'explanation'],
  ];
  for (const [first, second] of nonOverlappingPairs) {
    expect(boxesDoNotOverlap(visibleBoxes[first], visibleBoxes[second])).toBe(
      true,
    );
  }
  for (const box of Object.values(visibleBoxes)) {
    expect(box.x).toBeGreaterThanOrEqual(dialogBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(
      dialogBox.x + dialogBox.width + 1,
    );
  }
}

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
      page.getByRole('heading', { name: 'Auto-categorize transactions' }),
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

    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    const reviewButton = page.getByRole('button', {
      name: 'Review eligible transactions',
    });
    await expectSeparatedModalActions(cancelButton, reviewButton);
    await reviewButton.click();
    await expect(
      page.getByText(
        'Choose at least one category in OpenAI categorization settings.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    ).not.toBeVisible();
  });

  test('keeps auto-categorize actions separated at narrow widths', async () => {
    await page.setViewportSize({ width: 350, height: 700 });
    await page.getByRole('button', { name: 'Auto-categorize' }).click();

    const autoCategorizeDialog = page.getByRole('dialog');
    const cancelButton = autoCategorizeDialog.getByRole('button', {
      name: 'Cancel',
    });
    const reviewButton = autoCategorizeDialog.getByRole('button', {
      name: 'Review eligible transactions',
    });
    await expectSeparatedModalActions(cancelButton, reviewButton);

    const [dialogBox, reviewBox] = await Promise.all([
      autoCategorizeDialog.boundingBox(),
      reviewButton.boundingBox(),
    ]);
    if (!dialogBox || !reviewBox) {
      throw new Error(
        'expected a visible auto-categorize modal at narrow width',
      );
    }
    expect(reviewBox.x + reviewBox.width).toBeLessThanOrEqual(
      dialogBox.x + dialogBox.width + 1,
    );
  });

  test('keeps review controls separate and labeled at desktop and narrow widths', async () => {
    await openCategorizationReview(page, accountPage);
    await expectCategorizationReviewControlsDoNotOverlap(page);

    await page.setViewportSize({ width: 350, height: 700 });
    await expectCategorizationReviewControlsDoNotOverlap(page);
  });

  test('uses checked transactions from either auto-categorize entry point', async () => {
    await accountPage.createSingleTransaction({
      date: '01/01/2017',
      payee: 'Checked transaction',
      debit: '12.34',
    });

    const categorizationScope = page.getByRole('button', {
      name: 'Transactions to classify',
    });

    await page.getByRole('button', { name: 'Auto-categorize' }).click();
    await expect(categorizationScope).toContainText('Current filtered view');
    await page.keyboard.press('Escape');

    await accountPage.selectNthTransaction(0);
    await page.getByRole('button', { name: 'Auto-categorize' }).click();
    await expect(categorizationScope).toContainText('Selected transactions');
    await page.keyboard.press('Escape');

    await accountPage.clickSelectAction('Auto-categorize');
    await expect(categorizationScope).toContainText('Selected transactions');
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

  test('applies a reviewed Amazon allocation as native splits and undoes it', async () => {
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
              itemSubtotal: 1800,
              taxTotal: 199,
              shippingTotal: 0,
              discountTotal: 0,
              giftCardTotal: 0,
              refundTotal: 0,
              orderTotal: 1999,
            },
          ],
          shipments: [],
          items: [
            {
              externalOrderId: 'E2E-123-1234567',
              externalItemId: 'E2E-split-item',
              title: 'Native Amazon split item',
              quantity: 1,
              unitAmount: 1800,
              taxAmount: 199,
              shippingAmount: 0,
              discountAmount: 0,
              refundAmount: 0,
            },
          ],
          refunds: [],
        }),
      ),
    });

    await expect(page.getByText('Ready for review')).toBeVisible();
    await expect(
      page.getByText(/Suggested transaction: Amazon E2E match on/),
    ).toBeVisible();
    const amazonReviewDialog = page.getByRole('dialog');
    const chooseCategory = amazonReviewDialog.getByRole('button', {
      name: 'Choose category',
    });
    await expect(chooseCategory).toHaveCount(2);
    await chooseCategory.first().click();
    await page.getByTestId('Food-category-item').click();
    await chooseCategory.last().click();
    await page.getByTestId('Food-category-item').click();

    await amazonReviewDialog
      .getByRole('button', { name: 'Apply to transaction' })
      .click();
    await expect(
      amazonReviewDialog.getByText(
        /This review was applied\. Undo restores the ledger/,
      ),
    ).toBeVisible();
    await amazonReviewDialog.getByRole('button', { name: 'Close' }).click();

    await expect(accountPage.transactionTable).toContainText(
      'Native Amazon split item',
    );
    await expect(accountPage.transactionTable).toContainText(
      'Amazon E2E match',
    );
    await expect(accountPage.transactionTable).toContainText(
      'Amazon E2E-123-1234567',
    );
    await expect(accountPage.transactionTableRow).toHaveCount(3);
    await expect(accountPage.getNthTransaction(1).category).toHaveText('Food');
    await expect(accountPage.getNthTransaction(2).category).toHaveText('Food');

    await accountPage.transactionTable.click();
    await page.keyboard.press('Control+z');
    await expect(
      accountPage.transactionTableRow.filter({ hasText: 'Amazon E2E match' }),
    ).toHaveCount(1);
    await expect(accountPage.transactionTableRow).toHaveCount(1);
    await expect(accountPage.getNthTransaction(0).category).toHaveText(
      'Categorize',
    );
    await expect(accountPage.getNthTransaction(0).notes).toHaveText('');
  });
});
