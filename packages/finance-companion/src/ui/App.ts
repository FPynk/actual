import './styles.css';
import {
  amazonConfirmationCopy,
  amazonReviewRefFromPath,
  isAmazonImportResult,
  isAmazonReviewDetail,
  isAmazonReviewList,
  renderAmazonDetailBody,
  renderAmazonListBody,
} from './amazon-review.ts';
import type {
  AmazonImportResult,
  AmazonReviewAction,
  AmazonReviewDetail,
  AmazonReviewList,
} from './amazon-review.ts';
import {
  classificationConfirmationCopy,
  classificationReviewRefFromPath,
  isClassificationReviewDetail,
  isClassificationReviewList,
  renderClassificationDetailBody,
  renderClassificationListBody,
} from './classification-review.ts';
import type {
  ClassificationReviewAction,
  ClassificationReviewDetail,
  ClassificationReviewList,
} from './classification-review.ts';
import { formatMinorUnits } from './format.ts';
import {
  isSubscriptionReviewDetail,
  isSubscriptionReviewList,
  renderSubscriptionDetailBody,
  renderSubscriptionListBody,
  subscriptionConfirmationCopy,
  subscriptionReviewRefFromPath,
} from './subscription-review.ts';
import type {
  SubscriptionCandidateType,
  SubscriptionReviewAction,
  SubscriptionReviewDetail,
  SubscriptionReviewList,
} from './subscription-review.ts';

export { formatMinorUnits } from './format.ts';

export type ReconciliationReviewCandidate = Readonly<{
  version: 1;
  reviewId: string;
  status: 'pending' | 'approved' | 'rejected' | 'stale' | 'superseded';
  score: number;
  confidence: string;
  reasons: readonly string[];
  competingCandidateCount: number;
  createdAt: string;
  decidedAt: string | null;
  evidence: ReconciliationReviewEvidence | null;
}>;

type ReconciliationReviewEvidence = Readonly<{
  currencyCode: string;
  source: ReconciliationTransactionEvidence &
    Readonly<{ state: 'Unknown' | 'Pending' | 'Posted' }>;
  actual:
    | (ReconciliationTransactionEvidence &
        Readonly<{ state: 'Cleared' | 'Uncleared' }>)
    | null;
}>;

type ReconciliationTransactionEvidence = Readonly<{
  date: string;
  amountMinorUnits: number;
  merchant: string;
  accountName: string;
}>;

type ReconciliationReviewList = Readonly<{
  version: 1;
  candidates: readonly ReconciliationReviewCandidate[];
}>;

type Session = Readonly<{ csrfToken: string }>;
export type FinanceCompanionFetch = typeof fetch;

export class FinanceCompanionApi {
  private session: Session | null = null;
  private readonly request: FinanceCompanionFetch;

  constructor(request: FinanceCompanionFetch = requestWithBrowserFetch) {
    this.request = request;
  }

  async login(credential: string): Promise<void> {
    const response = await this.request(
      '/api/v1/session',
      jsonRequest('POST', { credential }),
    );
    const body = await readJson(response);
    if (!response.ok || !isSession(body)) throw new Error(readProblem(body));
    this.session = { csrfToken: body.csrfToken };
  }

