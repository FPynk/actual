import { formatMinorUnits } from './format.ts';

export type AmazonReviewAction = Readonly<{
  kind: 'approve' | 'reject' | 'defer' | 'reopen';
}>;

type AmazonReviewStatus =
  | 'pending'
  | 'deferred'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'partially_applied'
  | 'applied';

type AmazonReviewSummary = Readonly<{
  version: 1;
  reviewRef: string;
  status: AmazonReviewStatus;
  score: number;
  parentCount: number;
  allocationCount: number;
  competingCandidateCount: number;
  createdAt: string;
  decidedAt: string | null;
}>;

export type AmazonReviewList = Readonly<{
  version: 1;
  reviews: readonly AmazonReviewSummary[];
}>;

type AmazonAllocationKind =
  | 'merchandise'
  | 'tax'
  | 'shipping'
  | 'discount'
  | 'refund'
  | 'gift_card'
  | 'rounding';

export type AmazonReviewDetail = AmazonReviewSummary &
  Readonly<{
    currencyCode: string;
    allowedActions: readonly AmazonReviewAction['kind'][];
    reasons: readonly string[];
    staleReason: 'missing' | 'reconciled' | 'changed' | null;
    parents: readonly Readonly<{
      parentRef: string;
      date: string | null;
      amountMinorUnits: number | null;
      account: string;
      payee: string;
      category: string;
      reconciled: boolean;
      competingCandidateCount: number;
      allocations: readonly Readonly<{
        kind: AmazonAllocationKind;
        amountMinorUnits: number;
        itemTitle: string | null;
        proposedCategory: string | null;
      }>[];
    }>[];
    guidance: string | null;
  }>;

export type AmazonImportResult = Readonly<{
  version: 1;
  status: 'completed' | 'completed-with-conflicts' | 'failed';
  replayed: boolean;
  receipt: Readonly<{
    status: 'parsing' | 'parsed' | 'applied' | 'failed' | 'discarded';
    rowCount: number;
    acceptedCount: number;
    rejectedCount: number;
    errorCode: string | null;
  }>;
  candidateCount: number;
}>;

export function renderAmazonListBody(
  list: AmazonReviewList,
  importResult?: AmazonImportResult,
  importError?: string,
): string {
  const uploadOutcome = importError
    ? `<p class="error" role="alert" tabindex="-1" data-upload-outcome>${escapeHtml(importError)}</p>`
    : importResult === undefined
      ? ''
      : importResult.status === 'failed'
        ? `<p class="error" role="alert" tabindex="-1" data-upload-outcome>The file could not be parsed. No raw file was retained.</p>`
        : `<p class="success" role="status" tabindex="-1" data-upload-outcome>${importResult.replayed ? 'Existing import replayed.' : 'Import completed.'} ${importResult.receipt.acceptedCount} accepted, ${importResult.receipt.rejectedCount} rejected, and ${importResult.candidateCount} candidate${importResult.candidateCount === 1 ? '' : 's'} evaluated. The raw file was discarded.</p>`;
  const reviews =
    list.reviews.length === 0
      ? '<p class="empty-state">No Amazon allocation candidates are ready to review.</p>'
      : `<ol class="candidate-list">${list.reviews
          .map(
            review =>
              `<li><a data-amazon-link="${escapeHtml(review.reviewRef)}" href="/amazon/${encodeURIComponent(review.reviewRef)}"><strong>Amazon allocation candidate</strong><span>${escapeHtml(statusLabel(review.status))} - ${review.score}/100 - ${review.parentCount} parent${review.parentCount === 1 ? '' : 's'} - ${review.allocationCount} allocation${review.allocationCount === 1 ? '' : 's'}${review.competingCandidateCount > 0 ? ` - ${review.competingCandidateCount} competing candidate${review.competingCandidateCount === 1 ? '' : 's'}` : ''}</span></a></li>`,
          )
          .join('')}</ol>`;
  return `<section class="upload-panel" aria-labelledby="amazon-upload-title"><h2 id="amazon-upload-title">Import Amazon data</h2><p>Choose one supported uncompressed Amazon JSON export or EML message. Raw bytes are discarded after parsing.</p><form data-amazon-upload><label for="amazon-file">Amazon file</label><input id="amazon-file" name="file" type="file" accept=".json,.eml,application/json,message/rfc822" required /><p role="status" aria-live="polite" data-file-status>No file selected.</p><button type="submit">Import and find candidates</button></form>${uploadOutcome}</section><section aria-labelledby="amazon-candidates-title"><h2 id="amazon-candidates-title">Allocation candidates</h2>${reviews}</section>`;
}

