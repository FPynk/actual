export const financeMetadataVersion = 1 as const;

export const financeReviewFeatures = [
  'reconciliation',
  'recurring',
  'amazon',
] as const;

export type FinanceReviewFeature = (typeof financeReviewFeatures)[number];

export const financeReviewDecisions = [
  'keep-both',
  'deferred',
  'rejected',
  'applied',
] as const;

export type FinanceReviewDecision = (typeof financeReviewDecisions)[number];

/**
 * Stores only a deterministic candidate key and a user's decision. Candidate
 * evidence remains derived from the current budget rather than copied here.
 */
export type FinanceReviewDecisionRecord = {
  candidateKey: string;
  decision: FinanceReviewDecision;
  feature: FinanceReviewFeature;
  updatedAt: string;
};

/**
 * Budget-local, non-secret native Finance metadata. API keys and raw imports
 * are intentionally not representable by this type.
 */
export type FinanceMetadata = {
  reviewDecisions: FinanceReviewDecisionRecord[];
  version: typeof financeMetadataVersion;
};

export type NativeReconciliationReason =
  | 'same-imported-id'
  | 'both-imported'
  | 'same-date'
  | 'nearby-date'
  | 'same-payee'
  | 'missing-payee'
  | 'different-payee'
  | 'cleared-state-differs';

export type NativeReconciliationTransaction = Readonly<{
  id: string;
  date: string;
  amount: number;
  payee: string | null;
  importedPayee: string | null;
  importedId: string | null;
  categoryId: string | null;
  notes: string | null;
  scheduleId: string | null;
  cleared: boolean;
}>;

export type NativeReconciliationCandidate = Readonly<{
  candidateKey: string;
  fingerprint: string;
  transactionIds: readonly [string, string];
  accountId: string;
  amount: number;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  reasons: readonly NativeReconciliationReason[];
  transactions: readonly [
    NativeReconciliationTransaction,
    NativeReconciliationTransaction,
  ];
}>;

export const financeCategorizationPreferenceId =
  'finance.openai-categorization' as const;

export const defaultOpenAiCategorizationModel = 'gpt-5.6-luna' as const;

export const defaultFinanceCategorizationInstruction =
  'Choose the single best category for each expense. Use no category when the available details are insufficient.';

export type FinanceCategorizationSettings = {
  categoryGuidance: Record<string, string>;
  categoryIds: string[];
  masterPrompt: string;
  model: string;
};

export const defaultFinanceCategorizationSettings: FinanceCategorizationSettings =
  {
    categoryGuidance: {},
    categoryIds: [],
    masterPrompt: defaultFinanceCategorizationInstruction,
    model: defaultOpenAiCategorizationModel,
  };

export type FinanceCategorizationConfidence = 'high' | 'medium' | 'low';

export type FinanceCategorizationCategory = {
  category_id: string;
  guidance?: string;
  name: string;
};

export type FinanceCategorizationCandidate = {
  account?: string;
  amount: string;
  candidate_id: string;
  currency: string;
  date: string;
  description?: string;
  payee?: string;
};

export type FinanceCategorizationRequest = {
  candidates: FinanceCategorizationCandidate[];
  categories: FinanceCategorizationCategory[];
  categorization_instruction: string;
  model: string;
};

export type FinanceCategorizationProposal = {
  candidate_id: string;
  category_id: string | null;
  confidence: FinanceCategorizationConfidence;
  explanation: string;
};

export type FinanceCategorizationUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type FinanceCategorizationResponse = {
  proposals: FinanceCategorizationProposal[];
  usage: FinanceCategorizationUsage | null;
};

export type FinanceCategorizationStatus = {
  configured: boolean;
  source: 'budget' | 'environment' | 'global' | 'none';
};