  async logout(): Promise<void> {
    if (this.session === null) return;
    const response = await this.request('/api/v1/session', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'x-finance-csrf': this.session.csrfToken },
    });
    this.session = null;
    if (!response.ok) throw new Error('Unable to sign out.');
  }

  async listCandidates(): Promise<ReconciliationReviewList> {
    return this.getJson('/api/v1/reconciliation-candidates', isReviewList);
  }

  async readCandidate(
    reviewId: string,
  ): Promise<ReconciliationReviewCandidate> {
    return this.getJson(
      `/api/v1/reconciliation-candidates/${encodeURIComponent(reviewId)}`,
      isCandidate,
    );
  }

  async decide(
    reviewId: string,
    status: 'approved' | 'rejected',
  ): Promise<ReconciliationReviewCandidate> {
    if (this.session === null) {
      throw new Error('Your session has ended. Please sign in again.');
    }
    const response = await this.request(
      `/api/v1/reconciliation-candidates/${encodeURIComponent(reviewId)}/decision`,
      jsonRequest('POST', { status }, this.session.csrfToken),
    );
    const body = await readJson(response);
    if (!response.ok || !isCandidate(body)) throw new Error(readProblem(body));
    return body;
  }

  async listClassificationReviews(): Promise<ClassificationReviewList> {
    return this.getJson(
      '/api/v1/classification-reviews',
      isClassificationReviewList,
    );
  }

  async readClassificationReview(
    reviewRef: string,
  ): Promise<ClassificationReviewDetail> {
    return this.getJson(
      `/api/v1/classification-reviews/${encodeURIComponent(reviewRef)}`,
      isClassificationReviewDetail,
    );
  }

  async decideClassificationReview(
    reviewRef: string,
    decision: 'approve' | 'reject',
    action: ClassificationReviewAction | null,
  ): Promise<ClassificationReviewDetail> {
    if (this.session === null) {
      throw new Error('Your session has ended. Please sign in again.');
    }
    const response = await this.request(
      `/api/v1/classification-reviews/${encodeURIComponent(reviewRef)}/decision`,
      jsonRequest(
        'POST',
        decision === 'approve' ? { action, decision } : { decision },
        this.session.csrfToken,
      ),
    );
    const body = await readJson(response);
    if (!response.ok || !isClassificationReviewDetail(body)) {
      throw new Error(readProblem(body));
    }
    return body;
  }

  async listSubscriptionReviews(): Promise<SubscriptionReviewList> {
    return this.getJson(
      '/api/v1/subscription-reviews',
      isSubscriptionReviewList,
    );
  }

  async readSubscriptionReview(
    reviewRef: string,
  ): Promise<SubscriptionReviewDetail> {
    return this.getJson(
      `/api/v1/subscription-reviews/${encodeURIComponent(reviewRef)}`,
      isSubscriptionReviewDetail,
    );
  }

  async decideSubscriptionReview(
    reviewRef: string,
    action: SubscriptionReviewAction,
  ): Promise<SubscriptionReviewDetail> {
    if (this.session === null) {
      throw new Error('Your session has ended. Please sign in again.');
    }
    const response = await this.request(
      `/api/v1/subscription-reviews/${encodeURIComponent(reviewRef)}/decision`,
      jsonRequest('POST', action, this.session.csrfToken),
    );
    const body = await readJson(response);
    if (!response.ok || !isSubscriptionReviewDetail(body)) {
      throw new Error(readProblem(body));
    }
    return body;
  }

  async listAmazonReviews(): Promise<AmazonReviewList> {
    return this.getJson('/api/v1/amazon-reviews', isAmazonReviewList);
  }

  async readAmazonReview(reviewRef: string): Promise<AmazonReviewDetail> {
    return this.getJson(
      `/api/v1/amazon-reviews/${encodeURIComponent(reviewRef)}`,
      isAmazonReviewDetail,
    );
  }

  async decideAmazonReview(
    reviewRef: string,
    action: AmazonReviewAction,
  ): Promise<AmazonReviewDetail> {
    if (this.session === null) {
      throw new Error('Your session has ended. Please sign in again.');
    }
    const response = await this.request(
      `/api/v1/amazon-reviews/${encodeURIComponent(reviewRef)}/decision`,
      jsonRequest('POST', action, this.session.csrfToken),
    );
    const body = await readJson(response);
    if (!response.ok || !isAmazonReviewDetail(body)) {
      throw new Error(readProblem(body));
    }
    return body;
  }

  async importAmazonFile(file: File): Promise<AmazonImportResult> {
    if (this.session === null) {
      throw new Error('Your session has ended. Please sign in again.');
    }
    const extension = file.name.toLowerCase().endsWith('.json')
      ? 'json'
      : file.name.toLowerCase().endsWith('.eml')
        ? 'eml'
        : null;
    if (extension === null) {
      throw new Error('Choose a supported .json export or .eml message.');
    }
    const form = new FormData();
    form.append(
      'file',
      new Blob([file], {
        type: extension === 'json' ? 'application/json' : 'message/rfc822',
      }),
      extension === 'json' ? 'amazon-export.json' : 'amazon-message.eml',
    );
    const response = await this.request('/api/v1/imports/amazon', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'idempotency-key': globalThis.crypto.randomUUID(),
        'x-finance-csrf': this.session.csrfToken,
      },
      body: form,
    });
    const body = await readJson(response);
    if (!response.ok || !isAmazonImportResult(body)) {
      throw new Error(readProblem(body));
    }
    return body;
  }

  private async getJson<T>(
    url: string,
    valid: (value: unknown) => value is T,
  ): Promise<T> {
    const response = await this.request(url, { credentials: 'same-origin' });
    const body = await readJson(response);
    if (!response.ok || !valid(body)) throw new Error(readProblem(body));
    return body;
  }
}

const requestWithBrowserFetch: FinanceCompanionFetch = (input, init) =>
  globalThis.fetch(input, init);

