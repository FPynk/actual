import { formatMinorUnits } from './format.ts';

export type SubscriptionCandidateType =
  | 'subscription'
  | 'household_bill'
  | 'financial_bill'
  | 'unknown';

export type SubscriptionReviewAction =
  | Readonly<{
      kind: 'approve';
      userSelectedType: SubscriptionCandidateType;
    }>
  | Readonly<{ kind: 'defer' }>
  | Readonly<{
      kind: 'reject';
      reasonCode?: 'not-recurring' | 'other';
    }>
  | Readonly<{ kind: 'reopen' }>;

type SubscriptionReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'deferred'
  | 'stale'
  | 'applied';

type SubscriptionReviewSummary = Readonly<{
  version: 1;
  reviewRef: string;
  title: string;
  status: SubscriptionReviewStatus;
  cadence: string;
  confidence: number;
  selectedType: SubscriptionCandidateType | null;
  hasExistingSchedule: boolean;
  evaluatedAt: string;
  decidedAt: string | null;
}>;

export type SubscriptionReviewList = Readonly<{
  version: 1;
  reviews: readonly SubscriptionReviewSummary[];
}>;

type SubscriptionScheduleAssociation =
  | 'existing'
  | 'ambiguous'
  | 'none'
  | 'stale';

export type SubscriptionReviewDetail = SubscriptionReviewSummary &
  Readonly<{
    allowedActions: readonly SubscriptionReviewAction['kind'][];
    reasons: readonly string[];
    evidence: Readonly<{
      currencyCode: string;
      account: string;
      payee: string;
      cadence: string;
      occurrenceCount: number;
      firstDate: string;
      lastDate: string;
      medianAmountMinorUnits: number;
      amountVarianceBasisPoints: number;
      dateVarianceDays: number;
      recentPriceChangeBasisPoints: number | null;
      hasReconciledHistory: boolean;
      scheduleAssociation: SubscriptionScheduleAssociation;
    }>;
    guidance: string | null;
  }>;

export function renderSubscriptionListBody(
  list: SubscriptionReviewList,
): string {
  if (list.reviews.length === 0) {
    return '<p class="empty-state">No recurring payment candidates are ready to review.</p>';
  }
  return `<ol class="candidate-list">${list.reviews
    .map(
      review =>
        `<li><a data-subscription-link="${escapeHtml(review.reviewRef)}" href="/subscriptions/${encodeURIComponent(review.reviewRef)}"><strong>${escapeHtml(review.title)}</strong><span>${escapeHtml(review.cadence)} - ${escapeHtml(statusLabel(review.status))}${review.hasExistingSchedule ? ' - Existing schedule' : ''}</span></a></li>`,
    )
    .join('')}</ol>`;
}

export function renderSubscriptionDetailBody(
  review: SubscriptionReviewDetail,
  completedAction?: SubscriptionReviewAction['kind'],
): string {
  return `<a class="back" href="/subscriptions" data-subscription-list>Back to recurring payment candidates</a><h2 id="review-title" tabindex="-1">${escapeHtml(review.title)}</h2><p>${escapeHtml(statusLabel(review.status))} - Review order score ${review.confidence}/100</p><p>This score never selects a type or records a decision.</p>${renderOutcome(review, completedAction)}${renderEvidence(review)}<h3>Why this was suggested</h3><ul>${review.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>${renderActions(review)}`;
}

export function subscriptionReviewRefFromPath(pathname: string): string | null {
  const match = /^\/subscriptions\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function subscriptionConfirmationCopy(
  action: SubscriptionReviewAction,
): string {
  if (action.kind === 'approve') {
    return `Approve as ${typeLabel(action.userSelectedType)}? Finance Companion will recheck Actual and record guidance only. It will not create or change a schedule or transaction.`;
  }
  if (action.kind === 'defer') {
    return 'Defer this candidate? Finance Companion will recheck Actual and keep it out of the pending queue without changing Actual.';
  }
  if (action.kind === 'reject') {
    return 'Reject this candidate? Finance Companion will recheck Actual and suppress this detector version without changing Actual.';
  }
  return 'Reopen this candidate? Finance Companion will recheck Actual, clear the prior choice, and return current evidence to the pending queue without changing Actual.';
}

export function isSubscriptionReviewList(
  value: unknown,
): value is SubscriptionReviewList {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.reviews) &&
    value.reviews.every(isSubscriptionReviewSummary)
  );
}

