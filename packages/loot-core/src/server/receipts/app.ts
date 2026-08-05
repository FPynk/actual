import { createApp } from '#server/app';
import * as db from '#server/db';
import {
  matchReceiptToTransactions,
  validateReceiptMatchConfirmation,
} from '#server/finance/receipt-matcher';
import type {
  ReceiptMatchConfirmation,
  ReceiptMatchReceiptSnapshot,
  ReceiptMatchResult,
  ReceiptMatchTransactionSnapshot,
} from '#server/finance/receipt-matcher';
import { mutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { undoable } from '#server/undo';
import { getCurrency } from '#shared/currencies';
import {
  canonicalizeReceiptReviewedFields,
  fingerprintReceipt,
  validateReceiptReviewedDraft,
} from '#shared/receipts';
import type {
  Receipt,
  ReceiptDeleteRequest,
  ReceiptDeleteResult,
  ReceiptLinkRequest,
  ReceiptLinkResult,
  ReceiptMatchCandidate,
  ReceiptMatchCandidatesRequest,
  ReceiptMatchCandidatesResponse,
  ReceiptMutationResult,
  ReceiptReviewedDraft,
  ReceiptSaveReviewedRequest,
} from '#types/receipts';

export type ReceiptsHandlers = {
  'receipts/list': typeof listReceipts;
  'receipts/get': typeof getReceipt;
  'receipts/save-reviewed': typeof saveReviewedReceipt;
  'receipts/delete': typeof deleteReceipt;
  'receipts/match-candidates': typeof matchReceiptCandidates;
  'receipts/link': typeof linkReceipt;
  'receipts/unlink': typeof unlinkReceipt;
  'receipts/reassign': typeof reassignReceipt;
};

export const app = createApp<ReceiptsHandlers>();

app.method('receipts/list', listReceipts);
app.method('receipts/get', getReceipt);
app.method('receipts/save-reviewed', mutator(undoable(saveReviewedReceipt)));
app.method('receipts/delete', mutator(undoable(deleteReceipt)));
app.method('receipts/match-candidates', matchReceiptCandidates);
app.method('receipts/link', mutator(undoable(linkReceipt)));
app.method('receipts/unlink', mutator(undoable(unlinkReceipt)));
app.method('receipts/reassign', mutator(undoable(reassignReceipt)));

async function listReceipts(): Promise<Receipt[]> {
  requireOpenBudget();
  const rows = await db.getReceipts();
  const activeLinks = new Map<string, number>();
  for (const row of rows) {
    if (row.transaction_id !== null) {
      activeLinks.set(
        row.transaction_id,
        (activeLinks.get(row.transaction_id) ?? 0) + 1,
      );
    }
  }
  return rows.map(row =>
    toReceipt(row, activeLinks.get(row.transaction_id ?? '')! > 1),
  );
}

async function getReceipt({ id }: { id: string }): Promise<Receipt | null> {
  requireOpenBudget();
  const row = await db.getReceipt(id);
  if (!row || row.tombstone) {
    return null;
  }
  return toReceipt(
    row,
    row.transaction_id !== null &&
      (await db.getActiveReceiptsByTransactionId(row.transaction_id)).length >
        1,
  );
}

async function saveReviewedReceipt({
  expectedBudgetId,
  expectedFingerprint,
  receipt,
  receiptId,
}: ReceiptSaveReviewedRequest): Promise<ReceiptMutationResult> {
  if (!isExpectedBudgetOpen(expectedBudgetId)) {
    return { status: 'stale' };
  }

  const reviewedReceipt = validateReceiptReviewedDraft(receipt);
  const duplicate = reviewedReceipt.sourceHash
    ? await db.getActiveReceiptBySourceHash(reviewedReceipt.sourceHash)
    : null;
  const now = new Date().toISOString();

  if (receiptId) {
    const current = await db.getReceipt(receiptId);
    if (
      !current ||
      current.tombstone ||
      !expectedFingerprint ||
      current.fingerprint !== expectedFingerprint ||
      (duplicate && duplicate.id !== receiptId)
    ) {
      return duplicate && duplicate.id !== receiptId
        ? { receipt: toReceipt(duplicate, false), status: 'duplicate' }
        : { status: 'stale' };
    }

    const currentReceipt = toReceipt(current, false);
    const receiptWithStoredLegacyFields = mergeStoredLegacyReceiptFields(
      reviewedReceipt,
      currentReceipt,
    );
    const isEdited =
      canonicalizeReceiptReviewedFields(currentReceipt) !==
      canonicalizeReceiptReviewedFields(receiptWithStoredLegacyFields);
    const fingerprint = await fingerprintReceipt(receiptWithStoredLegacyFields);
    const transcriptRevision = current.transcript_revision + (isEdited ? 1 : 0);
    await db.updateReceipt({
      ...receiptToDatabaseFields(receiptWithStoredLegacyFields),
      fingerprint,
      id: current.id,
      reviewed_at: now,
      transcript_revision: transcriptRevision,
      updated_at: now,
    });
    return {
      receipt: {
        ...receiptWithStoredLegacyFields,
        createdAt: current.created_at,
        fingerprint,
        id: current.id,
        linkConflict: false,
        reviewedAt: now,
        transcriptRevision,
        transactionId: current.transaction_id,
        updatedAt: now,
      },
      status: 'saved',
    };
  }

  if (duplicate) {
    return { receipt: toReceipt(duplicate, false), status: 'duplicate' };
  }

  const fingerprint = await fingerprintReceipt(reviewedReceipt);
  const id = await db.insertReceipt({
    ...receiptToDatabaseInsertFields(reviewedReceipt),
    created_at: now,
    fingerprint,
    reviewed_at: now,
    transcript_revision: 1,
    transaction_id: null,
    updated_at: now,
  });
  return {
    receipt: {
      ...reviewedReceipt,
      createdAt: now,
      fingerprint,
      id,
      linkConflict: false,
      reviewedAt: now,
      transcriptRevision: 1,
      transactionId: null,
      updatedAt: now,
    },
    status: 'saved',
  };
}

async function deleteReceipt({
  expectedBudgetId,
  expectedFingerprint,
  id,
}: ReceiptDeleteRequest): Promise<ReceiptDeleteResult> {
  if (!isExpectedBudgetOpen(expectedBudgetId)) {
    return { status: 'stale' };
  }
  const receipt = await db.getReceipt(id);
  if (
    !receipt ||
    receipt.tombstone ||
    receipt.fingerprint !== expectedFingerprint
  ) {
    return { status: 'stale' };
  }
  await db.deleteReceipt(id);
  return { status: 'deleted' };
}

async function matchReceiptCandidates({
  expectedBudgetId,
  id,
}: ReceiptMatchCandidatesRequest): Promise<ReceiptMatchCandidatesResponse> {
  const budgetId = prefs.getPrefs()?.id;
  if (!budgetId) {
    throw new Error('No budget is open.');
  }
  if (budgetId !== expectedBudgetId) {
    return { status: 'stale' };
  }
  const receipt = await db.getReceipt(id);
  if (!receipt || receipt.tombstone) {
    return { status: 'stale' };
  }
  const currentReceipt = toReceipt(receipt, false);
  const [budgetCurrency, transactions, activeReceipts] = await Promise.all([
    getBudgetCurrency(),
    db.getReceiptMatchTransactions(),
    db.getReceipts(),
  ]);
  return toReceiptMatchCandidatesResult(
    matchReceiptToTransactions({
      receipt: toReceiptMatchSnapshot(currentReceipt, budgetId),
      transactions: transactions.map(transaction =>
        toTransactionMatchSnapshot({
          activeReceipts,
          budgetCurrency,
          budgetId,
          receiptId: currentReceipt.id,
          transaction,
        }),
      ),
    }),
  );
}

async function linkReceipt(
  request: ReceiptLinkRequest,
): Promise<ReceiptLinkResult> {
  return changeReceiptLink(request, 'linked');
}

async function reassignReceipt(
  request: ReceiptLinkRequest,
): Promise<ReceiptLinkResult> {
  return changeReceiptLink(request, 'reassigned');
}

async function unlinkReceipt({
  expectedBudgetId,
  expectedReceiptFingerprint,
  expectedTransactionId,
  id,
}: Omit<
  ReceiptLinkRequest,
  'candidateFingerprint' | 'transactionId'
>): Promise<ReceiptLinkResult> {
  if (!isExpectedBudgetOpen(expectedBudgetId)) {
    return { status: 'stale' };
  }
  const receipt = await db.getReceipt(id);
  if (
    !receipt ||
    receipt.tombstone ||
    receipt.fingerprint !== expectedReceiptFingerprint ||
    receipt.transaction_id !== expectedTransactionId
  ) {
    return { status: 'stale' };
  }
  const updatedAt = new Date().toISOString();
  await db.updateReceipt({ id, transaction_id: null, updated_at: updatedAt });
  return {
    receipt: { ...toReceipt(receipt, false), transactionId: null, updatedAt },
    status: 'unlinked',
  };
}

async function changeReceiptLink(
  {
    candidateFingerprint,
    expectedBudgetId,
    expectedReceiptFingerprint,
    expectedTransactionId,
    id,
    transactionId,
  }: ReceiptLinkRequest,
  status: 'linked' | 'reassigned',
): Promise<ReceiptLinkResult> {
  if (!isExpectedBudgetOpen(expectedBudgetId)) {
    return { status: 'stale' };
  }

  const [receipt, transaction, budgetCurrency] = await Promise.all([
    db.getReceipt(id),
    db.getReceiptMatchTransaction(transactionId),
    getBudgetCurrency(),
  ]);
  if (
    !receipt ||
    receipt.tombstone ||
    receipt.fingerprint !== expectedReceiptFingerprint ||
    receipt.transaction_id !== expectedTransactionId ||
    !transaction
  ) {
    return { status: 'stale' };
  }

  const linkedReceipts =
    await db.getActiveReceiptsByTransactionId(transactionId);
  const conflictingReceipt = linkedReceipts.find(
    linkedReceipt => linkedReceipt.id !== id,
  );
  if (conflictingReceipt) {
    return { conflictingReceiptId: conflictingReceipt.id, status: 'conflict' };
  }

  const confirmation: ReceiptMatchConfirmation = {
    candidateFingerprint,
    expectedBudgetId,
    receiptFingerprint: expectedReceiptFingerprint,
    receiptId: id,
    transactionId,
  };
  const validation = validateReceiptMatchConfirmation({
    confirmation,
    receipt: toReceiptMatchSnapshot(
      toReceipt(receipt, false),
      expectedBudgetId,
    ),
    transaction: toTransactionMatchSnapshot({
      activeReceipts: linkedReceipts,
      budgetCurrency,
      budgetId: expectedBudgetId,
      receiptId: id,
      transaction,
    }),
  });
  if (!validation.isValid) {
    return { status: 'stale' };
  }

  const updatedAt = new Date().toISOString();
  await db.updateReceipt({
    id,
    transaction_id: transactionId,
    updated_at: updatedAt,
  });
  return {
    receipt: {
      ...toReceipt(receipt, false),
      transactionId,
      updatedAt,
    },
    status,
  };
}

function receiptToDatabaseFields(receipt: ReceiptReviewedDraft) {
  return {
    confidence: JSON.stringify(receipt.fieldConfidence),
    currency: receipt.currency,
    merchant: receipt.merchant,
    ocr_revision: receipt.ocrRevision,
    parser_revision: receipt.parserRevision,
    payment_hint: receipt.paymentHint,
    purchase_date: receipt.purchaseDate,
    source_hash: receipt.sourceHash,
    total: receipt.total,
    transcript: receipt.transcript,
    warnings: JSON.stringify(receipt.warnings),
  };
}

function receiptToDatabaseInsertFields(receipt: ReceiptReviewedDraft) {
  return {
    ...receiptToDatabaseFields(receipt),
    line_items: JSON.stringify(receipt.lineItems),
    purchase_time: receipt.purchaseTime,
    subtotal: receipt.subtotal,
    tax: receipt.tax,
    tip: receipt.tip,
  };
}

function mergeStoredLegacyReceiptFields(
  receipt: ReceiptReviewedDraft,
  storedReceipt: Receipt,
): ReceiptReviewedDraft {
  const fieldConfidence = { ...receipt.fieldConfidence };
  for (const field of [
    'lineItems',
    'purchaseTime',
    'subtotal',
    'tax',
    'tip',
  ] as const) {
    const confidence = storedReceipt.fieldConfidence[field];
    if (confidence !== undefined) fieldConfidence[field] = confidence;
  }
  const storedLegacyWarnings = storedReceipt.warnings.filter(warning =>
    /(?:line[- ]?items?|purchase[ -]?time|subtotal|tax|tip)/i.test(warning),
  );
  return {
    ...receipt,
    fieldConfidence,
    lineItems: storedReceipt.lineItems,
    purchaseTime: storedReceipt.purchaseTime,
    subtotal: storedReceipt.subtotal,
    tax: storedReceipt.tax,
    tip: storedReceipt.tip,
    warnings: [
      ...receipt.warnings,
      ...storedLegacyWarnings.filter(
        warning => !receipt.warnings.includes(warning),
      ),
    ],
  };
}

function toReceipt(receipt: db.DbReceipt, linkConflict: boolean): Receipt {
  const reviewedReceipt = validateReceiptReviewedDraft({
    currency: receipt.currency,
    fieldConfidence: parseReceiptJson(receipt.confidence),
    lineItems: parseReceiptJson(receipt.line_items),
    merchant: receipt.merchant,
    ocrRevision: receipt.ocr_revision,
    parserRevision: receipt.parser_revision,
    paymentHint: receipt.payment_hint,
    purchaseDate: receipt.purchase_date,
    purchaseTime: receipt.purchase_time,
    sourceHash: receipt.source_hash,
    subtotal: receipt.subtotal,
    tax: receipt.tax,
    tip: receipt.tip,
    total: receipt.total,
    transcript: receipt.transcript,
    warnings: parseReceiptJson(receipt.warnings),
  });
  return {
    ...reviewedReceipt,
    createdAt: receipt.created_at,
    fingerprint: receipt.fingerprint,
    id: receipt.id,
    linkConflict,
    reviewedAt: receipt.reviewed_at,
    transcriptRevision: receipt.transcript_revision,
    transactionId: receipt.transaction_id,
    updatedAt: receipt.updated_at,
  };
}

function parseReceiptJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Stored receipt data is invalid.');
  }
}