export function mountFinanceCompanionApplication(
  root: HTMLElement,
  api = new FinanceCompanionApi(),
): void {
  const renderLogin = (message = '') => {
    root.innerHTML = renderFinanceCompanionLoginShell(message);
    const form = root.querySelector<HTMLFormElement>('form');
    const credential =
      root.querySelector<HTMLInputElement>('#owner-credential');
    form?.addEventListener('submit', event => {
      event.preventDefault();
      const value = credential?.value ?? '';
      if (value === '') {
        renderLogin('Enter your owner credential.');
        root.querySelector<HTMLInputElement>('#owner-credential')?.focus();
        return;
      }
      void api
        .login(value)
        .then(renderAuthenticatedRoute, error =>
          renderLogin(errorMessage(error)),
        );
    });
    credential?.focus();
  };
  const renderList = () => {
    root.innerHTML = renderLoading('Loading reconciliation suggestions…');
    void api.listCandidates().then(
      list => {
        root.innerHTML = renderReconciliationList(list);
        bindPage(root, api, renderList, renderDetail);
        root.querySelector<HTMLAnchorElement>('[data-review-link]')?.focus();
      },
      error => renderError(root, error, renderList),
    );
  };
  const renderDetail = (reviewId: string) => {
    root.innerHTML = renderLoading('Loading reconciliation suggestion…');
    void api.readCandidate(reviewId).then(
      candidate => {
        root.innerHTML = renderReconciliationDetail(candidate);
        bindPage(root, api, renderList, renderDetail, candidate);
        root.querySelector<HTMLElement>('#review-title')?.focus();
      },
      error => renderError(root, error, renderList),
    );
  };
  const renderClassificationList = () => {
    root.innerHTML = renderLoading('Loading classification suggestions…');
    void api.listClassificationReviews().then(
      list => {
        root.innerHTML = reviewLayout(
          'Classification review',
          renderClassificationListBody(list),
          'classification',
        );
        bindClassificationPage(
          root,
          api,
          renderClassificationList,
          renderClassificationDetail,
        );
        root
          .querySelector<HTMLAnchorElement>('[data-classification-link]')
          ?.focus();
      },
      error => renderError(root, error, renderClassificationList),
    );
  };
  const renderClassificationDetail = (reviewRef: string) => {
    root.innerHTML = renderLoading('Loading classification suggestion…');
    void api.readClassificationReview(reviewRef).then(
      review => {
        root.innerHTML = reviewLayout(
          'Classification suggestion',
          renderClassificationDetailBody(review),
          'classification',
        );
        bindClassificationPage(
          root,
          api,
          renderClassificationList,
          renderClassificationDetail,
          review,
        );
        root.querySelector<HTMLElement>('#review-title')?.focus();
      },
      error => renderError(root, error, renderClassificationList),
    );
  };
  const renderSubscriptionList = () => {
    root.innerHTML = renderLoading('Loading recurring payment candidates…');
    void api.listSubscriptionReviews().then(
      list => {
        root.innerHTML = reviewLayout(
          'Recurring payment review',
          renderSubscriptionListBody(list),
          'subscriptions',
        );
        bindSubscriptionPage(
          root,
          api,
          renderSubscriptionList,
          renderSubscriptionDetail,
        );
        root
          .querySelector<HTMLAnchorElement>('[data-subscription-link]')
          ?.focus();
      },
      error => renderError(root, error, renderSubscriptionList),
    );
  };
  const renderSubscriptionDetail = (reviewRef: string) => {
    root.innerHTML = renderLoading('Loading recurring payment candidate…');
    void api.readSubscriptionReview(reviewRef).then(
      review => {
        root.innerHTML = reviewLayout(
          'Recurring payment candidate',
          renderSubscriptionDetailBody(review),
          'subscriptions',
        );
        bindSubscriptionPage(
          root,
          api,
          renderSubscriptionList,
          renderSubscriptionDetail,
          review,
        );
        root.querySelector<HTMLElement>('#review-title')?.focus();
      },
      error => renderError(root, error, renderSubscriptionList),
    );
  };
  const renderAmazonList = (
    importResult?: AmazonImportResult,
    importError?: string,
  ) => {
    root.innerHTML = renderLoading('Loading Amazon allocation candidates...');
    void api.listAmazonReviews().then(
      list => {
        root.innerHTML = reviewLayout(
          'Amazon review',
          renderAmazonListBody(list, importResult, importError),
          'amazon',
        );
        bindAmazonPage(root, api, renderAmazonList, renderAmazonDetail, list);
        const outcome = root.querySelector<HTMLElement>(
          '[data-upload-outcome]',
        );
        if (outcome !== null) outcome.focus();
        else root.querySelector<HTMLInputElement>('#amazon-file')?.focus();
      },
      error => renderError(root, error, () => renderAmazonList()),
    );
  };
  const renderAmazonDetail = (reviewRef: string) => {
    root.innerHTML = renderLoading('Loading Amazon allocation candidate...');
    void api.readAmazonReview(reviewRef).then(
      review => {
        root.innerHTML = reviewLayout(
          'Amazon allocation candidate',
          renderAmazonDetailBody(review),
          'amazon',
        );
        bindAmazonPage(
          root,
          api,
          renderAmazonList,
          renderAmazonDetail,
          undefined,
          review,
        );
        root.querySelector<HTMLElement>('#review-title')?.focus();
      },
      error => renderError(root, error, () => renderAmazonList()),
    );
  };
  const renderAuthenticatedRoute = () => {
    if (window.location.pathname.startsWith('/amazon')) {
      const reviewRef = amazonReviewRefFromPath(window.location.pathname);
      if (reviewRef === null) renderAmazonList();
      else renderAmazonDetail(reviewRef);
      return;
    }
    if (window.location.pathname.startsWith('/subscriptions')) {
      const reviewRef = subscriptionReviewRefFromPath(window.location.pathname);
      if (reviewRef === null) renderSubscriptionList();
      else renderSubscriptionDetail(reviewRef);
      return;
    }
    if (window.location.pathname.startsWith('/classification')) {
      const reviewRef = classificationReviewRefFromPath(
        window.location.pathname,
      );
      if (reviewRef === null) renderClassificationList();
      else renderClassificationDetail(reviewRef);
      return;
    }
    const reviewId = reconciliationReviewIdFromPath(window.location.pathname);
    if (reviewId === null) renderList();
    else renderDetail(reviewId);
  };
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-review-link]',
    );
    if (link === null) return;
    event.preventDefault();
    const reviewId = link.dataset.reviewLink;
    if (reviewId === undefined) return;
    window.history.pushState(
      {},
      '',
      `/reconciliation/${encodeURIComponent(reviewId)}`,
    );
    renderDetail(reviewId);
  });
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-classification-link]',
    );
    if (link === null) return;
    event.preventDefault();
    const reviewRef = link.dataset.classificationLink;
    if (reviewRef === undefined) return;
    window.history.pushState(
      {},
      '',
      `/classification/${encodeURIComponent(reviewRef)}`,
    );
    renderClassificationDetail(reviewRef);
  });
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-subscription-link]',
    );
    if (link === null) return;
    event.preventDefault();
    const reviewRef = link.dataset.subscriptionLink;
    if (reviewRef === undefined) return;
    window.history.pushState(
      {},
      '',
      `/subscriptions/${encodeURIComponent(reviewRef)}`,
    );
    renderSubscriptionDetail(reviewRef);
  });
  root.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-amazon-link]',
    );
    if (link === null) return;
    event.preventDefault();
    const reviewRef = link.dataset.amazonLink;
    if (reviewRef === undefined) return;
    window.history.pushState(
      {},
      '',
      `/amazon/${encodeURIComponent(reviewRef)}`,
    );
    renderAmazonDetail(reviewRef);
  });
  root.addEventListener('click', event => {
    const section = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-review-section]',
    )?.dataset.reviewSection;
    if (
      section !== 'reconciliation' &&
      section !== 'classification' &&
      section !== 'subscriptions' &&
      section !== 'amazon'
    ) {
      return;
    }
    event.preventDefault();
    window.history.pushState({}, '', `/${section}`);
    if (section === 'classification') {
      renderClassificationList();
    } else if (section === 'subscriptions') {
      renderSubscriptionList();
    } else if (section === 'amazon') {
      renderAmazonList();
    } else {
      renderList();
    }
  });
  root.addEventListener('click', event => {
    if ((event.target as Element).closest('[data-logout]') === null) return;
    void api.logout().then(
      () => {
        window.history.pushState({}, '', '/');
        renderLogin('You have signed out.');
      },
      error => renderError(root, error, renderList),
    );
  });
  window.addEventListener('popstate', () => {
    renderAuthenticatedRoute();
  });
  renderLogin();
}

