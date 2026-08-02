import {
  financeMetadataVersion,
  financeReviewDecisions,
  financeReviewFeatures,
  type FinanceMetadata,
  type FinanceReviewDecisionRecord,
} from '#types/finance';

const maximumFinanceReviewCandidateKeyLength = 256;

export function createFinanceMetadata(): FinanceMetadata {
  return { reviewDecisions: [], version: financeMetadataVersion };
}

export function parseFinanceMetadata(value: unknown): FinanceMetadata {
  if (value === undefined) {
    return createFinanceMetadata();
  }
  if (!isRecord(value) || value.version !== financeMetadataVersion) {
    throw new Error('Native finance metadata has an unsupported version.');
  }
  if (!Array.isArray(value.reviewDecisions)) {
    throw new Error('Native finance metadata review decisions are invalid.');
  }

  return {
    reviewDecisions: value.reviewDecisions
      .map(parseFinanceReviewDecisionRecord)
      .sort(compareFinanceReviewDecisionRecords),
    version: financeMetadataVersion,
  };
}

export function withFinanceReviewDecision(
  metadata: FinanceMetadata,
  decision: FinanceReviewDecisionRecord,
): FinanceMetadata {
  const currentMetadata = parseFinanceMetadata(metadata);
  const normalizedDecision = parseFinanceReviewDecisionRecord(decision);

  return {
    reviewDecisions: [
      ...currentMetadata.reviewDecisions.filter(
        currentDecision =>
          currentDecision.feature !== normalizedDecision.feature ||
          currentDecision.candidateKey !== normalizedDecision.candidateKey,
      ),
      normalizedDecision,
    ].sort(compareFinanceReviewDecisionRecords),
    version: financeMetadataVersion,
  };
}

export function findFinanceReviewDecision(
  metadata: FinanceMetadata,
  feature: FinanceReviewDecisionRecord['feature'],
  candidateKey: string,
): FinanceReviewDecisionRecord | undefined {
  return parseFinanceMetadata(metadata).reviewDecisions.find(
    decision =>
      decision.feature === feature && decision.candidateKey === candidateKey,
  );
}

function parseFinanceReviewDecisionRecord(
  value: unknown,
): FinanceReviewDecisionRecord {
  if (
    !isRecord(value) ||
    !isFinanceReviewFeature(value.feature) ||
    !isFinanceReviewDecision(value.decision) ||
    !isCandidateKey(value.candidateKey) ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    throw new Error('Native finance review decision is invalid.');
  }

  return {
    candidateKey: value.candidateKey,
    decision: value.decision,
    feature: value.feature,
    updatedAt: value.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFinanceReviewFeature(
  value: unknown,
): value is FinanceReviewDecisionRecord['feature'] {
  return (
    typeof value === 'string' &&
    (financeReviewFeatures as readonly string[]).includes(value)
  );
}

function isFinanceReviewDecision(
  value: unknown,
): value is FinanceReviewDecisionRecord['decision'] {
  return (
    typeof value === 'string' &&
    (financeReviewDecisions as readonly string[]).includes(value)
  );
}

function isCandidateKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumFinanceReviewCandidateKeyLength
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function compareFinanceReviewDecisionRecords(
  left: FinanceReviewDecisionRecord,
  right: FinanceReviewDecisionRecord,
): number {
  return (
    left.feature.localeCompare(right.feature) ||
    left.candidateKey.localeCompare(right.candidateKey)
  );
}