export function renderAmazonDetailBody(
  review: AmazonReviewDetail,
  completedAction?: AmazonReviewAction['kind'],
): string {
  return `<a class="back" href="/amazon" data-amazon-list>Back to Amazon candidates</a><h2 id="review-title" tabindex="-1">Amazon allocation candidate</h2><p>${escapeHtml(statusLabel(review.status))} - Review order score ${review.score}/100</p><p>This score never selects a candidate or changes Actual.</p>${renderOutcome(review, completedAction)}${review.competingCandidateCount > 0 ? `<p class="warning">${review.competingCandidateCount} competing candidate${review.competingCandidateCount === 1 ? ' is' : 's are'} still pending or deferred. This decision will not select or invalidate them.</p>` : ''}${renderParents(review)}<h3>Why this was suggested</h3><ul>${review.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>${renderActions(review)}`;
}

export function amazonReviewRefFromPath(pathname: string): string | null {
  const match = /^\/amazon\/([^/]+)$/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function amazonConfirmationCopy(action: AmazonReviewAction): string {
  if (action.kind === 'approve') {
    return 'Approve this exact allocation graph? Finance Companion will recheck every Actual parent and record manual guidance only. It will not change Actual or select a competing candidate.';
  }
  if (action.kind === 'reject') {
    return 'Reject this allocation candidate? Finance Companion will recheck every Actual parent and record the rejection without changing Actual or its competitors.';
  }
  if (action.kind === 'defer') {
    return 'Defer this allocation candidate? Finance Companion will recheck every Actual parent and keep the candidate for later review without changing Actual.';
  }
  return 'Reopen this allocation candidate? Finance Companion will recheck every Actual parent and clear the prior decision without changing Actual.';
}

export function isAmazonReviewList(value: unknown): value is AmazonReviewList {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.reviews) &&
    value.reviews.every(isAmazonReviewSummary)
  );
}

export function isAmazonReviewDetail(
  value: unknown,
): value is AmazonReviewDetail {
  if (!isAmazonReviewSummary(value)) return false;
  const detail = value as AmazonReviewSummary & Record<string, unknown>;
  return (
    typeof detail.currencyCode === 'string' &&
    Array.isArray(detail.allowedActions) &&
    detail.allowedActions.every(isActionKind) &&
    Array.isArray(detail.reasons) &&
    detail.reasons.every(reason => typeof reason === 'string') &&
    (detail.staleReason === null ||
      detail.staleReason === 'missing' ||
      detail.staleReason === 'reconciled' ||
      detail.staleReason === 'changed') &&
    Array.isArray(detail.parents) &&
    detail.parents.every(isParent) &&
    (detail.guidance === null || typeof detail.guidance === 'string')
  );
}

export function isAmazonImportResult(
  value: unknown,
): value is AmazonImportResult {
  if (!isRecord(value) || !isRecord(value.receipt)) return false;
  return (
    value.version === 1 &&
    (value.status === 'completed' ||
      value.status === 'completed-with-conflicts' ||
      value.status === 'failed') &&
    typeof value.replayed === 'boolean' &&
    Number.isSafeInteger(value.candidateCount) &&
    isImportReceipt(value.receipt)
  );
}

function renderOutcome(
  review: AmazonReviewDetail,
  completedAction: AmazonReviewAction['kind'] | undefined,
): string {
  if (completedAction === 'reopen' && review.status === 'pending') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate reopened. The prior decision was cleared and Actual was not changed.</p>';
  }
  if (review.status === 'approved') {
    return `<p class="success" role="status" tabindex="-1" data-decision-outcome>Approval recorded. ${escapeHtml(review.guidance ?? 'Finance Companion did not change Actual.')}</p>`;
  }
  if (review.status === 'rejected') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate rejected. Finance Companion did not change Actual or any competing candidate.</p>';
  }
  if (review.status === 'deferred') {
    return '<p class="success" role="status" tabindex="-1" data-decision-outcome>Candidate deferred. Finance Companion did not change Actual.</p>';
  }
  if (review.status === 'stale') {
    const reason =
      review.staleReason === 'reconciled'
        ? 'The Actual parent is now reconciled.'
        : review.staleReason === 'missing'
          ? 'An Actual parent is no longer available.'
          : 'An Actual parent changed.';
    return `<p class="warning" role="status" tabindex="-1" data-decision-outcome>${reason} Stale evidence overrides any deferred state; no decision was recorded and Actual was not changed.</p>`;
  }
  return '';
}