export function renderFinanceCompanionLoginShell(message = ''): string {
  return `<section aria-labelledby="finance-companion-title" class="login-shell"><h1 id="finance-companion-title">Finance Companion</h1><p>Sign in to review local finance suggestions.</p><form aria-label="Sign in"><label for="owner-credential">Owner credential</label><input id="owner-credential" name="credential" type="password" autocomplete="off" required /><button type="submit">Sign in</button></form><p role="status" aria-live="polite">${escapeHtml(message)}</p></section>`;
}

export function renderLoading(message: string): string {
  return `<main class="review-shell" aria-busy="true"><p role="status" aria-live="polite">${escapeHtml(message)}</p></main>`;
}

export function renderReconciliationList(
  list: ReconciliationReviewList,
): string {
  const body =
    list.candidates.length === 0
      ? '<p class="empty-state">No reconciliation suggestions are ready to review.</p>'
      : `<ol class="candidate-list">${list.candidates.map(candidate => `<li><a data-review-link="${escapeHtml(candidate.reviewId)}" href="/reconciliation/${encodeURIComponent(candidate.reviewId)}"><strong>${escapeHtml(candidate.confidence)}</strong><span>${candidate.score}/100 · ${escapeHtml(statusLabel(candidate.status))}${candidate.competingCandidateCount > 0 ? ` · ${candidate.competingCandidateCount} competing suggestion${candidate.competingCandidateCount === 1 ? '' : 's'}` : ''}</span></a></li>`).join('')}</ol>`;
  return reviewLayout('Reconciliation review', body, 'reconciliation');
}