function requireOpenBudget(): void {
  if (!prefs.getPrefs()?.id) {
    throw new Error('No budget is open.');
  }
}

function isExpectedBudgetOpen(expectedBudgetId: string): boolean {
  return Boolean(expectedBudgetId) && prefs.getPrefs()?.id === expectedBudgetId;
}

async function getBudgetCurrency(): Promise<string> {
  const preferences = await db.all<Pick<db.DbPreference, 'id' | 'value'>>(
    `SELECT id, value FROM preferences
     WHERE id IN ('flags.currency', 'defaultCurrencyCode')`,
  );
  const values = new Map(preferences.map(({ id, value }) => [id, value]));
  const configuredCurrency =
    values.get('flags.currency') === 'true'
      ? values.get('defaultCurrencyCode')
      : null;
  return getCurrency(configuredCurrency ?? 'USD').code || 'USD';
}

function toReceiptMatchSnapshot(
  receipt: Receipt,
  budgetId: string,
): ReceiptMatchReceiptSnapshot {
  return {
    budgetId,
    currency: receipt.currency ?? '',
    dateIsAmbiguous: receipt.warnings.includes('ambiguous-date'),
    fingerprint: receipt.fingerprint,
    id: receipt.id,
    merchant: receipt.merchant,
    paymentSourceHint: receipt.paymentHint,
    purchaseDate: receipt.purchaseDate,
    splitTender: receipt.warnings.includes('split-tender'),
    total: receipt.total,
    totalConfidence: receipt.fieldConfidence.total,
  };
}