export function isSubscriptionReviewDetail(
  value: unknown,
): value is SubscriptionReviewDetail {
  if (!isSubscriptionReviewSummary(value)) return false;
  const detail = value as SubscriptionReviewSummary & Record<string, unknown>;
  return (
    Array.isArray(detail.allowedActions) &&
    detail.allowedActions.every(isActionKind) &&
    Array.isArray(detail.reasons) &&
    detail.reasons.every(reason => typeof reason === 'string') &&
    isEvidence(detail.evidence) &&
    (detail.guidance === null || typeof detail.guidance === 'string')
  );
}

function renderOutcome(
  review: SubscriptionReviewDetail,
  completedAction: SubscriptionReviewAction['kind'] | undefined,
): string {
  if (completedAction === 'reopen' && review.status === 'pending') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate reopened. The prior choice was cleared and Actual was not changed.</p>';
  }
  if (review.status === 'approved') {
    return `<p class="success" role="status" tabindex="-1" data-decision-outcome>Approval recorded as ${escapeHtml(typeLabel(review.selectedType ?? 'unknown'))}. ${escapeHtml(review.guidance ?? 'Finance Companion did not change Actual.')}</p>`;
  }
  if (review.status === 'deferred') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate deferred. Finance Companion did not change Actual.</p>';
  }
  if (review.status === 'rejected') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate rejected and suppressed for this detector version. Finance Companion did not change Actual.</p>';
  }
  if (review.status === 'stale') {
    return '<p class="warning" role="status" tabindex="-1" data-decision-outcome>This candidate is stale because its history or linked schedule changed in Actual. No new decision was recorded and Actual was not changed.</p>';
  }
  return '';
}

function renderEvidence(review: SubscriptionReviewDetail): string {
  const evidence = review.evidence;
  const priceChange =
    evidence.recentPriceChangeBasisPoints === null
      ? 'No recent material price change'
      : `${formatBasisPoints(evidence.recentPriceChangeBasisPoints)} recent change`;
  const reconciledWarning = evidence.hasReconciledHistory
    ? '<p class="warning">This evidence includes a reconciled transaction. Finance Companion will not change it.</p>'
    : '';
  return `<section aria-labelledby="evidence-title"><h3 id="evidence-title">Cadence and amount evidence</h3>${reconciledWarning}<div class="evidence-grid"><section><h4>Recurring history</h4><dl><dt>Payee</dt><dd>${escapeHtml(evidence.payee)}</dd><dt>Account</dt><dd>${escapeHtml(evidence.account)}</dd><dt>Cadence</dt><dd>${escapeHtml(evidence.cadence)}</dd><dt>Occurrences</dt><dd>${evidence.occurrenceCount}</dd><dt>Observed</dt><dd>${escapeHtml(evidence.firstDate)} through ${escapeHtml(evidence.lastDate)}</dd><dt>Maximum date variance</dt><dd>${evidence.dateVarianceDays} day${evidence.dateVarianceDays === 1 ? '' : 's'}</dd></dl></section><section><h4>Amount and schedule</h4><dl><dt>Median amount</dt><dd class="financial-number">${escapeHtml(formatMinorUnits(evidence.medianAmountMinorUnits, evidence.currencyCode))}</dd><dt>Maximum amount variance</dt><dd class="financial-number">${escapeHtml(formatBasisPoints(evidence.amountVarianceBasisPoints))}</dd><dt>Recent amount</dt><dd>${escapeHtml(priceChange)}</dd><dt>Actual schedule</dt><dd>${escapeHtml(scheduleAssociationLabel(evidence.scheduleAssociation))}</dd></dl></section></div></section>`;
}

