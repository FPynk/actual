import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  amazonConfirmationCopy,
  amazonReviewRefFromPath,
  isAmazonImportResult,
  isAmazonReviewDetail,
  renderAmazonDetailBody,
  renderAmazonListBody,
} from '#ui/amazon-review';
import type { AmazonImportResult, AmazonReviewDetail } from '#ui/amazon-review';
import { FinanceCompanionApi, renderLoading } from '#ui/App';

const pendingReview: AmazonReviewDetail = {
  version: 1,
  reviewRef: `amazon_${'a'.repeat(43)}`,
  status: 'pending',
  score: 90,
  parentCount: 1,
  allocationCount: 2,
  competingCandidateCount: 2,
  createdAt: '2026-01-03T00:00:00.000Z',
  decidedAt: null,
  currencyCode: 'USD',
  allowedActions: ['approve', 'reject', 'defer'],
  reasons: ['Every parent is explained by an exact signed allocation'],
  staleReason: null,
  parents: [
    {
      parentRef: `parent_${'b'.repeat(43)}`,
      date: '2026-01-02',
      amountMinorUnits: -1_080,
      account: 'Card & savings',
      payee: '<img src=x onerror=alert(1)>',
      category: 'Shopping <script>alert(1)</script>',
      reconciled: false,
      competingCandidateCount: 2,
      allocations: [
        {
          kind: 'merchandise',
          amountMinorUnits: -1_000,
          itemTitle: '<script>private title</script>',
          proposedCategory: null,
        },
        {
          kind: 'tax',
          amountMinorUnits: -80,
          itemTitle: 'Synthetic item',
          proposedCategory: 'Household & goods',
        },
      ],
    },
  ],
  guidance: null,
};

const importResult: AmazonImportResult = {
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

describe('Amazon review UI', () => {
  it('renders upload loading, empty, success, and error states without exposing a filename', () => {
    expect(renderLoading('Importing Amazon data')).toContain(
      'aria-busy="true"',
    );
    const empty = renderAmazonListBody({ version: 1, reviews: [] });
    expect(empty).toContain('type="file"');
    expect(empty).toContain('.json,.eml');
    expect(empty).toContain('No file selected');
    expect(empty).toContain('No Amazon allocation candidates');

    const success = renderAmazonListBody(
      { version: 1, reviews: [] },
      importResult,
    );
    expect(success).toContain('Import completed');
    expect(success).toContain('3 accepted, 0 rejected');
    expect(success).toContain('raw file was discarded');
    expect(success).not.toContain('amazon-export.json');

    const error = renderAmazonListBody(
      { version: 1, reviews: [] },
      undefined,
      '<private error>',
    );
    expect(error).toContain('&lt;private error&gt;');
    expect(error).not.toContain('<private error>');
  });

  it('keeps summaries generic and renders exact detail, competing, explicit-confirmation, and XSS-safe states', () => {
    const list = renderAmazonListBody({
      version: 1,
      reviews: [pendingReview],
    });
    expect(list).toContain('Amazon allocation candidate');
    expect(list).toContain('2 competing candidates');
    expect(list).not.toContain('private title');
    expect(list).not.toContain('actual-parent');

    const detail = renderAmazonDetailBody(pendingReview);
    expect(detail).toContain('Exact allocation graph');
    expect(detail).toContain('-10.80 USD');
    expect(detail).toContain('-10.00 USD');
    expect(detail).toContain('-0.80 USD');
    expect(detail).toContain('&lt;script&gt;private title&lt;/script&gt;');
    expect(detail).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(detail).toContain('Card &amp; savings');
    expect(detail).not.toContain('<script>private title</script>');
    expect(detail).toContain('Approve allocation');
    expect(detail).toContain('Defer');
    expect(detail).toContain('Reject');
    expect(detail).toContain('There is no automatic or default action.');
    expect(detail).not.toContain('checked');
    expect(detail).not.toContain('autofocus');
  });

  it('renders approved, deferred, rejected, reopened, stale, and reconciled outcomes', () => {
    expect(
      renderAmazonDetailBody({
        ...pendingReview,
        status: 'approved',
        allowedActions: ['reopen'],
        guidance: 'Review manually. Finance Companion did not change Actual.',
      }),
    ).toContain('Approval recorded');
    expect(
      renderAmazonDetailBody({
        ...pendingReview,
        status: 'deferred',
        allowedActions: ['reopen'],
      }),
    ).toContain('Candidate deferred');
    expect(
      renderAmazonDetailBody({
        ...pendingReview,
        status: 'rejected',
        allowedActions: ['reopen'],
      }),
    ).toContain('Candidate rejected');
    expect(renderAmazonDetailBody(pendingReview, 'reopen')).toContain(
      'Candidate reopened',
    );
    expect(
      renderAmazonDetailBody({
        ...pendingReview,
        status: 'stale',
        staleReason: 'changed',
        allowedActions: [],
      }),
    ).toContain('Actual parent changed');
    expect(
      renderAmazonDetailBody({
        ...pendingReview,
        status: 'stale',
        staleReason: 'reconciled',
        allowedActions: [],
        parents: [{ ...pendingReview.parents[0]!, reconciled: true }],
      }),
    ).toContain('Actual parent is now reconciled');
  });

  it('uses closed routes, DTOs, and distinct confirmation copy', () => {
    expect(amazonReviewRefFromPath('/amazon')).toBeNull();
    expect(amazonReviewRefFromPath('/amazon/amazon_stable-reference')).toBe(
      'amazon_stable-reference',
    );
    expect(isAmazonReviewDetail(pendingReview)).toBe(true);
    expect(
      isAmazonReviewDetail({
        ...pendingReview,
        allowedActions: ['apply_to_actual'],
      }),
    ).toBe(false);
    expect(isAmazonImportResult(importResult)).toBe(true);
    expect(amazonConfirmationCopy({ kind: 'approve' })).toContain(
      'manual guidance only',
    );
    expect(amazonConfirmationCopy({ kind: 'reject' })).toContain(
      'without changing Actual',
    );
    expect(amazonConfirmationCopy({ kind: 'defer' })).toContain('later review');
    expect(amazonConfirmationCopy({ kind: 'reopen' })).toContain(
      'clear the prior decision',
    );
  });

  it('sends an exact selected decision through the shared CSRF API', async () => {
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
          status: 'approved',
          allowedActions: ['reopen'],
          guidance: 'Manual guidance only. Actual was not changed.',
        });
      },
    );
    const api = new FinanceCompanionApi(request);
    await api.login('synthetic-credential');
    await api.decideAmazonReview(pendingReview.reviewRef, { kind: 'approve' });

    expect(requests[1]?.[1]?.headers).toMatchObject({
      'x-finance-csrf': 'synthetic-csrf',
    });
    expect(JSON.parse(String(requests[1]?.[1]?.body))).toEqual({
      kind: 'approve',
    });
  });

  it('keeps uploads and allocation evidence responsive', async () => {
    const css = await readFile(
      path.resolve(import.meta.dirname, '../ui/styles.css'),
      'utf8',
    );
    expect(css).toContain('@media (max-width: 30rem)');
    expect(css).toContain('.upload-panel');
    expect(css).toContain('.amazon-parent-list');
    expect(css).toMatch(
      /\.allocation-list li\s*{\s*align-items: flex-start;\s*flex-direction: column;/,
    );
  });
});
