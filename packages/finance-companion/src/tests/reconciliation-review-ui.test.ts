import {
  FinanceCompanionApi,
  focusReconciliationReviewOutcome,
  formatMinorUnits,
  reconciliationReviewIdFromPath,
  renderFinanceCompanionLoginShell,
  renderLoading,
  renderReconciliationDetail,
  renderReconciliationList,
} from '#ui/App';

const pending = {
  version: 1 as const,
  reviewId: 'review-1',
  status: 'pending' as const,
  score: 80,
  confidence: 'Likely match',
  reasons: ['Account matches exactly'],
  competingCandidateCount: 1,
  createdAt: '2026-07-31T12:00:00.000Z',
  decidedAt: null,
  evidence: {
    currencyCode: 'USD',
    source: {
      date: '2026-07-30',
      amountMinorUnits: 1250,
      merchant: 'Synthetic bank merchant',
      accountName: 'Synthetic checking',
      state: 'Posted' as const,
    },
    actual: {
      date: '2026-07-30',
      amountMinorUnits: 1250,
      merchant: 'Synthetic Actual merchant',
      accountName: 'Synthetic checking',
      state: 'Cleared' as const,
    },
  },
};

describe('reconciliation review UI', () => {
  it('invokes the default browser fetch with the global receiver', async () => {
    const receiverSensitiveFetch = vi.fn(function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(
        Response.json({ csrfToken: 'synthetic-csrf' }, { status: 201 }),
      );
    });
    vi.stubGlobal('fetch', receiverSensitiveFetch);
    try {
      await new FinanceCompanionApi().login('synthetic-credential');
      expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('formats integer minor units with ISO currency fraction digits', () => {
    expect(formatMinorUnits(1250, 'USD')).toBe('12.50 USD');
    expect(formatMinorUnits(-1250, 'USD')).toBe('-12.50 USD');
    expect(formatMinorUnits(1250, 'JPY')).toBe('1250 JPY');
    expect(formatMinorUnits(1250, 'INVALID')).toBe(
      '1250 minor units (INVALID)',
    );
  });

  it('renders sign-in, loading, empty, competing, stale, and approval guidance states', () => {
    expect(renderFinanceCompanionLoginShell()).toContain('type="submit"');
    expect(renderLoading('Loading')).toContain('aria-busy="true"');
    expect(renderReconciliationList({ version: 1, candidates: [] })).toContain(
      'No reconciliation suggestions',
    );
    expect(renderReconciliationDetail(pending)).toContain(
      'competing suggestion',
    );
    expect(renderReconciliationDetail(pending)).toContain(
      'Synthetic bank merchant',
    );
    expect(renderReconciliationDetail(pending)).toContain('12.50 USD');
    expect(renderReconciliationDetail(pending)).not.toContain('1250 USD');
    expect(
      renderReconciliationDetail({ ...pending, status: 'stale' }),
    ).toContain('stale');
    expect(
      renderReconciliationDetail({
        ...pending,
        status: 'approved',
        decidedAt: '2026-07-31T12:01:00.000Z',
      }),
    ).toContain('data-decision-outcome');
  });

  it('restores a detail route after login and focuses a replaced decision outcome', () => {
    expect(reconciliationReviewIdFromPath('/reconciliation')).toBeNull();
    expect(
      reconciliationReviewIdFromPath('/reconciliation/review_stable-reference'),
    ).toBe('review_stable-reference');
    const outcomeFocus = vi.fn();
    const headingFocus = vi.fn();
    const findFocusable = vi.fn((selector: string) =>
      selector === '[data-decision-outcome]'
        ? { focus: outcomeFocus }
        : { focus: headingFocus },
    );
    focusReconciliationReviewOutcome(findFocusable);
    expect(findFocusable).toHaveBeenCalledOnce();
    expect(findFocusable).toHaveBeenCalledWith('[data-decision-outcome]');
    expect(outcomeFocus).toHaveBeenCalledOnce();
    expect(headingFocus).not.toHaveBeenCalled();
    const fallbackFocus = vi.fn();
    const findFallback = vi.fn((selector: string) =>
      selector === '#review-title' ? { focus: fallbackFocus } : null,
    );
    focusReconciliationReviewOutcome(findFallback);
    expect(findFallback.mock.calls.map(([selector]) => selector)).toEqual([
      '[data-decision-outcome]',
      '#review-title',
    ]);
    expect(fallbackFocus).toHaveBeenCalledOnce();
    expect(
      renderReconciliationDetail({
        ...pending,
        status: 'stale',
        evidence: { ...pending.evidence, actual: null },
      }),
    ).toContain('tabindex="-1" data-decision-outcome');
  });

  it('keeps the CSRF token in the API instance for authenticated decisions and logout', async () => {
    const requests: [string, RequestInit | undefined][] = [];
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requests.push([url, init]);
        if (url === '/api/v1/session' && init?.method === 'POST') {
          return Response.json(
            { csrfToken: 'synthetic-csrf' },
            { status: 201 },
          );
        }
        if (url.endsWith('/decision')) {
          return Response.json({
            ...pending,
            status: 'approved',
            decidedAt: '2026-07-31T12:01:00.000Z',
          });
        }
        return new Response(null, { status: 204 });
      },
    );
    const api = new FinanceCompanionApi(request);
    await api.login('synthetic-credential');
    await api.decide('review-1', 'approved');
    await api.logout();
    expect(requests[1]?.[1]?.headers).toMatchObject({
      'x-finance-csrf': 'synthetic-csrf',
    });
    expect(requests[2]?.[1]?.headers).toMatchObject({
      'x-finance-csrf': 'synthetic-csrf',
    });
  });
});
