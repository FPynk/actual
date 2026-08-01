import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import type {
  AmazonImportResult,
  AmazonReviewDetail,
  AmazonReviewList,
} from '../src/ui/amazon-review.ts';
import type { ReconciliationReviewCandidate } from '../src/ui/App.ts';
import type {
  ClassificationReviewDetail,
  ClassificationReviewList,
} from '../src/ui/classification-review.ts';
import type {
  SubscriptionReviewDetail,
  SubscriptionReviewList,
} from '../src/ui/subscription-review.ts';

const ownerCredential = 'synthetic-owner-credential';
const csrfToken = 'synthetic-csrf-token';
const reconciliationReviewId = `reconciliation_${'r'.repeat(43)}`;
const classificationReviewRef = `classification_${'c'.repeat(43)}`;
const subscriptionReviewRef = `subscription_${'s'.repeat(43)}`;
const amazonReviewRef = `amazon_${'a'.repeat(43)}`;
const amazonParentRef = `parent_${'p'.repeat(43)}`;

const pendingReconciliationEvidence: NonNullable<
  ReconciliationReviewCandidate['evidence']
> = {
  currencyCode: 'USD',
  source: {
    date: '2026-07-29',
    amountMinorUnits: -4_250,
    merchant: 'Synthetic market',
    accountName: 'Synthetic checking',
    state: 'Posted',
  },
  actual: {
    date: '2026-07-29',
    amountMinorUnits: -4_250,
    merchant: 'Synthetic market',
    accountName: 'Synthetic checking',
    state: 'Cleared',
  },
};

const pendingReconciliation: ReconciliationReviewCandidate = {
  version: 1,
  reviewId: reconciliationReviewId,
  status: 'pending',
  score: 92,
  confidence: 'Strong synthetic match',
  reasons: ['The amount, date, and account match exactly'],
  competingCandidateCount: 1,
  createdAt: '2026-07-30T12:00:00.000Z',
  decidedAt: null,
  evidence: pendingReconciliationEvidence,
};

const pendingClassification: ClassificationReviewDetail = {
  version: 1,
  reviewRef: classificationReviewRef,
  kind: 'category',
  title: 'Synthetic grocery category suggestion',
  status: 'pending',
  confidence: 96,
  confidenceLabel: 'Strong confidence',
  reasons: ['Four similar transactions use the same category'],
  selectedAction: null,
  createdAt: '2026-07-30T12:01:00.000Z',
  decidedAt: null,
  allowedActions: ['categorize_once', 'create_rule'],
  guidance: null,
  evidence: {
    kind: 'category',
    currencyCode: 'USD',
    current: {
      date: '2026-07-28',
      amountMinorUnits: -8_499,
      account: 'Synthetic checking',
      payee: 'Synthetic grocer',
      category: 'Uncategorized',
      state: 'Cleared',
    },
    proposedCategory: 'Groceries',
    matchingHistoryCount: 4,
    eligibleHistoryCount: 4,
  },
};

const pendingSubscription: SubscriptionReviewDetail = {
  version: 1,
  reviewRef: subscriptionReviewRef,
  title: 'Synthetic monthly utility',
  status: 'pending',
  cadence: 'Monthly',
  confidence: 88,
  selectedType: null,
  hasExistingSchedule: true,
  evaluatedAt: '2026-07-30T12:02:00.000Z',
  decidedAt: null,
  allowedActions: ['approve', 'defer', 'reject'],
  reasons: ['The payment recurs monthly with a stable amount'],
  evidence: {
    currencyCode: 'USD',
    account: 'Synthetic checking',
    payee: 'Synthetic energy provider',
    cadence: 'Monthly',
    occurrenceCount: 5,
    firstDate: '2026-03-15',
    lastDate: '2026-07-15',
    medianAmountMinorUnits: 7_500,
    amountVarianceBasisPoints: 125,
    dateVarianceDays: 1,
    recentPriceChangeBasisPoints: null,
    hasReconciledHistory: true,
    scheduleAssociation: 'existing',
  },
  guidance: null,
};