export function renderReconciliationDetail(
  candidate: ReconciliationReviewCandidate,
): string {
  const status =
    candidate.status === 'approved'
      ? '<p class="success" role="status" tabindex="-1" data-decision-outcome>Approval recorded. In Actual, manually reconcile the matching transaction when you are ready. Finance Companion did not change Actual.</p>'
      : candidate.status === 'rejected'
        ? '<p class="success" role="status" tabindex="-1" data-decision-outcome>Rejection recorded. Finance Companion did not change Actual.</p>'
        : candidate.status === 'stale'
          ? '<p class="warning" role="status" tabindex="-1" data-decision-outcome>This suggestion is stale because Actual changed. No decision was recorded.</p>'
          : candidate.competingCandidateCount > 0
            ? `<p class="warning">${candidate.competingCandidateCount} competing suggestion${candidate.competingCandidateCount === 1 ? ' is' : 's are'} still pending. Compare carefully before approving.</p>`
            : '';
  const actions =
    candidate.status === 'pending'
      ? '<div class="actions"><button data-decision="approved" type="button">Approve</button><button class="secondary" data-decision="rejected" type="button">Reject</button></div><dialog aria-labelledby="decision-title"><h2 id="decision-title">Record decision?</h2><p>Finance Companion will recheck Actual before recording this decision. It will not change Actual.</p><div class="actions"><button data-confirm-decision type="button">Confirm</button><button data-cancel-decision class="secondary" type="button">Cancel</button></div></dialog>'
      : '';
  return reviewLayout(
    'Reconciliation suggestion',
    `<a class="back" href="/reconciliation" data-review-list>Back to suggestions</a><h2 id="review-title" tabindex="-1">${escapeHtml(candidate.confidence)} (${candidate.score}/100)</h2><p>${escapeHtml(statusLabel(candidate.status))}</p>${status}${renderEvidence(candidate.evidence)}<h3>Why this was suggested</h3><ul>${candidate.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>${actions}`,
    'reconciliation',
  );
}

function reviewLayout(
  title: string,
  body: string,
  activeSection:
    | 'reconciliation'
    | 'classification'
    | 'subscriptions'
    | 'amazon',
): string {
  return `<main class="review-shell" aria-labelledby="review-page-title"><header><h1 id="review-page-title">${escapeHtml(title)}</h1><button class="secondary" data-logout type="button">Sign out</button></header><nav class="review-navigation" aria-label="Review types"><a ${activeSection === 'reconciliation' ? 'aria-current="page"' : ''} data-review-section="reconciliation" href="/reconciliation">Reconciliation</a><a ${activeSection === 'classification' ? 'aria-current="page"' : ''} data-review-section="classification" href="/classification">Classification</a><a ${activeSection === 'subscriptions' ? 'aria-current="page"' : ''} data-review-section="subscriptions" href="/subscriptions">Recurring payments</a><a ${activeSection === 'amazon' ? 'aria-current="page"' : ''} data-review-section="amazon" href="/amazon">Amazon</a></nav>${body}</main>`;
}
function bindPage(
  root: HTMLElement,
  api: FinanceCompanionApi,
  renderList: () => void,
  renderDetail: (reviewId: string) => void,
  candidate?: ReconciliationReviewCandidate,
): void {
  root
    .querySelector<HTMLAnchorElement>('[data-review-list]')
    ?.addEventListener('click', event => {
      event.preventDefault();
      window.history.pushState({}, '', '/reconciliation');
      renderList();
    });
  if (candidate === undefined) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog');
  let decision: 'approved' | 'rejected' | null = null;
  root.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(button =>
    button.addEventListener('click', () => {
      decision =
        button.dataset.decision === 'approved' ? 'approved' : 'rejected';
      dialog?.showModal();
      dialog
        ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
        ?.focus();
    }),
  );
  dialog
    ?.querySelector<HTMLButtonElement>('[data-cancel-decision]')
    ?.addEventListener('click', () => dialog.close());
  dialog
    ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
    ?.addEventListener('click', () => {
      if (decision === null) return;
      dialog.close();
      root.innerHTML = renderLoading(
        'Rechecking Actual before recording your decision…',
      );
      void api.decide(candidate.reviewId, decision).then(
        result => {
          root.innerHTML = renderReconciliationDetail(result);
          bindPage(root, api, renderList, renderDetail, result);
          focusReconciliationReviewOutcome(selector =>
            root.querySelector<HTMLElement>(selector),
          );
        },
        error =>
          renderError(root, error, () => renderDetail(candidate.reviewId)),
      );
    });
}

