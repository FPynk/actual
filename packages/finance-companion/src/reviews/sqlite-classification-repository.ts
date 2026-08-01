import type Database from 'better-sqlite3';

import { canonicalJson } from '#actual/canonical-json';
import type {
  CategoryProposalV1,
  ClassificationProposalRepository,
  ClassificationReasonCode,
  MerchantAliasProposalV1,
} from '#reviews/classification';
import {
  assertClassificationTimestamp,
  categoryProposalReviewId,
  classificationReasonCodes,
  classificationRejectionSuppressionMilliseconds,
  merchantAliasProposalId,
  normalizeImportedPayeeV1,
} from '#reviews/classification';
import type {
  ClassificationReviewAction,
  ClassificationReviewRecordV1,
  ClassificationReviewRepository,
  ClassificationReviewStatus,
} from '#reviews/classification-review';

type MerchantProposalRow = Readonly<{
  id: string;
  imported_payee: string;
  normalized_imported_payee: string;
  proposed_actual_payee_id: string;
  evidence_count: number;
  confidence: number;
  reason_codes_json: string;
  detector_version: number;
  status: string;
  created_at: string;
  decided_at: string | null;
  proposal_metadata_json: string;
}>;

type CategoryReviewRow = Readonly<{
  id: string;
  actual_transaction_id: string;
  actual_target_version: string;
  proposed_category_id: string;
  proposed_action: string;
  confidence: number;
  reason_codes_json: string;
  detector_version: number;
  status: string;
  created_at: string;
  decided_at: string | null;
  proposal_metadata_json: string;
}>;

