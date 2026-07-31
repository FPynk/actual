import type {
  CategoryProposalV1,
  ClassificationProposalRepository,
  MerchantAliasProposalV1,
} from '#reviews/classification';
import {
  assertClassificationTimestamp,
  classificationRejectionSuppressionMilliseconds,
} from '#reviews/classification';

type Rejection = Readonly<{ rejectedAt: number }>;

export class InMemoryClassificationProposalRepository implements ClassificationProposalRepository {
  private readonly pendingMerchantAliases = new Map<
    string,
    MerchantAliasProposalV1
  >();
  private readonly pendingCategories = new Map<string, CategoryProposalV1>();
  private readonly merchantAliasRejections = new Map<string, Rejection>();
  private readonly categoryRejections = new Map<string, Rejection>();

  findPendingMerchantAlias(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
  ): MerchantAliasProposalV1 | undefined {
    return this.pendingMerchantAliases.get(
      merchantAliasKey(normalizedImportedPayee, payeeId, detectorVersion),
    );
  }

  findPendingCategory(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
  ): CategoryProposalV1 | undefined {
    return this.pendingCategories.get(
      categoryKey(
        transactionId,
        categoryId,
        targetVersionHash,
        detectorVersion,
      ),
    );
  }

  isMerchantAliasRejected(
    normalizedImportedPayee: string,
    payeeId: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean {
    return isRejectedWithinSuppressionWindow(
      this.merchantAliasRejections.get(
        merchantAliasKey(normalizedImportedPayee, payeeId, detectorVersion),
      ),
      evaluatedAt,
    );
  }

  isCategoryRejected(
    transactionId: string,
    categoryId: string,
    targetVersionHash: string,
    detectorVersion: number,
    evaluatedAt: string,
  ): boolean {
    return isRejectedWithinSuppressionWindow(
      this.categoryRejections.get(
        categoryKey(
          transactionId,
          categoryId,
          targetVersionHash,
          detectorVersion,
        ),
      ),
      evaluatedAt,
    );
  }

  savePendingMerchantAlias(
    proposal: MerchantAliasProposalV1,
    evaluatedAt: string,
  ): void {
    assertClassificationTimestamp(evaluatedAt);
    this.pendingMerchantAliases.set(
      merchantAliasKey(
        proposal.normalizedImportedPayee,
        proposal.proposedPayeeId,
        proposal.detectorVersion,
      ),
      proposal,
    );
  }

  savePendingCategory(proposal: CategoryProposalV1, evaluatedAt: string): void {
    assertClassificationTimestamp(evaluatedAt);
    this.pendingCategories.set(
      categoryKey(
        proposal.transactionId,
        proposal.proposedCategoryId,
        proposal.targetVersionHash,
        proposal.detectorVersion,
      ),
      proposal,
    );
  }

  rejectMerchantAlias(
    proposal: MerchantAliasProposalV1,
    rejectedAt: string,
  ): void {
    assertClassificationTimestamp(rejectedAt);
    const key = merchantAliasKey(
      proposal.normalizedImportedPayee,
      proposal.proposedPayeeId,
      proposal.detectorVersion,
    );
    this.pendingMerchantAliases.delete(key);
    this.merchantAliasRejections.set(key, {
      rejectedAt: Date.parse(rejectedAt),
    });
  }

  rejectCategory(proposal: CategoryProposalV1, rejectedAt: string): void {
    assertClassificationTimestamp(rejectedAt);
    const key = categoryKey(
      proposal.transactionId,
      proposal.proposedCategoryId,
      proposal.targetVersionHash,
      proposal.detectorVersion,
    );
    this.pendingCategories.delete(key);
    this.categoryRejections.set(key, { rejectedAt: Date.parse(rejectedAt) });
  }
}

function isRejectedWithinSuppressionWindow(
  rejection: Rejection | undefined,
  evaluatedAt: string,
): boolean {
  assertClassificationTimestamp(evaluatedAt);
  return (
    rejection !== undefined &&
    Date.parse(evaluatedAt) - rejection.rejectedAt <
      classificationRejectionSuppressionMilliseconds
  );
}

function merchantAliasKey(
  normalizedImportedPayee: string,
  payeeId: string,
  detectorVersion: number,
): string {
  return `${detectorVersion}\0${normalizedImportedPayee}\0${payeeId}`;
}

function categoryKey(
  transactionId: string,
  categoryId: string,
  targetVersionHash: string,
  detectorVersion: number,
): string {
  return `${detectorVersion}\0${transactionId}\0${categoryId}\0${targetVersionHash}`;
}