function bindClassificationPage(
  root: HTMLElement,
  api: FinanceCompanionApi,
  renderList: () => void,
  renderDetail: (reviewRef: string) => void,
  review?: ClassificationReviewDetail,
): void {
  root
    .querySelector<HTMLAnchorElement>('[data-classification-list]')
    ?.addEventListener('click', event => {
      event.preventDefault();
      window.history.pushState({}, '', '/classification');
      renderList();
    });
  if (review === undefined) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog');
  let selected:
    | Readonly<{
        decision: 'approve' | 'reject';
        action: ClassificationReviewAction | null;
      }>
    | undefined;
  let openingButton: HTMLButtonElement | undefined;
  root
    .querySelectorAll<HTMLButtonElement>('[data-classification-decision]')
    .forEach(button =>
      button.addEventListener('click', () => {
        openingButton = button;
        selected = {
          decision:
            button.dataset.classificationDecision === 'approve'
              ? 'approve'
              : 'reject',
          action:
            button.dataset.classificationAction === 'categorize_once'
              ? 'categorize_once'
              : button.dataset.classificationAction === 'create_rule'
                ? 'create_rule'
                : null,
        };
        const confirmationCopy = dialog?.querySelector<HTMLElement>(
          '[data-confirmation-copy]',
        );
        if (confirmationCopy !== null && confirmationCopy !== undefined) {
          confirmationCopy.textContent = classificationConfirmationCopy(
            review,
            selected.decision,
            selected.action,
          );
        }
        dialog?.showModal();
        dialog
          ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
          ?.focus();
      }),
    );
  dialog
    ?.querySelector<HTMLButtonElement>('[data-cancel-decision]')
    ?.addEventListener('click', () => {
      selected = undefined;
      dialog.close();
      openingButton?.focus();
    });
  dialog
    ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
    ?.addEventListener('click', () => {
      if (selected === undefined) return;
      const decision = selected;
      dialog.close();
      root.innerHTML = renderLoading(
        'Rechecking Actual before recording your decision…',
      );
      void api
        .decideClassificationReview(
          review.reviewRef,
          decision.decision,
          decision.action,
        )
        .then(
          result => {
            root.innerHTML = reviewLayout(
              'Classification suggestion',
              renderClassificationDetailBody(result),
              'classification',
            );
            bindClassificationPage(root, api, renderList, renderDetail, result);
            focusReconciliationReviewOutcome(selector =>
              root.querySelector<HTMLElement>(selector),
            );
          },
          error =>
            renderError(root, error, () => renderDetail(review.reviewRef)),
        );
    });
}

function bindSubscriptionPage(
  root: HTMLElement,
  api: FinanceCompanionApi,
  renderList: () => void,
  renderDetail: (reviewRef: string) => void,
  review?: SubscriptionReviewDetail,
): void {
  root
    .querySelector<HTMLAnchorElement>('[data-subscription-list]')
    ?.addEventListener('click', event => {
      event.preventDefault();
      window.history.pushState({}, '', '/subscriptions');
      renderList();
    });
  if (review === undefined) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog');
  let selectedAction: SubscriptionReviewAction | undefined;
  let openingButton: HTMLButtonElement | undefined;
  root
    .querySelectorAll<HTMLInputElement>('input[name="subscription-type"]')
    .forEach(input =>
      input.addEventListener('change', () => {
        const error = root.querySelector<HTMLElement>(
          '[data-subscription-type-error]',
        );
        if (error !== null) error.textContent = '';
      }),
    );
  root
    .querySelectorAll<HTMLButtonElement>('[data-subscription-decision]')
    .forEach(button =>
      button.addEventListener('click', () => {
        openingButton = button;
        const kind = button.dataset.subscriptionDecision;
        if (kind === 'approve') {
          const userSelectedType = readSelectedSubscriptionType(root);
          if (userSelectedType === null) {
            const error = root.querySelector<HTMLElement>(
              '[data-subscription-type-error]',
            );
            if (error !== null) {
              error.textContent = 'Choose a type before approving.';
            }
            root
              .querySelector<HTMLInputElement>(
                'input[name="subscription-type"]',
              )
              ?.focus();
            return;
          }
          selectedAction = { kind: 'approve', userSelectedType };
        } else if (kind === 'defer') {
          selectedAction = { kind: 'defer' };
        } else if (kind === 'reject') {
          selectedAction = { kind: 'reject' };
        } else if (kind === 'reopen') {
          selectedAction = { kind: 'reopen' };
        } else {
          return;
        }
        const confirmationCopy = dialog?.querySelector<HTMLElement>(
          '[data-confirmation-copy]',
        );
        if (confirmationCopy !== null && confirmationCopy !== undefined) {
          confirmationCopy.textContent =
            subscriptionConfirmationCopy(selectedAction);
        }
        dialog?.showModal();
        dialog
          ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
          ?.focus();
      }),
    );
  dialog
    ?.querySelector<HTMLButtonElement>('[data-cancel-decision]')
    ?.addEventListener('click', () => {
      selectedAction = undefined;
      dialog.close();
      openingButton?.focus();
    });
  dialog
    ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
    ?.addEventListener('click', () => {
      if (selectedAction === undefined) return;
      const action = selectedAction;
      dialog.close();
      root.innerHTML = renderLoading(
        'Rechecking Actual before recording your decision…',
      );
      void api.decideSubscriptionReview(review.reviewRef, action).then(
        result => {
          root.innerHTML = reviewLayout(
            'Recurring payment candidate',
            renderSubscriptionDetailBody(result, action.kind),
            'subscriptions',
          );
          bindSubscriptionPage(root, api, renderList, renderDetail, result);
          focusReconciliationReviewOutcome(selector =>
            root.querySelector<HTMLElement>(selector),
          );
        },
        error => renderError(root, error, () => renderDetail(review.reviewRef)),
      );
    });
}