function toTransactionMatchSnapshot({
  activeReceipts,
  budgetCurrency,
  budgetId,
  receiptId,
  transaction,
}: {
  activeReceipts: readonly db.DbReceipt[];
  budgetCurrency: string;
  budgetId: string;
  receiptId: string;
  transaction: db.DbReceiptMatchTransaction;
}): ReceiptMatchTransactionSnapshot {
  const linkedReceipt = activeReceipts.find(
    activeReceipt =>
      activeReceipt.transaction_id === transaction.id &&
      activeReceipt.id !== receiptId,
  );
  return {
    accountId: transaction.account,
    accountPaymentSource: transaction.account_payment_source,
    amount: transaction.amount,
    budgetId,
    currency: budgetCurrency,
    date: db.fromDateRepr(transaction.date),
    id: transaction.id,
    importedPayee: transaction.imported_payee,
    isChild: Boolean(transaction.is_child),
    isParent: Boolean(transaction.is_parent),
    linkedReceiptId: linkedReceipt?.id ?? null,
    parentId: transaction.parent_id,
    payee: transaction.payee,
    startingBalance: Boolean(transaction.starting_balance_flag),
    transferId: transaction.transfer_id,
  };
}

function toReceiptMatchCandidatesResult(result: ReceiptMatchResult) {
  return {
    candidates: result.candidates.map<ReceiptMatchCandidate>(candidate => ({
      accountId: candidate.accountId,
      amount: candidate.amount,
      amountScore: candidate.amountScore,
      candidateFingerprint: candidate.fingerprint,
      date: candidate.date,
      dateDistanceDays: candidate.dateDistanceDays,
      dateScore: candidate.dateScore,
      merchantScore: candidate.merchantScore,
      payee: candidate.payee,
      reasons: candidate.reasons,
      score: candidate.score,
      sourceScore: candidate.sourceScore,
      transactionId: candidate.transactionId,
    })),
    exclusions: result.exclusions,
    manualSelectionReasons: result.manualSelectionReasons,
    preselectedTransactionId: result.preselectedTransactionId,
  };
}