function renderActions(review: SubscriptionReviewDetail): string {
  if (review.allowedActions.includes('reopen')) {
    return (
      '<div class="actions"><button class="secondary" data-subscription-decision="reopen" type="button">Reopen candidate</button></div>' +
      confirmationDialog()
    );
  }
  if (review.status !== 'pending') return '';
  return `<fieldset class="subscription-types"><legend>Choose the type to record</legend><label><input name="subscription-type" type="radio" value="subscription" /> Subscription</label><label><input name="subscription-type" type="radio" value="household_bill" /> Household bill</label><label><input name="subscription-type" type="radio" value="financial_bill" /> Financial bill</label><label><input name="subscription-type" type="radio" value="unknown" /> Recurring payment, not classified</label><p class="error-inline" data-subscription-type-error role="alert"></p></fieldset><div class="actions"><button data-subscription-decision="approve" type="button">Approve selected type</button><button class="secondary" data-subscription-decision="defer" type="button">Defer</button><button class="secondary" data-subscription-decision="reject" type="button">Reject</button></div>${confirmationDialog()}`;
}

function confirmationDialog(): string {
  return '<dialog aria-labelledby="decision-title"><h2 id="decision-title">Record this decision?</h2><p data-confirmation-copy></p><p>There is no automatic or default action.</p><div class="actions"><button data-confirm-decision type="button">Confirm selected decision</button><button data-cancel-decision class="secondary" type="button">Cancel</button></div></dialog>';
}

function isSubscriptionReviewSummary(
  value: unknown,
): value is SubscriptionReviewSummary {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.reviewRef === 'string' &&
    typeof value.title === 'string' &&
    isStatus(value.status) &&
    typeof value.cadence === 'string' &&
    Number.isSafeInteger(value.confidence) &&
    (value.selectedType === null || isCandidateType(value.selectedType)) &&
    typeof value.hasExistingSchedule === 'boolean' &&
    typeof value.evaluatedAt === 'string' &&
    (value.decidedAt === null || typeof value.decidedAt === 'string')
  );
}

function isEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.currencyCode === 'string' &&
    typeof value.account === 'string' &&
    typeof value.payee === 'string' &&
    typeof value.cadence === 'string' &&
    Number.isSafeInteger(value.occurrenceCount) &&
    typeof value.firstDate === 'string' &&
    typeof value.lastDate === 'string' &&
    Number.isSafeInteger(value.medianAmountMinorUnits) &&
    Number.isSafeInteger(value.amountVarianceBasisPoints) &&
    Number.isSafeInteger(value.dateVarianceDays) &&
    (value.recentPriceChangeBasisPoints === null ||
      Number.isSafeInteger(value.recentPriceChangeBasisPoints)) &&
    typeof value.hasReconciledHistory === 'boolean' &&
    isScheduleAssociation(value.scheduleAssociation)
  );
}

function scheduleAssociationLabel(
  association: SubscriptionScheduleAssociation,
): string {
  if (association === 'existing') return 'One current exact match';
  if (association === 'ambiguous') return 'Multiple current matches';
  if (association === 'stale') return 'Previous match is no longer current';
  return 'No current exact match';
}

function typeLabel(type: SubscriptionCandidateType): string {
  if (type === 'subscription') return 'Subscription';
  if (type === 'household_bill') return 'Household bill';
  if (type === 'financial_bill') return 'Financial bill';
  return 'Recurring payment, not classified';
}

function formatBasisPoints(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function isStatus(value: unknown): value is SubscriptionReviewStatus {
  return (
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'deferred' ||
    value === 'stale' ||
    value === 'applied'
  );
}

function isActionKind(
  value: unknown,
): value is SubscriptionReviewAction['kind'] {
  return (
    value === 'approve' ||
    value === 'defer' ||
    value === 'reject' ||
    value === 'reopen'
  );
}

function isCandidateType(value: unknown): value is SubscriptionCandidateType {
  return (
    value === 'subscription' ||
    value === 'household_bill' ||
    value === 'financial_bill' ||
    value === 'unknown'
  );
}

function isScheduleAssociation(
  value: unknown,
): value is SubscriptionScheduleAssociation {
  return (
    value === 'existing' ||
    value === 'ambiguous' ||
    value === 'none' ||
    value === 'stale'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusLabel(status: SubscriptionReviewStatus): string {
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