function bindAmazonPage(
  root: HTMLElement,
  api: FinanceCompanionApi,
  renderList: (importResult?: AmazonImportResult, importError?: string) => void,
  renderDetail: (reviewRef: string) => void,
  _list?: AmazonReviewList,
  review?: AmazonReviewDetail,
): void {
  root
    .querySelector<HTMLAnchorElement>('[data-amazon-list]')
    ?.addEventListener('click', event => {
      event.preventDefault();
      window.history.pushState({}, '', '/amazon');
      renderList();
    });

  const uploadForm = root.querySelector<HTMLFormElement>(
    '[data-amazon-upload]',
  );
  const fileInput = root.querySelector<HTMLInputElement>('#amazon-file');
  fileInput?.addEventListener('change', () => {
    const status = root.querySelector<HTMLElement>('[data-file-status]');
    if (status === null) return;
    status.textContent =
      fileInput.files?.length === 1
        ? 'One file selected. Ready to import.'
        : 'No file selected.';
  });
  uploadForm?.addEventListener('submit', event => {
    event.preventDefault();
    const file = fileInput?.files?.[0];
    if (file === undefined || fileInput?.files?.length !== 1) {
      const status = root.querySelector<HTMLElement>('[data-file-status]');
      if (status !== null) status.textContent = 'Choose exactly one file.';
      fileInput?.focus();
      return;
    }
    if (
      !file.name.toLowerCase().endsWith('.json') &&
      !file.name.toLowerCase().endsWith('.eml')
    ) {
      const status = root.querySelector<HTMLElement>('[data-file-status]');
      if (status !== null) {
        status.textContent = 'Choose a supported .json export or .eml message.';
      }
      fileInput.focus();
      return;
    }
    root.innerHTML = renderLoading(
      'Importing Amazon data and checking Actual...',
    );
    void api.importAmazonFile(file).then(
      result => renderList(result),
      error => renderList(undefined, errorMessage(error)),
    );
  });

  if (review === undefined) return;
  const dialog = root.querySelector<HTMLDialogElement>('dialog');
  let selectedAction: AmazonReviewAction | undefined;
  let openingButton: HTMLButtonElement | undefined;
  root
    .querySelectorAll<HTMLButtonElement>('[data-amazon-decision]')
    .forEach(button =>
      button.addEventListener('click', () => {
        const kind = button.dataset.amazonDecision;
        if (
          kind !== 'approve' &&
          kind !== 'reject' &&
          kind !== 'defer' &&
          kind !== 'reopen'
        ) {
          return;
        }
        openingButton = button;
        selectedAction = { kind };
        const copy = dialog?.querySelector<HTMLElement>(
          '[data-confirmation-copy]',
        );
        if (copy !== null && copy !== undefined) {
          copy.textContent = amazonConfirmationCopy(selectedAction);
        }
        dialog?.showModal();
        dialog
          ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
          ?.focus();
      }),
    );
  dialog?.addEventListener('cancel', () => {
    selectedAction = undefined;
    queueMicrotask(() => openingButton?.focus());
  });
  dialog
    ?.querySelector<HTMLButtonElement>('[data-cancel-decision]')
    ?.addEventListener('click', () => {
      selectedAction = undefined;
      dialog.close();
      openingButton?.focus();
    });
  dialog
    ?.querySelector<HTMLButtonElement>('[data-confirm-decision]')
    ?.addEventListener('click', () => {
      if (selectedAction === undefined) return;
      const action = selectedAction;
      dialog.close();
      root.innerHTML = renderLoading(
        'Rechecking every Actual parent before recording your decision...',
      );
      void api.decideAmazonReview(review.reviewRef, action).then(
        result => {
          root.innerHTML = reviewLayout(
            'Amazon allocation candidate',
            renderAmazonDetailBody(result, action.kind),
            'amazon',
          );
          bindAmazonPage(
            root,
            api,
            renderList,
            renderDetail,
            undefined,
            result,
          );
          focusReconciliationReviewOutcome(selector =>
            root.querySelector<HTMLElement>(selector),
          );
        },
        error => renderError(root, error, () => renderDetail(review.reviewRef)),
      );
    });
}

