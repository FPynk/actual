import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FinanceCompanionApi,
  focusReconciliationReviewOutcome,
  renderLoading,
} from '#ui/App';
import {
  isSubscriptionReviewDetail,
  renderSubscriptionDetailBody,
  renderSubscriptionListBody,
  subscriptionConfirmationCopy,
  subscriptionReviewRefFromPath,
} from '#ui/subscription-review';
import type { SubscriptionReviewDetail } from '#ui/subscription-review';

const pendingReview: SubscriptionReviewDetail = {
  version: 1,
  reviewRef: `subscription_${'a'.repeat(43)}`,
  title: '<img src=x onerror=alert(1)> recurring payment',
  status: 'pending',
  cadence: 'Monthly',
  confidence: 85,
  selectedType: null,
  hasExistingSchedule: true,
  evaluatedAt: '2026-04-30T12:00:00.000Z',
  decidedAt: null,
  allowedActions: ['approve', 'defer', 'reject'],
  reasons: [
    'Payments recur on a monthly cadence',
    'The most recent payment has a material price change',
    'One expected payment appears to be missing',
  ],
  evidence: {
    currencyCode: 'USD',
    account: 'Checking & savings',
    payee: '<script>alert(1)</script>',
    cadence: 'Monthly',
    occurrenceCount: 4,
    firstDate: '2026-01-15',
    lastDate: '2026-04-15',
    medianAmountMinorUnits: 1_000,
    amountVarianceBasisPoints: 500,
    dateVarianceDays: 2,
    recentPriceChangeBasisPoints: 2_000,
    hasReconciledHistory: true,
    scheduleAssociation: 'existing',
  },
  guidance: null,
};

describe('subscription review UI', () => {
  it('renders loading, empty, evidence, explicit types, and no default choice', () => {
    expect(renderLoading('Loading recurring payment candidates')).toContain(
      'aria-busy="true"',
    );
    expect(renderSubscriptionListBody({ version: 1, reviews: [] })).toContain(
      'No recurring payment candidates',
    );

    const rendered = renderSubscriptionDetailBody(pendingReview);
    expect(rendered).toContain('Subscription');
    expect(rendered).toContain('Household bill');
    expect(rendered).toContain('Financial bill');
    expect(rendered).toContain('Recurring payment, not classified');
    expect(rendered).toContain('Approve selected type');
    expect(rendered).toContain('Defer');
    expect(rendered).toContain('Reject');
    expect(rendered).toContain('There is no automatic or default action.');
    expect(rendered).toContain('10.00 USD');
    expect(rendered).toContain('5.00%');
    expect(rendered).toContain('20.00% recent change');
    expect(rendered).toContain('One current exact match');
    expect(rendered).toContain('includes a reconciled transaction');
    expect(rendered).not.toContain('checked');
    expect(rendered).not.toContain('autofocus');
  });

  it('escapes every dynamic label and renders each durable state', () => {
    const pending = renderSubscriptionDetailBody(pendingReview);
    expect(pending).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(pending).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pending).toContain('Checking &amp; savings');
    expect(pending).not.toContain('<script>alert(1)</script>');

    const approved = renderSubscriptionDetailBody({
      ...pendingReview,
      allowedActions: ['reopen'],
      decidedAt: '2026-04-30T12:01:00.000Z',
      guidance:
        'Review Actual. Finance Companion did not change a schedule or transaction.',
      selectedType: 'household_bill',
      status: 'approved',
    });
    expect(approved).toContain('Approval recorded as Household bill');
    expect(approved).toContain('Reopen candidate');
    expect(approved).toContain('data-decision-outcome');
    expect(approved).toContain('tabindex="-1"');

    expect(
      renderSubscriptionDetailBody({
        ...pendingReview,
        allowedActions: ['reopen'],
        status: 'deferred',
      }),
    ).toContain('Candidate deferred');
    expect(
      renderSubscriptionDetailBody({
        ...pendingReview,
        allowedActions: ['reopen'],
        status: 'rejected',
      }),
    ).toContain('suppressed for this detector version');
    expect(
      renderSubscriptionDetailBody({
        ...pendingReview,
        allowedActions: [],
        evidence: {
          ...pendingReview.evidence,
          scheduleAssociation: 'stale',
        },
        status: 'stale',
      }),
    ).toContain('history or linked schedule changed');
    expect(renderSubscriptionDetailBody(pendingReview, 'reopen')).toContain(
      'Candidate reopened',
    );
  });

  it('uses distinct confirmations and preserves dialog focus affordances', () => {
    expect(
      subscriptionConfirmationCopy({
        kind: 'approve',
        userSelectedType: 'unknown',
      }),
    ).toContain('guidance only');
    expect(subscriptionConfirmationCopy({ kind: 'defer' })).toContain(
      'keep it out of the pending queue',
    );
    expect(subscriptionConfirmationCopy({ kind: 'reject' })).toContain(
      'suppress this detector version',
    );
    expect(subscriptionConfirmationCopy({ kind: 'reopen' })).toContain(
      'clear the prior choice',
    );
    const rendered = renderSubscriptionDetailBody(pendingReview);
    expect(rendered).toContain('data-cancel-decision');
    expect(rendered).toContain('data-confirm-decision');

    const focus = vi.fn();
    focusReconciliationReviewOutcome(selector =>
      selector === '[data-decision-outcome]' ? { focus } : null,
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it('supports reloadable detail routes and validates the closed DTO', () => {
    expect(subscriptionReviewRefFromPath('/subscriptions')).toBeNull();
    expect(
      subscriptionReviewRefFromPath(
        '/subscriptions/subscription_stable-reference',
      ),
    ).toBe('subscription_stable-reference');
    expect(isSubscriptionReviewDetail(pendingReview)).toBe(true);
    expect(
      isSubscriptionReviewDetail({
        ...pendingReview,
        allowedActions: ['automatic_schedule_write'],
      }),
    ).toBe(false);
  });

  it('sends the exact selected action through the shared CSRF API', async () => {
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
          ...pendingReview,
          allowedActions: ['reopen'],
          decidedAt: '2026-04-30T12:01:00.000Z',
          guidance: 'Guidance only. Actual was not changed.',
          selectedType: 'financial_bill',
          status: 'approved',
        });
      },
    );
    const api = new FinanceCompanionApi(request);
    await api.login('synthetic-credential');
    await api.decideSubscriptionReview(pendingReview.reviewRef, {
      kind: 'approve',
      userSelectedType: 'financial_bill',
    });

    expect(requests[1]?.[1]?.headers).toMatchObject({
      'x-finance-csrf': 'synthetic-csrf',
    });
    expect(JSON.parse(String(requests[1]?.[1]?.body))).toEqual({
      kind: 'approve',
      userSelectedType: 'financial_bill',
    });
  });

  it('keeps evidence, type choices, and navigation responsive', async () => {
    const css = await readFile(
      path.resolve(import.meta.dirname, '../ui/styles.css'),
      'utf8',
    );
    expect(css).toContain('@media (max-width: 30rem)');
    expect(css).toMatch(/\.evidence-grid\s*{\s*grid-template-columns: 1fr;/);
    expect(css).toContain('.subscription-types');
    expect(css).toContain('flex-wrap: wrap');
  });
});
