import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FinanceCompanionApi,
  focusReconciliationReviewOutcome,
  renderLoading,
} from '#ui/App';
import {
  classificationConfirmationCopy,
  classificationReviewRefFromPath,
  isClassificationReviewDetail,
  renderClassificationDetailBody,
  renderClassificationListBody,
} from '#ui/classification-review';
import type { ClassificationReviewDetail } from '#ui/classification-review';

const pendingCategory: ClassificationReviewDetail = {
  version: 1,
  reviewRef: `classification_${'a'.repeat(43)}`,
  kind: 'category',
  title: 'Transaction category suggestion',
  status: 'pending',
  confidence: 100,
  confidenceLabel: 'Strong confidence',
  reasons: ['This payee and account have a dominant category history'],
  selectedAction: null,
  createdAt: '2026-07-31T12:00:00.000Z',
  decidedAt: null,
  allowedActions: ['categorize_once', 'create_rule'],
  guidance: null,
  evidence: {
    kind: 'category',
    currencyCode: 'USD',
    current: {
      date: '2026-07-30',
      amountMinorUnits: -1250,
      account: 'Checking',
      payee: 'Coffee Payee',
      category: 'Uncategorized',
      state: 'Cleared',
    },
    proposedCategory: 'Dining',
    matchingHistoryCount: 4,
    eligibleHistoryCount: 4,
  },
};

describe('classification review UI', () => {
  it('renders loading, empty, evidence, explicit choices, and no default action', () => {
    expect(renderLoading('Loading classification suggestions')).toContain(
      'aria-busy="true"',
    );
    expect(renderClassificationListBody({ version: 1, reviews: [] })).toContain(
      'No merchant or category suggestions',
    );
    const rendered = renderClassificationDetailBody(pendingCategory);
    expect(rendered).toContain('Categorize once in Actual');
    expect(rendered).toContain('Create category rule in Actual');
    expect(rendered).toContain('Reject suggestion');
    expect(rendered).toContain('There is no automatic or default action.');
    expect(rendered).toContain('-12.50 USD');
    expect(rendered).toContain('<dialog');
    expect(rendered).not.toContain('checked');
    expect(rendered).not.toContain('autofocus');
  });

  it('keeps one-time and rule confirmations meaningfully distinct', () => {
    expect(
      classificationConfirmationCopy(
        pendingCategory,
        'approve',
        'categorize_once',
      ),
    ).toContain('will not categorize the transaction or create a rule');
    expect(
      classificationConfirmationCopy(pendingCategory, 'approve', 'create_rule'),
    ).toContain('will not create a rule or change a transaction');
    expect(
      classificationConfirmationCopy(pendingCategory, 'reject', null),
    ).toContain('record the rejection');
    expect(
      renderClassificationDetailBody({
        ...pendingCategory,
        allowedActions: ['create_rule'],
        kind: 'merchant',
        title: 'Merchant payee suggestion',
        evidence: {
          kind: 'merchant',
          currentPayee: 'Coffee Payee',
          evidenceTransactionCount: 2,
          importedMerchantLabels: ['Coffee Shop'],
          proposedPayee: 'Coffee Payee',
        },
      }),
    ).toContain('Create payee rename rule in Actual');
  });

  it('renders stale and successful guidance as focusable live outcomes', () => {
    const approved = renderClassificationDetailBody({
      ...pendingCategory,
      allowedActions: [],
      decidedAt: '2026-07-31T12:01:00.000Z',
      guidance:
        'Open Actual manually. Finance Companion did not change Actual.',
      selectedAction: 'categorize_once',
      status: 'approved',
    });
    expect(approved).toContain('data-decision-outcome');
    expect(approved).toContain('tabindex="-1"');
    expect(approved).toContain('Finance Companion did not change Actual');
    expect(
      renderClassificationDetailBody({
        ...pendingCategory,
        allowedActions: [],
        status: 'stale',
      }),
    ).toContain('stale because Actual changed');

    const focus = vi.fn();
    focusReconciliationReviewOutcome(selector =>
      selector === '[data-decision-outcome]' ? { focus } : null,
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it('supports restorable encoded detail routes and validates closed DTOs', () => {
    expect(classificationReviewRefFromPath('/classification')).toBeNull();
    expect(
      classificationReviewRefFromPath(
        '/classification/classification_stable-reference',
      ),
    ).toBe('classification_stable-reference');
    expect(isClassificationReviewDetail(pendingCategory)).toBe(true);
    expect(
      isClassificationReviewDetail({
        ...pendingCategory,
        allowedActions: ['hidden_default'],
      }),
    ).toBe(false);
  });

  it('sends the explicit action with the shared CSRF-protected API', async () => {
    const requests: [string, RequestInit | undefined][] = [];
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        requests.push([url, init]);
        if (url === '/api/v1/session') {
          return Response.json(
            { csrfToken: 'synthetic-csrf' },
            { status: 201 },
          );
        }
        return Response.json({
          ...pendingCategory,
          allowedActions: [],
          decidedAt: '2026-07-31T12:01:00.000Z',
          guidance: 'Manual guidance. Finance Companion did not change Actual.',
          selectedAction: 'create_rule',
          status: 'approved',
        });
      },
    );
    const api = new FinanceCompanionApi(request);
    await api.login('synthetic-credential');
    await api.decideClassificationReview(
      pendingCategory.reviewRef,
      'approve',
      'create_rule',
    );

    expect(requests[1]?.[1]?.headers).toMatchObject({
      'x-finance-csrf': 'synthetic-csrf',
    });
    expect(JSON.parse(String(requests[1]?.[1]?.body))).toEqual({
      action: 'create_rule',
      decision: 'approve',
    });
  });

  it('keeps the shared evidence and shell responsive at narrow widths', async () => {
    const css = await readFile(
      path.resolve(import.meta.dirname, '../ui/styles.css'),
      'utf8',
    );
    expect(css).toContain('@media (max-width: 30rem)');
    expect(css).toMatch(/\.evidence-grid\s*{\s*grid-template-columns: 1fr;/);
    expect(css).toContain('flex-wrap: wrap');
  });
});
