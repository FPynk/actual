export const receiptLimits = {
  amountMinorUnits: 1_000_000_000_000,
  lineItemLabel: 256,
  lineItems: 200,
  merchant: 256,
  paymentHint: 128,
  transcript: 32_000,
  warning: 256,
  warnings: 32,
} as const;

export type ReceiptField =
  | 'merchant'
  | 'purchaseDate'
  | 'purchaseTime'
  | 'currency'
  | 'total'
  | 'subtotal'
  | 'tax'
  | 'tip'
  | 'paymentHint'
  | 'lineItems'
  | 'transcript';

export type ReceiptFieldConfidence = Partial<Record<ReceiptField, number>>;

export type ReceiptLineItem = {
  label: string;
  quantity?: number;
  amount?: number;
};

export type ReceiptOcrBox = {
  confidence: number;
  polygon: readonly [number, number][];
  text: string;
};

export type ReceiptReviewedDraft = {
  currency: string | null;
  fieldConfidence: ReceiptFieldConfidence;
  lineItems: readonly ReceiptLineItem[];
  merchant: string | null;
  ocrRevision: string | null;
  parserRevision: string | null;
  paymentHint: string | null;
  purchaseDate: string | null;
  purchaseTime: string | null;
  sourceHash: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  transcript: string;
  warnings: readonly string[];
};

export type ReceiptOcrDraft = ReceiptReviewedDraft & {
  boxes: readonly ReceiptOcrBox[];
  normalizedMerchant: string | null;
};

export type Receipt = ReceiptReviewedDraft & {
  createdAt: string;
  fingerprint: string;
  id: string;
  linkConflict: boolean;
  reviewedAt: string;
  transcriptRevision: number;
  transactionId: string | null;
  updatedAt: string;
};

export type ReceiptSaveReviewedRequest = {
  expectedBudgetId: string;
  expectedFingerprint?: string;
  receipt: ReceiptReviewedDraft;
  receiptId?: string;
};

export type ReceiptMutationResult =
  | { receipt: Receipt; status: 'saved' }
  | { receipt: Receipt; status: 'duplicate' }
  | { status: 'stale' };

export type ReceiptDeleteRequest = {
  expectedBudgetId: string;
  expectedFingerprint: string;
  id: string;
};

export type ReceiptDeleteResult = { status: 'deleted' } | { status: 'stale' };

export type ReceiptLinkRequest = {
  candidateFingerprint: string;
  expectedBudgetId: string;
  expectedReceiptFingerprint: string;
  expectedTransactionId: string | null;
  id: string;
  transactionId: string;
};

export type ReceiptLinkResult =
  | { receipt: Receipt; status: 'linked' | 'reassigned' | 'unlinked' }
  | { conflictingReceiptId: string; status: 'conflict' }
  | { status: 'stale' };

export type ReceiptMatchCandidateReason =
  | 'exact-total'
  | 'near-total'
  | 'same-date'
  | 'one-day-date'
  | 'two-to-three-day-date'
  | 'four-to-seven-day-date'
  | 'merchant-exact'
  | 'merchant-similar'
  | 'merchant-conflict'
  | 'merchant-missing'
  | 'source-agreement'
  | 'source-different'
  | 'source-missing';

export type ReceiptMatchCandidate = {
  accountId: string;
  amount: number;
  amountScore: number;
  candidateFingerprint: string;
  date: string;
  dateDistanceDays: number;
  dateScore: number;
  merchantScore: number;
  payee: string | null;
  reasons: readonly ReceiptMatchCandidateReason[];
  score: number;
  sourceScore: number;
  transactionId: string;
};

export type ReceiptMatchCandidatesRequest = {
  expectedBudgetId: string;
  id: string;
};

export type ReceiptMatchCandidatesResult = {
  candidates: readonly ReceiptMatchCandidate[];
  exclusions: readonly { reason: string; transactionId: string }[];
  manualSelectionReasons: readonly string[];
  preselectedTransactionId: string | null;
};

export type ReceiptMatchCandidatesResponse =
  | ReceiptMatchCandidatesResult
  | { status: 'stale' };
