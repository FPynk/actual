import { formatMinorUnits } from './format.ts';

export type ClassificationReviewAction = 'categorize_once' | 'create_rule';

type ClassificationReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'applied';

type ClassificationReviewSummary = Readonly<{
  version: 1;
  reviewRef: string;
  kind: 'merchant' | 'category';
  title: string;
  status: ClassificationReviewStatus;
  confidence: number;
  confidenceLabel: string;
  reasons: readonly string[];
  selectedAction: ClassificationReviewAction | null;
  createdAt: string;
  decidedAt: string | null;
}>;

export type ClassificationReviewList = Readonly<{
  version: 1;
  reviews: readonly ClassificationReviewSummary[];
}>;

type MerchantEvidence = Readonly<{
  kind: 'merchant';
  importedMerchantLabels: readonly string[];
  currentPayee: string;
  proposedPayee: string;
  evidenceTransactionCount: number;
}>;

type CategoryEvidence = Readonly<{
  kind: 'category';
  currencyCode: string;
  current: Readonly<{
    date: string;
    amountMinorUnits: number;
    account: string;
    payee: string;
    category: string;
    state: 'Uncleared' | 'Cleared';
  }> | null;
  proposedCategory: string;
  matchingHistoryCount: number;
  eligibleHistoryCount: number;
}>;

export type ClassificationReviewDetail = ClassificationReviewSummary &
  Readonly<{
    allowedActions: readonly ClassificationReviewAction[];
    evidence: MerchantEvidence | CategoryEvidence;
    guidance: string | null;
  }>;

export function renderClassificationListBody(
  list: ClassificationReviewList,
): string {
  if (list.reviews.length === 0) {
    return '<p class="empty-state">No merchant or category suggestions are ready to review.</p>';
  }
  return `<ol class="candidate-list">${list.reviews
    .map(
      review =>
        `<li><a data-classification-link="${escapeHtml(review.reviewRef)}" href="/classification/${encodeURIComponent(review.reviewRef)}"><strong>${escapeHtml(review.title)}</strong><span>${escapeHtml(review.confidenceLabel)} (${review.confidence}/100) · ${escapeHtml(statusLabel(review.status))}</span></a></li>`,
    )
    .join('')}</ol>`;
}

export function renderClassificationDetailBody(
  review: ClassificationReviewDetail,
): string {
  return `<a class="back" href="/classification" data-classification-list>Back to classification suggestions</a><h2 id="review-title" tabindex="-1">${escapeHtml(review.title)}</h2><p>${escapeHtml(review.confidenceLabel)} (${review.confidence}/100) · ${escapeHtml(statusLabel(review.status))}</p>${renderOutcome(review)}${renderEvidence(review.evidence)}<h3>Why this was suggested</h3><ul>${review.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>${renderActions(review)}`;
}

export function classificationReviewRefFromPath(
  pathname: string,
): string | null {
  const match = /^\/classification\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isClassificationReviewList(
  value: unknown,
): value is ClassificationReviewList {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.reviews) &&
    value.reviews.every(isClassificationReviewSummary)
  );
}

export function isClassificationReviewDetail(
  value: unknown,
): value is ClassificationReviewDetail {
  if (!isClassificationReviewSummary(value)) return false;
  const detail = value as ClassificationReviewSummary & Record<string, unknown>;
  return (
    Array.isArray(detail.allowedActions) &&
    detail.allowedActions.every(isClassificationAction) &&
    (detail.guidance === null || typeof detail.guidance === 'string') &&
    isClassificationEvidence(detail.evidence)
  );
}

export function classificationConfirmationCopy(
  review: ClassificationReviewDetail,
  decision: 'approve' | 'reject',
  action: ClassificationReviewAction | null,
): string {
  if (decision === 'reject') {
    return 'Reject this suggestion? Finance Companion will recheck Actual, record the rejection, and make no change in Actual.';
  }
  if (action === 'categorize_once') {
    return 'Record one-time categorization guidance? Finance Companion will recheck Actual and will not categorize the transaction or create a rule.';
  }
  return review.kind === 'merchant'
    ? 'Record payee rename rule guidance? Finance Companion will recheck Actual and will not create a rule or change a transaction.'
    : 'Record category rule guidance? Finance Companion will recheck Actual and will not create a rule or change a transaction.';
}

function renderOutcome(review: ClassificationReviewDetail): string {
  if (review.status === 'approved') {
    return `<p class="success" role="status" tabindex="-1" data-decision-outcome>Decision recorded. ${escapeHtml(review.guidance ?? 'Finance Companion did not change Actual.')}</p>`;
  }
  if (review.status === 'rejected') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Rejection recorded. Finance Companion did not change Actual.</p>';
  }
  if (review.status === 'stale') {
    return '<p class="warning" role="status" tabindex="-1" data-decision-outcome>This suggestion is stale because Actual changed. No new decision was recorded and Actual was not changed.</p>';
  }
  return '';
}