const pendingAmazonReview: AmazonReviewDetail = {
  version: 1,
  reviewRef: amazonReviewRef,
  status: 'pending',
  score: 94,
  parentCount: 1,
  allocationCount: 2,
  competingCandidateCount: 2,
  createdAt: '2026-07-30T12:03:00.000Z',
  decidedAt: null,
  currencyCode: 'USD',
  allowedActions: ['approve', 'reject', 'defer'],
  reasons: ['Every parent is explained by exact signed allocations'],
  staleReason: null,
  parents: [
    {
      parentRef: amazonParentRef,
      date: '2026-07-27',
      amountMinorUnits: -10_800,
      account: 'Synthetic card',
      payee: 'Synthetic online marketplace',
      category: 'Shopping',
      reconciled: false,
      competingCandidateCount: 2,
      allocations: [
        {
          kind: 'merchandise',
          amountMinorUnits: -10_000,
          itemTitle: 'Synthetic desk lamp',
          proposedCategory: 'Home supplies',
        },
        {
          kind: 'tax',
          amountMinorUnits: -800,
          itemTitle: null,
          proposedCategory: null,
        },
      ],
    },
  ],
  guidance: null,
};

const amazonImportResult: AmazonImportResult = {
  version: 1,
  status: 'completed',
  replayed: false,
  receipt: {
    status: 'parsed',
    rowCount: 3,
    acceptedCount: 3,
    rejectedCount: 0,
    errorCode: null,
  },
  candidateCount: 1,
};

type ObservedApiRequest = Readonly<{
  method: string;
  pathname: string;
  contentType: string;
  csrfHeader: string | undefined;
  idempotencyKey: string | undefined;
  jsonBody: string | null;
}>;

type ManualGate = Readonly<{
  wait: Promise<void>;
  release: () => void;
}>;

function createManualGate(): ManualGate {
  let release: () => void = () => undefined;
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  return { wait, release };
}