export class SqliteClassificationProposalRepository
  implements ClassificationProposalRepository, ClassificationReviewRepository
{
  constructor(private readonly database: Database.Database) {}

  findPendingMerchantAlias(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
  ): MerchantAliasProposalV1 | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM merchant_normalization_proposals WHERE normalized_imported_payee = ? AND proposed_actual_payee_id = ? AND detector_version = ? AND status = 'pending'",
      )
      .get(normalizedImportedPayee, payeeId, detectorVersion) as
      | MerchantProposalRow
      | undefined;
    if (row === undefined) return undefined;
    return decodeMerchantProposal(row);
  }

  findPendingCategory(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
  ): CategoryProposalV1 | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM classification_reviews WHERE actual_transaction_id = ? AND proposed_category_id = ? AND actual_target_version = ? AND detector_version = ? AND status = 'pending'",
      )
      .get(transactionId, categoryId, targetVersionHash, detectorVersion) as
      | CategoryReviewRow
      | undefined;
    if (row === undefined) return undefined;
    return decodeCategoryProposal(row);
  }

  isMerchantAliasRejected(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean {
    assertClassificationTimestamp(evaluatedAt);
    const rows = this.database
      .prepare(
        "SELECT * FROM merchant_normalization_proposals WHERE normalized_imported_payee = ? AND proposed_actual_payee_id = ? AND detector_version = ? AND status = 'rejected'",
      )
      .all(
        normalizedImportedPayee,
        payeeId,
        detectorVersion,
      ) as readonly MerchantProposalRow[];
    return rows.some(row => {
      const proposal = decodeMerchantProposal(row);
      return (
        proposal.detectorVersion === detectorVersion &&
        isWithinSuppressionWindow(requiredDecisionTimestamp(row), evaluatedAt)
      );
    });
  }

  isCategoryRejected(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean {
    assertClassificationTimestamp(evaluatedAt);
    const rows = this.database
      .prepare(
        "SELECT * FROM classification_reviews WHERE actual_transaction_id = ? AND proposed_category_id = ? AND actual_target_version = ? AND detector_version = ? AND status = 'rejected'",
      )
      .all(
        transactionId,
        categoryId,
        targetVersionHash,
        detectorVersion,
      ) as readonly CategoryReviewRow[];
    return rows.some(row => {
      const proposal = decodeCategoryProposal(row);
      return (
        proposal.detectorVersion === detectorVersion &&
        isWithinSuppressionWindow(requiredDecisionTimestamp(row), evaluatedAt)
      );
    });
  }

  savePendingMerchantAlias(
    proposal: MerchantAliasProposalV1,
    evaluatedAt: string,
  ): void {
    assertClassificationTimestamp(evaluatedAt);
    validateMerchantProposal(proposal);
    const importedPayee = proposal.sourceSpellings[0];
    if (importedPayee === undefined) {
      throw new Error('Merchant proposal source spelling is missing.');
    }
    const insertion = this.database
      .prepare(
        "INSERT INTO merchant_normalization_proposals (id, imported_payee, normalized_imported_payee, proposed_actual_payee_id, evidence_count, confidence, reason_codes_json, detector_version, status, created_at, decided_at, proposal_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        proposal.proposalId,
        importedPayee,
        proposal.normalizedImportedPayee,
        proposal.proposedPayeeId,
        proposal.evidenceTransactionIds.length,
        proposal.confidence,
        canonicalJson(proposal.reasonCodes),
        proposal.detectorVersion,
        evaluatedAt,
        canonicalJson(merchantMetadata(proposal)),
      );
    if (insertion.changes === 0) {
      assertExistingMerchantProposalMatches(this.database, proposal);
    }
  }

  savePendingCategory(proposal: CategoryProposalV1, evaluatedAt: string): void {
    assertClassificationTimestamp(evaluatedAt);
    validateCategoryProposal(proposal);
    const insertion = this.database
      .prepare(
        "INSERT INTO classification_reviews (id, actual_transaction_id, actual_target_version, proposed_category_id, proposed_action, confidence, reason_codes_json, detector_version, status, created_at, decided_at, proposal_metadata_json) VALUES (?, ?, ?, ?, 'categorize_once', ?, ?, ?, 'pending', ?, NULL, ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        proposal.reviewId,
        proposal.transactionId,
        proposal.targetVersionHash,
        proposal.proposedCategoryId,
        proposal.confidence,
        canonicalJson(proposal.reasonCodes),
        proposal.detectorVersion,
        evaluatedAt,
        canonicalJson(categoryMetadata(proposal)),
      );
    if (insertion.changes === 0) {
      assertExistingCategoryProposalMatches(this.database, proposal);
    }
  }

  rejectMerchantAlias(
    proposal: MerchantAliasProposalV1,
    rejectedAt: string,
  ): void {
    assertClassificationTimestamp(rejectedAt);
    validateMerchantProposal(proposal);
    const result = this.database
      .prepare(
        "UPDATE merchant_normalization_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(rejectedAt, proposal.proposalId);
    if (result.changes !== 1) {
      throw new Error('Pending merchant proposal is missing.');
    }
  }

  rejectCategory(proposal: CategoryProposalV1, rejectedAt: string): void {
    assertClassificationTimestamp(rejectedAt);
    validateCategoryProposal(proposal);
    const result = this.database
      .prepare(
        "UPDATE classification_reviews SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(rejectedAt, proposal.reviewId);
    if (result.changes !== 1) {
      throw new Error('Pending category review is missing.');
    }
  }

  listClassificationReviews(): readonly ClassificationReviewRecordV1[] {
    const merchants = this.database
      .prepare(
        "SELECT * FROM merchant_normalization_proposals ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, confidence DESC, created_at, id",
      )
      .all() as readonly MerchantProposalRow[];
    const categories = this.database
      .prepare(
        "SELECT * FROM classification_reviews ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, confidence DESC, created_at, id",
      )
      .all() as readonly CategoryReviewRow[];
    return [
      ...merchants.map(merchantReviewRecord),
      ...categories.map(categoryReviewRecord),
    ].sort(compareReviewRecords);
  }

  recordClassificationDecision(
    record: ClassificationReviewRecordV1,
    status: 'approved' | 'rejected',
    selectedAction: ClassificationReviewAction | null,
    decidedAt: string,
  ): ClassificationReviewRecordV1 {
    assertClassificationTimestamp(decidedAt);
    if (
      (status === 'rejected' && selectedAction !== null) ||
      (status === 'approved' && selectedAction === null) ||
      (record.proposal.kind === 'merchant-alias' &&
        status === 'approved' &&
        selectedAction !== 'create_rule')
    ) {
      throw new Error('Classification review decision is invalid.');
    }
    const proposalId = reviewProposalId(record);
    const table = reviewTable(record);
    const result =
      record.proposal.kind === 'category'
        ? this.database
            .prepare(
              `UPDATE ${table} SET status = ?, proposed_action = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
            )
            .run(
              status,
              selectedAction === 'create_rule'
                ? 'create_rule'
                : 'categorize_once',
              decidedAt,
              proposalId,
            )
        : this.database
            .prepare(
              `UPDATE ${table} SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
            )
            .run(status, decidedAt, proposalId);
    if (result.changes !== 1) {
      throw new Error('Pending classification review is missing.');
    }
    return this.readClassificationReview(record);
  }

  markClassificationReviewStale(
    record: ClassificationReviewRecordV1,
  ): ClassificationReviewRecordV1 {
    const proposalId = reviewProposalId(record);
    this.database
      .prepare(
        `UPDATE ${reviewTable(record)} SET status = 'stale' WHERE id = ? AND status IN ('pending', 'approved')`,
      )
      .run(proposalId);
    return this.readClassificationReview(record);
  }

  private readClassificationReview(
    record: ClassificationReviewRecordV1,
  ): ClassificationReviewRecordV1 {
    const row = this.database
      .prepare(`SELECT * FROM ${reviewTable(record)} WHERE id = ?`)
      .get(reviewProposalId(record));
    if (row === undefined) {
      throw new Error('Classification review is missing.');
    }
    return record.proposal.kind === 'merchant-alias'
      ? merchantReviewRecord(row as MerchantProposalRow)
      : categoryReviewRecord(row as CategoryReviewRow);
  }
}

function decodeMerchantProposal(
  row: MerchantProposalRow,
): MerchantAliasProposalV1 {
  assertClassificationTimestamp(row.created_at);
  if (row.decided_at !== null) assertClassificationTimestamp(row.decided_at);
  if (
    !isClassificationStatus(row.status) ||
    (row.status === 'pending' && row.decided_at !== null) ||
    (['approved', 'rejected', 'applied'].includes(row.status) &&
      row.decided_at === null)
  ) {
    throw new Error('Stored merchant proposal status is unsupported.');
  }
  const metadata = parseMerchantMetadata(row.proposal_metadata_json);
  const proposal: MerchantAliasProposalV1 = {
    confidence: row.confidence,
    detectorVersion: metadata.detectorVersion,
    evidenceTransactionIds: metadata.evidenceTransactionIds,
    kind: 'merchant-alias',
    normalizedImportedPayee: row.normalized_imported_payee,
    proposalId: row.id,
    proposedPayeeId: row.proposed_actual_payee_id,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    sourceSpellings: metadata.sourceSpellings,
  };
  validateMerchantProposal(proposal);
  if (
    row.imported_payee !== proposal.sourceSpellings[0] ||
    row.evidence_count !== proposal.evidenceTransactionIds.length ||
    row.detector_version !== proposal.detectorVersion
  ) {
    throw new Error('Stored merchant proposal columns disagree.');
  }
  return proposal;
}

function decodeCategoryProposal(row: CategoryReviewRow): CategoryProposalV1 {
  assertClassificationTimestamp(row.created_at);
  if (row.decided_at !== null) assertClassificationTimestamp(row.decided_at);
  if (
    !isClassificationStatus(row.status) ||
    !['categorize_once', 'create_rule'].includes(row.proposed_action) ||
    (row.status === 'pending' && row.decided_at !== null) ||
    (['approved', 'rejected', 'applied'].includes(row.status) &&
      row.decided_at === null)
  ) {
    throw new Error('Stored category review state is unsupported.');
  }
  const metadata = parseCategoryMetadata(row.proposal_metadata_json);
  const proposal: CategoryProposalV1 = {
    accountId: metadata.accountId,
    confidence: row.confidence,
    detectorVersion: metadata.detectorVersion,
    eligibleHistoryCount: metadata.eligibleHistoryCount,
    kind: 'category',
    payeeId: metadata.payeeId,
    proposedCategoryCount: metadata.proposedCategoryCount,
    proposedCategoryId: row.proposed_category_id,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    reviewId: row.id,
    targetVersionHash: row.actual_target_version,
    transactionId: row.actual_transaction_id,
  };
  validateCategoryProposal(proposal);
  if (row.detector_version !== proposal.detectorVersion) {
    throw new Error('Stored category review columns disagree.');
  }
  return proposal;
}

function assertExistingMerchantProposalMatches(
  database: Database.Database,
  proposal: MerchantAliasProposalV1,
): void {
  const row = database
    .prepare('SELECT * FROM merchant_normalization_proposals WHERE id = ?')
    .get(proposal.proposalId) as MerchantProposalRow | undefined;
  if (row === undefined) {
    throw new Error('Existing merchant proposal does not match the insert.');
  }
  const existingProposal = decodeMerchantProposal(row);
  if (
    row.status !== 'pending' ||
    canonicalJson(existingProposal) !== canonicalJson(proposal)
  ) {
    throw new Error('Existing merchant proposal does not match the insert.');
  }
}

function assertExistingCategoryProposalMatches(
  database: Database.Database,
  proposal: CategoryProposalV1,
): void {
  const row = database
    .prepare('SELECT * FROM classification_reviews WHERE id = ?')
    .get(proposal.reviewId) as CategoryReviewRow | undefined;
  if (row === undefined) {
    throw new Error('Existing category review does not match the insert.');
  }
  const existingProposal = decodeCategoryProposal(row);
  if (
    row.status !== 'pending' ||
    canonicalJson(existingProposal) !== canonicalJson(proposal)
  ) {
    throw new Error('Existing category review does not match the insert.');
  }
}

function validateMerchantProposal(proposal: MerchantAliasProposalV1): void {
  if (
    proposal.kind !== 'merchant-alias' ||
    proposal.detectorVersion !== 1 ||
    !proposal.normalizedImportedPayee ||
    normalizeImportedPayeeV1(proposal.normalizedImportedPayee) !==
      proposal.normalizedImportedPayee ||
    !proposal.proposedPayeeId ||
    !isSortedUniqueStrings(proposal.sourceSpellings, 20) ||
    proposal.sourceSpellings.some(
      sourceSpelling =>
        normalizeImportedPayeeV1(sourceSpelling) !==
        proposal.normalizedImportedPayee,
    ) ||
    !isSortedUniqueStrings(proposal.evidenceTransactionIds) ||
    proposal.confidence !==
      Math.min(100, 60 + 10 * proposal.evidenceTransactionIds.length) ||
    canonicalJson(proposal.reasonCodes) !==
      canonicalJson(['consistent-imported-payee-alias']) ||
    proposal.proposalId !==
      merchantAliasProposalId(
        proposal.normalizedImportedPayee,
        proposal.proposedPayeeId,
        proposal.detectorVersion,
      )
  ) {
    throw new Error('Stored merchant proposal DTO is invalid.');
  }
}

function validateCategoryProposal(proposal: CategoryProposalV1): void {
  if (
    proposal.kind !== 'category' ||
    proposal.detectorVersion !== 1 ||
    !proposal.transactionId ||
    !proposal.accountId ||
    !proposal.payeeId ||
    !proposal.proposedCategoryId ||
    !isHash(proposal.targetVersionHash) ||
    !isIntegerInRange(
      proposal.eligibleHistoryCount,
      3,
      Number.MAX_SAFE_INTEGER,
    ) ||
    !isIntegerInRange(
      proposal.proposedCategoryCount,
      3,
      proposal.eligibleHistoryCount,
    ) ||
    !isIntegerInRange(proposal.confidence, 0, 100) ||
    proposal.proposedCategoryCount * 5 < proposal.eligibleHistoryCount * 4 ||
    proposal.confidence !==
      Math.round(
        (proposal.proposedCategoryCount / proposal.eligibleHistoryCount) * 100,
      ) ||
    canonicalJson(proposal.reasonCodes) !==
      canonicalJson(['dominant-category-history']) ||
    proposal.reviewId !==
      categoryProposalReviewId(
        proposal.transactionId,
        proposal.proposedCategoryId,
        proposal.targetVersionHash,
        proposal.detectorVersion,
      )
  ) {
    throw new Error('Stored category proposal DTO is invalid.');
  }
}

function merchantMetadata(proposal: MerchantAliasProposalV1) {
  return {
    contractVersion: 1,
    detectorVersion: proposal.detectorVersion,
    evidenceTransactionIds: proposal.evidenceTransactionIds,
    sourceSpellings: proposal.sourceSpellings,
  };
}

function categoryMetadata(proposal: CategoryProposalV1) {
  return {
    accountId: proposal.accountId,
    contractVersion: 1,
    detectorVersion: proposal.detectorVersion,
    eligibleHistoryCount: proposal.eligibleHistoryCount,
    payeeId: proposal.payeeId,
    proposedCategoryCount: proposal.proposedCategoryCount,
  };
}

function parseMerchantMetadata(serialized: string): Readonly<{
  contractVersion: 1;
  detectorVersion: 1;
  evidenceTransactionIds: readonly string[];
  sourceSpellings: readonly string[];
}> {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecordWithExactKeys(value, [
      'contractVersion',
      'detectorVersion',
      'evidenceTransactionIds',
      'sourceSpellings',
    ]) ||
    value.contractVersion !== 1 ||
    value.detectorVersion !== 1 ||
    !isStringArray(value.evidenceTransactionIds) ||
    !isStringArray(value.sourceSpellings)
  ) {
    throw new Error('Stored merchant proposal metadata is invalid.');
  }
  return {
    contractVersion: 1,
    detectorVersion: 1,
    evidenceTransactionIds: value.evidenceTransactionIds,
    sourceSpellings: value.sourceSpellings,
  };
}

function parseCategoryMetadata(serialized: string): Readonly<{
  accountId: string;
  contractVersion: 1;
  detectorVersion: 1;
  eligibleHistoryCount: number;
  payeeId: string;
  proposedCategoryCount: number;
}> {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecordWithExactKeys(value, [
      'accountId',
      'contractVersion',
      'detectorVersion',
      'eligibleHistoryCount',
      'payeeId',
      'proposedCategoryCount',
    ]) ||
    typeof value.accountId !== 'string' ||
    value.contractVersion !== 1 ||
    value.detectorVersion !== 1 ||
    typeof value.eligibleHistoryCount !== 'number' ||
    typeof value.payeeId !== 'string' ||
    typeof value.proposedCategoryCount !== 'number'
  ) {
    throw new Error('Stored category proposal metadata is invalid.');
  }
  return {
    accountId: value.accountId,
    contractVersion: 1,
    detectorVersion: 1,
    eligibleHistoryCount: value.eligibleHistoryCount,
    payeeId: value.payeeId,
    proposedCategoryCount: value.proposedCategoryCount,
  };
}

function parseReasonCodes(
  serialized: string,
): readonly ClassificationReasonCode[] {
  const value: unknown = JSON.parse(serialized);
  if (!isStringArray(value) || !isReasonCodeArray(value)) {
    throw new Error('Stored classification reason codes are invalid.');
  }
  return value;
}

function requiredDecisionTimestamp(
  row: MerchantProposalRow | CategoryReviewRow,
): string {
  if (row.decided_at === null || row.status !== 'rejected') {
    throw new Error('Stored classification rejection is invalid.');
  }
  assertClassificationTimestamp(row.decided_at);
  return row.decided_at;
}

function isWithinSuppressionWindow(
  rejectedAt: string,
  evaluatedAt: string,
): boolean {
  return (
    Date.parse(evaluatedAt) - Date.parse(rejectedAt) <
    classificationRejectionSuppressionMilliseconds
  );
}

function isReasonCodeArray(
  value: readonly string[],
): value is readonly ClassificationReasonCode[] {
  const allowed = new Set<string>(classificationReasonCodes);
  return value.length > 0 && value.every(reasonCode => allowed.has(reasonCode));
}

function isSortedUniqueStrings(
  value: readonly string[],
  maximum = Infinity,
): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    value.every(item => item.length > 0) &&
    value.every(
      (item, index) => index === 0 || compareUtf8(value[index - 1], item) < 0,
    )
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
  );
}

