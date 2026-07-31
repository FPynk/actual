import {
  createReconciliationReviewListDto,
  readReconciliationReviewCandidate,
} from '#reconciliation-review';
import type {
  ReconciliationCandidateRepository,
  ReconciliationCandidateV1,
} from '#reconciliation/candidates';

const candidates: readonly ReconciliationCandidateV1[] = [
  candidate('private-source-one', 'private-actual-one'),
  candidate('private-source-one', 'private-actual-two'),
];
const budgetKeyHash = 'b'.repeat(64);

describe('reconciliation review DTO', () => {
  it('presents a versioned, human-readable DTO without private identifiers or hashes', () => {
    const dto = createReconciliationReviewListDto(
      repository(candidates),
      budgetKeyHash,
    );
    expect(dto.version).toBe(1);
    expect(dto.candidates[0]).toMatchObject({
      confidence: 'Strong match',
      competingCandidateCount: 1,
      reasons: expect.arrayContaining(['Account matches exactly']),
      evidence: null,
    });
    expect(dto.candidates[0]?.reviewId).toMatch(/^review_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(dto)).not.toContain('private-source');
    expect(JSON.stringify(dto)).not.toContain('private-actual');
    expect(JSON.stringify(dto)).not.toContain('a'.repeat(64));
  });

  it('keeps a candidate reference stable across insertion and reordering', () => {
    const initial = createReconciliationReviewListDto(
      repository(candidates),
      budgetKeyHash,
    );
    const firstReviewId = initial.candidates[0]?.reviewId;
    const firstCandidate = candidates[0];
    const secondCandidate = candidates[1];
    if (
      firstReviewId === undefined ||
      firstCandidate === undefined ||
      secondCandidate === undefined
    ) {
      throw new Error('Missing review fixture.');
    }
    const inserted = candidate('private-source-new', 'private-actual-new');
    const reordered = [secondCandidate, inserted, firstCandidate];
    const afterReorder = createReconciliationReviewListDto(
      repository(reordered),
      budgetKeyHash,
    );
    expect(
      afterReorder.candidates.find(item => item.reviewId === firstReviewId),
    ).toBeDefined();
    expect(
      readReconciliationReviewCandidate(
        repository(reordered),
        firstReviewId,
        budgetKeyHash,
      )?.id,
    ).toBe('candidate-1');
  });
});

function candidate(
  sourceTransactionId: string,
  actualTransactionId: string,
): ReconciliationCandidateV1 {
  return {
    id: actualTransactionId.endsWith('one')
      ? 'candidate-1'
      : actualTransactionId.endsWith('two')
        ? 'candidate-2'
        : 'candidate-new',
    sourceTransactionId,
    actualTransactionId,
    actualTargetVersion: 'a'.repeat(64),
    score: 95,
    reasonCodes: ['source-observation', 'exact-account'],
    matcherVersion: 1,
    status: 'pending',
    decisionNote: null,
    decidedAt: null,
    createdAt: '2026-07-31T12:00:00.000Z',
  };
}

function repository(
  items: readonly ReconciliationCandidateV1[],
): ReconciliationCandidateRepository {
  return {
    findBySourceAndActual: () => undefined,
    save: candidate => candidate,
    list: () => items,
    read: candidateId => {
      const candidate = items.find(item => item.id === candidateId);
      if (candidate === undefined) throw new Error('missing');
      return candidate;
    },
    recordRevalidatedDecision: () => {
      throw new Error('not used');
    },
    markStale: candidateId =>
      items.find(item => item.id === candidateId) ??
      (() => {
        throw new Error('missing');
      })(),
  };
}