function createSyntheticApi() {
  const firstReconciliationListGate = createManualGate();
  const reconciliationDecisionGate = createManualGate();
  const amazonImportGate = createManualGate();
  const amazonDecisionGate = createManualGate();
  const observedRequests: ObservedApiRequest[] = [];
  const unexpectedRequests: string[] = [];
  let sessionAttemptCount = 0;
  let reconciliationListAttemptCount = 0;
  let classificationListAttemptCount = 0;
  let hasImportedAmazonData = false;
  let reconciliationReview = pendingReconciliation;
  let classificationReview = pendingClassification;
  let subscriptionReview = pendingSubscription;
  let amazonReview = pendingAmazonReview;

  async function handle(route: Route): Promise<void> {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const contentType = request.headers()['content-type'] ?? '';
    observedRequests.push({
      method,
      pathname,
      contentType,
      csrfHeader: request.headers()['x-finance-csrf'],
      idempotencyKey: request.headers()['idempotency-key'],
      jsonBody: contentType.startsWith('application/json')
        ? request.postData()
        : null,
    });

    if (pathname === '/api/v1/session' && method === 'POST') {
      sessionAttemptCount += 1;
      if (sessionAttemptCount === 1) {
        await route.fulfill({
          status: 401,
          json: { message: 'Synthetic credential was rejected.' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: { csrfToken } });
      return;
    }
    if (pathname === '/api/v1/session' && method === 'DELETE') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (pathname === '/api/v1/reconciliation-candidates' && method === 'GET') {
      reconciliationListAttemptCount += 1;
      if (reconciliationListAttemptCount === 1) {
        await firstReconciliationListGate.wait;
        await route.fulfill({
          status: 503,
          json: { message: 'Synthetic review service is temporarily busy.' },
        });
        return;
      }
      await route.fulfill({
        json: { version: 1, candidates: [reconciliationReview] },
      });
      return;
    }
    if (
      pathname ===
        `/api/v1/reconciliation-candidates/${reconciliationReviewId}` &&
      method === 'GET'
    ) {
      await route.fulfill({ json: reconciliationReview });
      return;
    }
    if (
      pathname ===
        `/api/v1/reconciliation-candidates/${reconciliationReviewId}/decision` &&
      method === 'POST'
    ) {
      await reconciliationDecisionGate.wait;
      reconciliationReview = {
        ...pendingReconciliation,
        status: 'stale',
        evidence: {
          ...pendingReconciliationEvidence,
          actual: null,
        },
      };
      await route.fulfill({ json: reconciliationReview });
      return;
    }
    if (pathname === '/api/v1/classification-reviews' && method === 'GET') {
      classificationListAttemptCount += 1;
      const list: ClassificationReviewList = {
        version: 1,
        reviews:
          classificationListAttemptCount === 1 ? [] : [classificationReview],
      };
      await route.fulfill({ json: list });
      return;
    }
    if (
      pathname ===
        `/api/v1/classification-reviews/${classificationReviewRef}` &&
      method === 'GET'
    ) {
      await route.fulfill({ json: classificationReview });
      return;
    }
    if (
      pathname ===
        `/api/v1/classification-reviews/${classificationReviewRef}/decision` &&
      method === 'POST'
    ) {
      classificationReview = {
        ...pendingClassification,
        allowedActions: [],
        decidedAt: '2026-07-30T12:10:00.000Z',
        guidance:
          'Open Actual manually. Finance Companion did not change Actual.',
        selectedAction: 'create_rule',
        status: 'approved',
      };
      await route.fulfill({ json: classificationReview });
      return;
    }
    if (pathname === '/api/v1/subscription-reviews' && method === 'GET') {
      const list: SubscriptionReviewList = {
        version: 1,
        reviews: [subscriptionReview],
      };
      await route.fulfill({ json: list });
      return;
    }
    if (
      pathname === `/api/v1/subscription-reviews/${subscriptionReviewRef}` &&
      method === 'GET'
    ) {
      await route.fulfill({ json: subscriptionReview });
      return;
    }
    if (
      pathname ===
        `/api/v1/subscription-reviews/${subscriptionReviewRef}/decision` &&
      method === 'POST'
    ) {
      if (
        request.postData() ===
        JSON.stringify({
          kind: 'approve',
          userSelectedType: 'household_bill',
        })
      ) {
        subscriptionReview = {
          ...pendingSubscription,
          status: 'approved',
          selectedType: 'household_bill',
          allowedActions: ['reopen'],
          decidedAt: '2026-07-30T12:11:00.000Z',
          guidance:
            'Review the existing schedule manually. Actual was not changed.',
        };
      } else if (request.postData() === JSON.stringify({ kind: 'reopen' })) {
        subscriptionReview = pendingSubscription;
      } else if (request.postData() === JSON.stringify({ kind: 'defer' })) {
        subscriptionReview = {
          ...pendingSubscription,
          status: 'deferred',
          allowedActions: ['reopen'],
          decidedAt: '2026-07-30T12:12:00.000Z',
        };
      } else {
        await route.fulfill({
          status: 400,
          json: { message: 'Unexpected synthetic subscription action.' },
        });
        return;
      }
      await route.fulfill({ json: subscriptionReview });
      return;
    }
    if (pathname === '/api/v1/amazon-reviews' && method === 'GET') {
      const list: AmazonReviewList = {
        version: 1,
        reviews: hasImportedAmazonData ? [amazonReview] : [],
      };
      await route.fulfill({ json: list });
      return;
    }
    if (
      pathname === `/api/v1/amazon-reviews/${amazonReviewRef}` &&
      method === 'GET'
    ) {
      await route.fulfill({ json: amazonReview });
      return;
    }
    if (pathname === '/api/v1/imports/amazon' && method === 'POST') {
      await amazonImportGate.wait;
      hasImportedAmazonData = true;
      await route.fulfill({ status: 201, json: amazonImportResult });
      return;
    }
    if (
      pathname === `/api/v1/amazon-reviews/${amazonReviewRef}/decision` &&
      method === 'POST'
    ) {
      await amazonDecisionGate.wait;
      amazonReview = {
        ...pendingAmazonReview,
        status: 'stale',
        staleReason: 'reconciled',
        allowedActions: [],
        parents: pendingAmazonReview.parents.map(parent => ({
          ...parent,
          reconciled: true,
        })),
      };
      await route.fulfill({ json: amazonReview });
      return;
    }

    unexpectedRequests.push(`${method} ${pathname}`);
    await route.fulfill({
      status: 404,
      json: { message: 'Unexpected synthetic API request.' },
    });
  }

  return {
    handle,
    observedRequests,
    unexpectedRequests,
    releaseFirstReconciliationList: firstReconciliationListGate.release,
    releaseReconciliationDecision: reconciliationDecisionGate.release,
    releaseAmazonImport: amazonImportGate.release,
    releaseAmazonDecision: amazonDecisionGate.release,
  };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const documentWidth = Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        );
        return documentWidth - document.documentElement.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(0);
}

async function signIn(page: Page, credential = ownerCredential): Promise<void> {
  const credentialInput = page.getByLabel('Owner credential');
  await credentialInput.fill(credential);
  await page.keyboard.press('Enter');
}

async function expectNoOpaqueReferencesInVisibleText(page: Page) {
  const visibleText = await page.locator('body').innerText();
  for (const reference of [
    reconciliationReviewId,
    classificationReviewRef,
    subscriptionReviewRef,
    amazonReviewRef,
    amazonParentRef,
  ]) {
    expect(visibleText).not.toContain(reference);
  }
}

for (const scenario of [
  { name: 'desktop', viewport: { width: 1280, height: 900 } },
  { name: '390x844', viewport: { width: 390, height: 844 } },
]) {
  test(`reviews synthetic read-only workflows at ${scenario.name}`, async ({
    browser,
  }) => {
    const page = await browser.newPage({ viewport: scenario.viewport });
    const syntheticApi = createSyntheticApi();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/**', syntheticApi.handle);

    await page.goto('/');
    const credentialInput = page.getByLabel('Owner credential');
    await expect(credentialInput).toBeFocused();
    await signIn(page, 'rejected-synthetic-credential');
    await expect(page.getByRole('status')).toHaveText(
      'Synthetic credential was rejected.',
    );
    await expect(credentialInput).toBeFocused();
    await expect
      .poll(() => consoleErrors)
      .toEqual([
        'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
      ]);
    consoleErrors.length = 0;

    await signIn(page);
    await expect(page.getByRole('status')).toContainText(
      'Loading reconciliation suggestions',
    );
    syntheticApi.releaseFirstReconciliationList();
    await expect(page.getByRole('alert')).toHaveText(
      'Synthetic review service is temporarily busy.',
    );
    await expect
      .poll(() => consoleErrors)
      .toEqual([
        'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      ]);
    consoleErrors.length = 0;
    const retryButton = page.getByRole('button', { name: 'Try again' });
    await expect(retryButton).toBeFocused();
    await page.keyboard.press('Enter');

    const reconciliationLink = page.getByRole('link', {
      name: /Strong synthetic match/,
    });
    await expect(reconciliationLink).toBeFocused();
    await expect(page.getByText(/1 competing suggestion/)).toBeVisible();
    await expectNoOpaqueReferencesInVisibleText(page);
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press('Enter');

    const reconciliationHeading = page.getByRole('heading', {
      name: /Strong synthetic match/,
    });
    await expect(reconciliationHeading).toBeFocused();
    await expect(page.getByText('Transaction comparison')).toBeVisible();
    await expect(page.getByText(/competing suggestion/)).toBeVisible();
    const approveReconciliation = page.getByRole('button', {
      name: 'Approve',
      exact: true,
    });
    await approveReconciliation.focus();
    await page.keyboard.press('Enter');
    const reconciliationConfirmation = page.getByRole('button', {
      name: 'Confirm',
      exact: true,
    });
    await expect(reconciliationConfirmation).toBeFocused();
    await expect(page.getByRole('dialog')).toContainText(
      'It will not change Actual.',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Rechecking Actual before recording your decision',
    );
    syntheticApi.releaseReconciliationDecision();
    const staleReconciliationOutcome = page.getByText(
      /suggestion is stale because Actual changed/,
    );
    await expect(staleReconciliationOutcome).toBeFocused();
    await expect(page.getByText(/no longer available in Actual/)).toBeVisible();

    await page.reload();
    await expect(credentialInput).toBeFocused();
    await signIn(page);
    await expect(staleReconciliationOutcome).toBeVisible();
    await expect(reconciliationHeading).toBeFocused();
    await expect(page).toHaveURL(
      new RegExp(`/reconciliation/${reconciliationReviewId}$`),
    );

    await page
      .getByRole('link', { name: 'Classification', exact: true })
      .click();
    await expect(
      page.getByText(/No merchant or category suggestions/),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page
      .getByRole('link', { name: 'Recurring payments', exact: true })
      .click();
    const subscriptionLink = page.getByRole('link', {
      name: /Synthetic monthly utility/,
    });
    await expect(subscriptionLink).toBeFocused();
    await page.keyboard.press('Enter');
    const subscriptionHeading = page.getByRole('heading', {
      name: 'Synthetic monthly utility',
    });
    await expect(subscriptionHeading).toBeFocused();
    await expect(
      page.getByText(/includes a reconciled transaction/),
    ).toBeVisible();
    await expect(
      page.locator('input[name="subscription-type"]:checked'),
    ).toHaveCount(0);

    const approveSubscription = page.getByRole('button', {
      name: 'Approve selected type',
    });
    await approveSubscription.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(
      'Choose a type before approving.',
    );
    await expect(
      page.getByRole('radio', { name: 'Subscription' }),
    ).toBeFocused();
    const householdBill = page.getByRole('radio', { name: 'Household bill' });
    await householdBill.focus();
    await page.keyboard.press(' ');
    await expect(householdBill).toBeChecked();
    await approveSubscription.focus();
    await page.keyboard.press('Enter');
    const subscriptionConfirmation = page.getByRole('button', {
      name: 'Confirm selected decision',
    });
    await expect(subscriptionConfirmation).toBeFocused();
    await expect(page.getByRole('dialog')).toContainText(
      'It will not create or change a schedule or transaction.',
    );
    await page.keyboard.press('Enter');
    const approvedSubscriptionOutcome = page.getByText(
      /Approval recorded as Household bill/,
    );
    await expect(approvedSubscriptionOutcome).toBeFocused();
    await expect(page.getByText(/Actual was not changed/)).toBeVisible();

    const reopenSubscription = page.getByRole('button', {
      name: 'Reopen candidate',
    });
    await reopenSubscription.focus();
    await page.keyboard.press('Enter');
    await expect(subscriptionConfirmation).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Candidate reopened/)).toBeFocused();
    const deferSubscription = page.getByRole('button', { name: 'Defer' });
    await deferSubscription.focus();
    await page.keyboard.press('Enter');
    await expect(subscriptionConfirmation).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Candidate deferred/)).toBeFocused();
    await expectNoHorizontalOverflow(page);

    await page
      .getByRole('link', { name: 'Classification', exact: true })
      .click();
    const classificationLink = page.getByRole('link', {
      name: /Synthetic grocery category suggestion/,
    });
    await expect(classificationLink).toBeFocused();
    await page.keyboard.press('Enter');
    const classificationHeading = page.getByRole('heading', {
      name: 'Synthetic grocery category suggestion',
    });
    await expect(classificationHeading).toBeFocused();
    const createCategoryRule = page.getByRole('button', {
      name: 'Create category rule in Actual',
    });
    await createCategoryRule.focus();
    await page.keyboard.press('Enter');
    const classificationConfirmation = page.getByRole('button', {
      name: 'Confirm selected decision',
    });
    await expect(classificationConfirmation).toBeFocused();
    await page.keyboard.press('Tab');
    const cancelClassification = page.getByRole('button', { name: 'Cancel' });
    await expect(cancelClassification).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(createCategoryRule).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(classificationConfirmation).toBeFocused();
    await expect(page.getByRole('dialog')).toContainText(
      'will not create a rule or change a transaction',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Decision recorded/)).toBeFocused();
    await expect(page.getByText(/did not change Actual/)).toBeVisible();

    await page.getByRole('link', { name: 'Amazon', exact: true }).click();
    const amazonFileInput = page.getByLabel('Amazon file');
    await expect(amazonFileInput).toBeFocused();
    await expect(
      page.getByText(/No Amazon allocation candidates/),
    ).toBeVisible();
    const amazonFixturePath = path.resolve(
      import.meta.dirname,
      '../src/tests/fixtures/amazon-export-one-order.json',
    );
    await amazonFileInput.setInputFiles(amazonFixturePath);
    await expect(page.getByRole('status')).toHaveText(
      'One file selected. Ready to import.',
    );
    const importButton = page.getByRole('button', {
      name: 'Import and find candidates',
    });
    await importButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Importing Amazon data and checking Actual',
    );
    syntheticApi.releaseAmazonImport();
    const importOutcome = page.getByText(/Import completed/);
    await expect(importOutcome).toBeFocused();
    await expect(importOutcome).toContainText('raw file was discarded');
    await expect(page.locator('body')).not.toContainText(
      'amazon-export-one-order.json',
    );
    await expect(page.locator('body')).not.toContainText('ORDER-1');
    await expectNoOpaqueReferencesInVisibleText(page);

    const amazonLink = page.getByRole('link', {
      name: /Amazon allocation candidate/,
    });
    await amazonLink.focus();
    await page.keyboard.press('Enter');
    const amazonHeading = page
      .getByRole('heading', {
        name: 'Amazon allocation candidate',
        exact: true,
      })
      .last();
    await expect(amazonHeading).toBeFocused();
    await expect(page.getByText(/2 competing candidates/)).toBeVisible();
    await expect(page.getByText('Exact allocation graph')).toBeVisible();
    await expect(page.getByText('Synthetic desk lamp')).toBeVisible();
    await expectNoOpaqueReferencesInVisibleText(page);

    const approveAmazon = page.getByRole('button', {
      name: 'Approve allocation',
    });
    await approveAmazon.focus();
    await page.keyboard.press('Enter');
    const amazonConfirmation = page.getByRole('button', {
      name: 'Confirm selected decision',
    });
    await expect(amazonConfirmation).toBeFocused();
    await expect(page.getByRole('dialog')).toContainText(
      'It will not change Actual or select a competing candidate.',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(
      'Rechecking every Actual parent',
    );
    syntheticApi.releaseAmazonDecision();
    const reconciledAmazonOutcome = page.getByText(
      /Actual parent is now reconciled/,
    );
    await expect(reconciledAmazonOutcome).toBeFocused();
    await expect(page.getByText(/This parent is reconciled/)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('status')).toHaveText('You have signed out.');
    await expect(credentialInput).toBeFocused();

    expect(syntheticApi.unexpectedRequests).toEqual([]);
    const forbiddenEndpoint =
      /\/(actual|holds?|reservations?|receipts?|apply)(?:\/|$)/i;
    expect(
      syntheticApi.observedRequests.filter(request =>
        forbiddenEndpoint.test(request.pathname),
      ),
    ).toEqual([]);
    const allowedWrites = new Set([
      'POST /api/v1/session',
      'DELETE /api/v1/session',
      `POST /api/v1/reconciliation-candidates/${reconciliationReviewId}/decision`,
      `POST /api/v1/classification-reviews/${classificationReviewRef}/decision`,
      `POST /api/v1/subscription-reviews/${subscriptionReviewRef}/decision`,
      'POST /api/v1/imports/amazon',
      `POST /api/v1/amazon-reviews/${amazonReviewRef}/decision`,
    ]);
    for (const request of syntheticApi.observedRequests) {
      if (request.method !== 'GET') {
        expect(allowedWrites).toContain(
          `${request.method} ${request.pathname}`,
        );
      }
    }

    const protectedWrites = syntheticApi.observedRequests.filter(
      request =>
        request.pathname.endsWith('/decision') ||
        request.pathname === '/api/v1/imports/amazon',
    );
    expect(protectedWrites.length).toBe(7);
    for (const request of protectedWrites) {
      expect(request.csrfHeader).toBe(csrfToken);
    }
    const importRequest = protectedWrites.find(
      request => request.pathname === '/api/v1/imports/amazon',
    );
    expect(importRequest?.contentType).toContain('multipart/form-data');
    expect(importRequest?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(importRequest?.jsonBody).toBeNull();
    const decisionBodies = (pathname: string) =>
      syntheticApi.observedRequests
        .filter(request => request.pathname === pathname)
        .map(request => request.jsonBody);
    expect(
      decisionBodies(
        `/api/v1/reconciliation-candidates/${reconciliationReviewId}/decision`,
      ),
    ).toEqual([JSON.stringify({ status: 'approved' })]);
    expect(
      decisionBodies(
        `/api/v1/classification-reviews/${classificationReviewRef}/decision`,
      ),
    ).toEqual([JSON.stringify({ action: 'create_rule', decision: 'approve' })]);
    expect(
      decisionBodies(
        `/api/v1/subscription-reviews/${subscriptionReviewRef}/decision`,
      ),
    ).toEqual([
      JSON.stringify({
        kind: 'approve',
        userSelectedType: 'household_bill',
      }),
      JSON.stringify({ kind: 'reopen' }),
      JSON.stringify({ kind: 'defer' }),
    ]);
    expect(
      decisionBodies(`/api/v1/amazon-reviews/${amazonReviewRef}/decision`),
    ).toEqual([JSON.stringify({ kind: 'approve' })]);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });
}