function renderEvidence(evidence: MerchantEvidence | CategoryEvidence): string {
  if (evidence.kind === 'merchant') {
    return `<section aria-labelledby="evidence-title"><h3 id="evidence-title">Merchant comparison</h3><div class="evidence-grid"><section><h4>Current imported merchant</h4><dl><dt>Labels</dt><dd>${evidence.importedMerchantLabels.map(escapeHtml).join(', ')}</dd><dt>Current Actual payee</dt><dd>${escapeHtml(evidence.currentPayee)}</dd><dt>Evidence</dt><dd>${evidence.evidenceTransactionCount} transactions</dd></dl></section><section><h4>Proposed result</h4><dl><dt>Future payee</dt><dd>${escapeHtml(evidence.proposedPayee)}</dd><dt>Scope</dt><dd>Matching future imports only</dd></dl></section></div></section>`;
  }
  return `<section aria-labelledby="evidence-title"><h3 id="evidence-title">Category comparison</h3><div class="evidence-grid">${
    evidence.current === null
      ? '<section><h4>Current transaction</h4><p class="warning">The transaction is no longer available in Actual.</p></section>'
      : `<section><h4>Current transaction</h4><dl><dt>Date</dt><dd>${escapeHtml(evidence.current.date)}</dd><dt>Amount</dt><dd class="financial-number">${escapeHtml(formatMinorUnits(evidence.current.amountMinorUnits, evidence.currencyCode))}</dd><dt>Account</dt><dd>${escapeHtml(evidence.current.account)}</dd><dt>Payee</dt><dd>${escapeHtml(evidence.current.payee)}</dd><dt>Current category</dt><dd>${escapeHtml(evidence.current.category)}</dd><dt>State</dt><dd>${escapeHtml(evidence.current.state)}</dd></dl></section>`
  }<section><h4>Proposed result</h4><dl><dt>Category</dt><dd>${escapeHtml(evidence.proposedCategory)}</dd><dt>History</dt><dd>${evidence.matchingHistoryCount} of ${evidence.eligibleHistoryCount} similar transactions</dd></dl></section></div></section>`;
}

function renderActions(review: ClassificationReviewDetail): string {
  if (review.status !== 'pending') return '';
  const categoryOnce = review.allowedActions.includes('categorize_once')
    ? '<button data-classification-decision="approve" data-classification-action="categorize_once" type="button">Categorize once in Actual</button>'
    : '';
  const createRule = review.allowedActions.includes('create_rule')
    ? `<button data-classification-decision="approve" data-classification-action="create_rule" type="button">${review.kind === 'merchant' ? 'Create payee rename rule in Actual' : 'Create category rule in Actual'}</button>`
    : '';
  return `<div class="actions">${categoryOnce}${createRule}<button class="secondary" data-classification-decision="reject" type="button">Reject suggestion</button></div><dialog aria-labelledby="decision-title"><h2 id="decision-title">Record this decision?</h2><p data-confirmation-copy></p><p>There is no automatic or default action.</p><div class="actions"><button data-confirm-decision type="button">Confirm selected decision</button><button data-cancel-decision class="secondary" type="button">Cancel</button></div></dialog>`;
}

function isClassificationReviewSummary(
  value: unknown,
): value is ClassificationReviewSummary {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.reviewRef === 'string' &&
    (value.kind === 'merchant' || value.kind === 'category') &&
    typeof value.title === 'string' &&
    isClassificationStatus(value.status) &&
    Number.isSafeInteger(value.confidence) &&
    typeof value.confidenceLabel === 'string' &&
    Array.isArray(value.reasons) &&
    value.reasons.every(reason => typeof reason === 'string') &&
    (value.selectedAction === null ||
      isClassificationAction(value.selectedAction)) &&
    typeof value.createdAt === 'string' &&
    (value.decidedAt === null || typeof value.decidedAt === 'string')
  );
}

function isClassificationEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'merchant') {
    return (
      Array.isArray(value.importedMerchantLabels) &&
      value.importedMerchantLabels.every(label => typeof label === 'string') &&
      typeof value.currentPayee === 'string' &&
      typeof value.proposedPayee === 'string' &&
      Number.isSafeInteger(value.evidenceTransactionCount)
    );
  }
  return (
    value.kind === 'category' &&
    typeof value.currencyCode === 'string' &&
    (value.current === null || isCategoryCurrent(value.current)) &&
    typeof value.proposedCategory === 'string' &&
    Number.isSafeInteger(value.matchingHistoryCount) &&
    Number.isSafeInteger(value.eligibleHistoryCount)
  );
}

function isCategoryCurrent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.date === 'string' &&
    Number.isSafeInteger(value.amountMinorUnits) &&
    typeof value.account === 'string' &&
    typeof value.payee === 'string' &&
    typeof value.category === 'string' &&
    (value.state === 'Uncleared' || value.state === 'Cleared')
  );
}

function isClassificationAction(
  value: unknown,
): value is ClassificationReviewAction {
  return value === 'categorize_once' || value === 'create_rule';
}

function isClassificationStatus(
  value: unknown,
): value is ClassificationReviewStatus {
  return (
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'stale' ||
    value === 'applied'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusLabel(status: ClassificationReviewStatus): string {
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