function renderParents(review: AmazonReviewDetail): string {
  return `<section aria-labelledby="allocation-title"><h3 id="allocation-title">Exact allocation graph</h3><div class="amazon-parent-list">${review.parents
    .map(
      (parent, index) =>
        `<section><h4>Actual parent ${index + 1}</h4>${parent.reconciled ? '<p class="warning">This parent is reconciled. Finance Companion will not change it.</p>' : ''}<dl><dt>Date</dt><dd>${escapeHtml(parent.date ?? 'Not available')}</dd><dt>Amount</dt><dd class="financial-number">${parent.amountMinorUnits === null ? 'Not available' : escapeHtml(formatMinorUnits(parent.amountMinorUnits, review.currencyCode))}</dd><dt>Payee</dt><dd>${escapeHtml(parent.payee)}</dd><dt>Account</dt><dd>${escapeHtml(parent.account)}</dd><dt>Current category</dt><dd>${escapeHtml(parent.category)}</dd><dt>Competing candidates</dt><dd>${parent.competingCandidateCount}</dd></dl><h5>Signed allocations</h5><ul class="allocation-list">${parent.allocations.map(allocation => `<li><span>${escapeHtml(allocationLabel(allocation.kind))}${allocation.itemTitle === null ? '' : ` - ${escapeHtml(allocation.itemTitle)}`}${allocation.proposedCategory === null ? '' : ` - Proposed category: ${escapeHtml(allocation.proposedCategory)}`}</span><strong class="financial-number">${escapeHtml(formatMinorUnits(allocation.amountMinorUnits, review.currencyCode))}</strong></li>`).join('')}</ul></section>`,
    )
    .join('')}</div></section>`;
}

function renderActions(review: AmazonReviewDetail): string {
  if (review.allowedActions.includes('reopen')) {
    return (
      '<div class="actions"><button class="secondary" data-amazon-decision="reopen" type="button">Reopen candidate</button></div>' +
      confirmationDialog()
    );
  }
  if (review.status !== 'pending') return '';
  return (
    '<div class="actions"><button data-amazon-decision="approve" type="button">Approve allocation</button><button class="secondary" data-amazon-decision="defer" type="button">Defer</button><button class="secondary" data-amazon-decision="reject" type="button">Reject</button></div>' +
    confirmationDialog()
  );
}

function confirmationDialog(): string {
  return '<dialog aria-labelledby="decision-title"><h2 id="decision-title">Record this decision?</h2><p data-confirmation-copy></p><p>There is no automatic or default action.</p><div class="actions"><button data-confirm-decision type="button">Confirm selected decision</button><button data-cancel-decision class="secondary" type="button">Cancel</button></div></dialog>';
}

function isAmazonReviewSummary(value: unknown): value is AmazonReviewSummary {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.reviewRef === 'string' &&
    isStatus(value.status) &&
    Number.isSafeInteger(value.score) &&
    Number.isSafeInteger(value.parentCount) &&
    Number.isSafeInteger(value.allocationCount) &&
    Number.isSafeInteger(value.competingCandidateCount) &&
    typeof value.createdAt === 'string' &&
    (value.decidedAt === null || typeof value.decidedAt === 'string')
  );
}

function isParent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.parentRef === 'string' &&
    (value.date === null || typeof value.date === 'string') &&
    (value.amountMinorUnits === null ||
      Number.isSafeInteger(value.amountMinorUnits)) &&
    typeof value.account === 'string' &&
    typeof value.payee === 'string' &&
    typeof value.category === 'string' &&
    typeof value.reconciled === 'boolean' &&
    Number.isSafeInteger(value.competingCandidateCount) &&
    Array.isArray(value.allocations) &&
    value.allocations.every(isAllocation)
  );
}

function isAllocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isAllocationKind(value.kind) &&
    Number.isSafeInteger(value.amountMinorUnits) &&
    (value.itemTitle === null || typeof value.itemTitle === 'string') &&
    (value.proposedCategory === null ||
      typeof value.proposedCategory === 'string')
  );
}

function isImportReceipt(value: Record<string, unknown>): boolean {
  return (
    (value.status === 'parsing' ||
      value.status === 'parsed' ||
      value.status === 'applied' ||
      value.status === 'failed' ||
      value.status === 'discarded') &&
    Number.isSafeInteger(value.rowCount) &&
    Number.isSafeInteger(value.acceptedCount) &&
    Number.isSafeInteger(value.rejectedCount) &&
    (value.errorCode === null || typeof value.errorCode === 'string')
  );
}

function isStatus(value: unknown): value is AmazonReviewStatus {
  return (
    value === 'pending' ||
    value === 'deferred' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'stale' ||
    value === 'partially_applied' ||
    value === 'applied'
  );
}

function isActionKind(value: unknown): value is AmazonReviewAction['kind'] {
  return (
    value === 'approve' ||
    value === 'reject' ||
    value === 'defer' ||
    value === 'reopen'
  );
}

function isAllocationKind(value: unknown): value is AmazonAllocationKind {
  return (
    value === 'merchandise' ||
    value === 'tax' ||
    value === 'shipping' ||
    value === 'discount' ||
    value === 'refund' ||
    value === 'gift_card' ||
    value === 'rounding'
  );
}

function allocationLabel(kind: AmazonAllocationKind): string {
  return kind
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function statusLabel(status: AmazonReviewStatus): string {
  return status
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