function merchantReviewRecord(
  row: MerchantProposalRow,
): ClassificationReviewRecordV1 {
  return {
    proposal: decodeMerchantProposal(row),
    status: requireClassificationStatus(row.status),
    selectedAction:
      row.status === 'approved' || row.status === 'applied'
        ? 'create_rule'
        : null,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function categoryReviewRecord(
  row: CategoryReviewRow,
): ClassificationReviewRecordV1 {
  const status = requireClassificationStatus(row.status);
  return {
    proposal: decodeCategoryProposal(row),
    status,
    selectedAction:
      status === 'approved' || status === 'applied'
        ? row.proposed_action === 'create_rule'
          ? 'create_rule'
          : 'categorize_once'
        : null,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function compareReviewRecords(
  left: ClassificationReviewRecordV1,
  right: ClassificationReviewRecordV1,
): number {
  const leftPending = left.status === 'pending' ? 0 : 1;
  const rightPending = right.status === 'pending' ? 0 : 1;
  return (
    leftPending - rightPending ||
    right.proposal.confidence - left.proposal.confidence ||
    left.createdAt.localeCompare(right.createdAt) ||
    reviewProposalId(left).localeCompare(reviewProposalId(right))
  );
}

function reviewProposalId(record: ClassificationReviewRecordV1): string {
  return record.proposal.kind === 'merchant-alias'
    ? record.proposal.proposalId
    : record.proposal.reviewId;
}

function reviewTable(
  record: ClassificationReviewRecordV1,
): 'merchant_normalization_proposals' | 'classification_reviews' {
  return record.proposal.kind === 'merchant-alias'
    ? 'merchant_normalization_proposals'
    : 'classification_reviews';
}

function requireClassificationStatus(
  value: string,
): ClassificationReviewStatus {
  if (!isClassificationStatus(value)) {
    throw new Error('Stored classification review status is unsupported.');
  }
  return value;
}

function isClassificationStatus(
  value: string,
): value is ClassificationReviewStatus {
  return ['pending', 'approved', 'rejected', 'stale', 'applied'].includes(
    value,
  );
}