function readSelectedSubscriptionType(
  root: HTMLElement,
): SubscriptionCandidateType | null {
  const value = root.querySelector<HTMLInputElement>(
    'input[name="subscription-type"]:checked',
  )?.value;
  return value === 'subscription' ||
    value === 'household_bill' ||
    value === 'financial_bill' ||
    value === 'unknown'
    ? value
    : null;
}

function renderError(
  root: HTMLElement,
  error: unknown,
  retry: () => void,
): void {
  root.innerHTML = `<main class="review-shell"><p class="error" role="alert">${escapeHtml(errorMessage(error))}</p><button type="button" data-retry>Try again</button></main>`;
  root
    .querySelector<HTMLButtonElement>('[data-retry]')
    ?.addEventListener('click', retry);
  root.querySelector<HTMLButtonElement>('[data-retry]')?.focus();
}
export function reconciliationReviewIdFromPath(
  pathname: string,
): string | null {
  const match = /^\/reconciliation\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
export function focusReconciliationReviewOutcome(
  findFocusable: (selector: string) => Readonly<{ focus(): void }> | null,
): void {
  const decisionOutcome = findFocusable('[data-decision-outcome]');
  if (decisionOutcome !== null) {
    decisionOutcome.focus();
    return;
  }
  findFocusable('#review-title')?.focus();
}
function jsonRequest(
  method: string,
  body: unknown,
  csrfToken?: string,
): RequestInit {
  return {
    method,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(csrfToken === undefined ? {} : { 'x-finance-csrf': csrfToken }),
    },
    body: JSON.stringify(body),
  };
}
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
function isSession(value: unknown): value is Readonly<{ csrfToken: string }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).csrfToken === 'string'
  );
}
function isReviewList(value: unknown): value is ReconciliationReviewList {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    Array.isArray((value as Record<string, unknown>).candidates) &&
    ((value as Record<string, unknown>).candidates as unknown[]).every(
      isCandidate,
    )
  );
}
function isCandidate(value: unknown): value is ReconciliationReviewCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.reviewId === 'string' &&
    typeof candidate.score === 'number' &&
    typeof candidate.confidence === 'string' &&
    typeof candidate.status === 'string' &&
    Array.isArray(candidate.reasons) &&
    (candidate.reasons as unknown[]).every(
      reason => typeof reason === 'string',
    ) &&
    typeof candidate.competingCandidateCount === 'number' &&
    typeof candidate.createdAt === 'string' &&
    (candidate.evidence === null || isEvidence(candidate.evidence)) &&
    (candidate.decidedAt === null || typeof candidate.decidedAt === 'string')
  );
}
function isEvidence(value: unknown): value is ReconciliationReviewEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return (
    typeof evidence.currencyCode === 'string' &&
    isTransactionEvidence(evidence.source) &&
    (evidence.actual === null || isTransactionEvidence(evidence.actual))
  );
}
function isTransactionEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return (
    typeof evidence.date === 'string' &&
    Number.isSafeInteger(evidence.amountMinorUnits) &&
    typeof evidence.merchant === 'string' &&
    typeof evidence.accountName === 'string' &&
    typeof evidence.state === 'string'
  );
}
function renderEvidence(evidence: ReconciliationReviewEvidence | null): string {
  if (evidence === null) return '';
  return `<section aria-labelledby="evidence-title"><h3 id="evidence-title">Transaction comparison</h3><div class="evidence-grid">${renderEvidenceColumn('Bank source', evidence.source, evidence.currencyCode)}${evidence.actual === null ? '<section><h4>Actual</h4><p class="warning">The transaction is no longer available in Actual.</p></section>' : renderEvidenceColumn('Actual', evidence.actual, evidence.currencyCode)}</div></section>`;
}
function renderEvidenceColumn(
  title: string,
  evidence: ReconciliationTransactionEvidence & Readonly<{ state: string }>,
  currencyCode: string,
): string {
  return `<section><h4>${escapeHtml(title)}</h4><dl><dt>Date</dt><dd>${escapeHtml(evidence.date)}</dd><dt>Amount</dt><dd class="financial-number">${escapeHtml(formatMinorUnits(evidence.amountMinorUnits, currencyCode))}</dd><dt>Payee or merchant</dt><dd>${escapeHtml(evidence.merchant)}</dd><dt>Account</dt><dd>${escapeHtml(evidence.accountName)}</dd><dt>State</dt><dd>${escapeHtml(evidence.state)}</dd></dl></section>`;
}
function readProblem(value: unknown): string {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).message === 'string'
    ? (value as Record<string, string>).message
    : 'The request could not be completed.';
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The request could not be completed.';
}
function statusLabel(status: ReconciliationReviewCandidate['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  };
  return value.replace(
    /[&<>'"]/g,
    character => entities[character] ?? character,
  );
}
