import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionGraphV1,
} from '#contracts/adapter';
import { targetVersionHash } from '#reviews/classification';
import {
  createClassificationReviewListDto,
  createClassificationReviewRef,
  decideClassificationReview,
  readClassificationReviewDetail,
} from '#reviews/classification-review';
import type {
  ClassificationReviewRecordV1,
  ClassificationReviewRepository,
} from '#reviews/classification-review';

const budgetKeyHash = 'a'.repeat(64);
const decidedAt = '2026-07-31T12:01:00.000Z';

describe('classification review DTO and decisions', () => {
  it('uses stable opaque references and returns sanitized merchant evidence', async () => {
    const record = merchantRecord();
    const repository = mutableRepository(record);
    const adapter = readOnlyAdapter(snapshot());
    const list = createClassificationReviewListDto(repository, budgetKeyHash);
    const serializedList = JSON.stringify(list);
    expect(list.reviews[0]?.reviewRef).toMatch(
      /^classification_[A-Za-z0-9_-]{43}$/,
    );
    expect(serializedList).not.toContain('private-proposal-id');
    expect(serializedList).not.toContain('private-payee-id');
    expect(serializedList).not.toContain('private-transaction-id');

    const detail = await readClassificationReviewDetail(
      createClassificationReviewRef(record, budgetKeyHash),
      dependencies(adapter, repository),
    );
    expect(detail).toMatchObject({
      allowedActions: ['create_rule'],
      evidence: {
        currentPayee: 'Coffee Payee',
        importedMerchantLabels: ['Coffee Shop', 'Coffee Store'],
        kind: 'merchant',
        proposedPayee: 'Coffee Payee',
      },
      selectedAction: null,
    });
    const serializedDetail = JSON.stringify(detail);
    expect(serializedDetail).not.toContain('private-payee-id');
    expect(serializedDetail).not.toContain('private-transaction-id');
  });

  it.each(['categorize_once', 'create_rule'] as const)(
    'records explicit %s guidance after fresh Actual reads only',
    async action => {
      const graph = currentGraph();
      const record = categoryRecord(graph.targetVersionHash);
      const repository = mutableRepository(record);
      const actualSnapshot = snapshot();
      const unchangedActual = JSON.stringify({
        graph,
        snapshot: actualSnapshot,
      });
      const requests: string[] = [];
      const adapter = readOnlyAdapter(actualSnapshot, graph, requests);

      const detail = await decideClassificationReview(
        {
          action,
          decidedAt,
          decision: 'approve',
          reviewRef: createClassificationReviewRef(record, budgetKeyHash),
        },
        dependencies(adapter, repository),
      );

      expect(detail).toMatchObject({
        selectedAction: action,
        status: 'approved',
      });
      expect(detail?.guidance).toContain('Finance Companion did not');
      expect(requests).toEqual(['read-actual-target', 'read-budget-snapshot']);
      expect(requests).not.toContain('run-account-bank-sync');
      expect(JSON.stringify({ graph, snapshot: actualSnapshot })).toBe(
        unchangedActual,
      );
    },
  );

  it('records merchant rule guidance after revalidating the Actual payee', async () => {
    const record = merchantRecord();
    const repository = mutableRepository(record);
    const requests: string[] = [];
    const detail = await decideClassificationReview(
      {
        action: 'create_rule',
        decidedAt,
        decision: 'approve',
        reviewRef: createClassificationReviewRef(record, budgetKeyHash),
      },
      dependencies(readOnlyAdapter(snapshot(), null, requests), repository),
    );

    expect(detail).toMatchObject({
      kind: 'merchant',
      selectedAction: 'create_rule',
      status: 'approved',
    });
    expect(detail?.guidance).toContain('payee rename rule');
    expect(requests).toEqual(['read-budget-snapshot']);
  });

  it('marks an intervening Actual edit stale without recording a decision', async () => {
    const original = currentGraph();
    const changed = currentGraph({ categoryId: 'private-category-id' });
    const repository = mutableRepository(
      categoryRecord(original.targetVersionHash),
    );
    const recordDecision = vi.spyOn(repository, 'recordClassificationDecision');

    const detail = await decideClassificationReview(
      {
        action: 'categorize_once',
        decidedAt,
        decision: 'approve',
        reviewRef: createClassificationReviewRef(
          repository.listClassificationReviews()[0]!,
          budgetKeyHash,
        ),
      },
      dependencies(readOnlyAdapter(snapshot(), changed), repository),
    );

    expect(detail?.status).toBe('stale');
    expect(detail?.guidance).toBeNull();
    expect(recordDecision).not.toHaveBeenCalled();
  });
});

function dependencies(
  adapter: ActualAdapter,
  repository: ClassificationReviewRepository,
) {
  return {
    adapter,
    budgetKeyHash,
    currencyCode: 'USD',
    repository,
  };
}

function mutableRepository(
  initial: ClassificationReviewRecordV1,
): ClassificationReviewRepository {
  let record = initial;
  return {
    listClassificationReviews: () => [record],
    markClassificationReviewStale: () => {
      record = { ...record, status: 'stale' };
      return record;
    },
    recordClassificationDecision: (
      _record,
      status,
      selectedAction,
      timestamp,
    ) => {
      record = {
        ...record,
        decidedAt: timestamp,
        selectedAction,
        status,
      };
      return record;
    },
  };
}

function readOnlyAdapter(
  budgetSnapshot: ActualBudgetSnapshotV1,
  graph: ActualTransactionGraphV1 | null = null,
  requests: string[] = [],
): ActualAdapter {
  return {
    execute: async request => {
      requests.push(request.kind);
      if (request.kind === 'read-actual-target') {
        return { kind: 'read-actual-target', target: graph };
      }
      if (request.kind === 'read-budget-snapshot') {
        return { kind: 'read-budget-snapshot', snapshot: budgetSnapshot };
      }
      throw new Error('Classification review must not make an Actual write.');
    },
    getActiveOperationStatus: () => null,
    getHealth: () => 'healthy',
  };
}

function merchantRecord(): ClassificationReviewRecordV1 {
  return {
    createdAt: '2026-07-31T12:00:00.000Z',
    decidedAt: null,
    proposal: {
      confidence: 80,
      detectorVersion: 1,
      evidenceTransactionIds: [
        'private-transaction-id',
        'private-transaction-id-2',
      ],
      kind: 'merchant-alias',
      normalizedImportedPayee: 'coffee shop',
      proposalId: 'private-proposal-id',
      proposedPayeeId: 'private-payee-id',
      reasonCodes: ['consistent-imported-payee-alias'],
      sourceSpellings: ['Coffee Shop', 'Coffee Store'],
    },
    selectedAction: null,
    status: 'pending',
  };
}

function categoryRecord(targetHash: string): ClassificationReviewRecordV1 {
  return {
    createdAt: '2026-07-31T12:00:00.000Z',
    decidedAt: null,
    proposal: {
      accountId: 'private-account-id',
      confidence: 100,
      detectorVersion: 1,
      eligibleHistoryCount: 4,
      kind: 'category',
      payeeId: 'private-payee-id',
      proposedCategoryCount: 4,
      proposedCategoryId: 'private-category-id',
      reasonCodes: ['dominant-category-history'],
      reviewId: 'private-category-review-id',
      targetVersionHash: targetHash,
      transactionId: 'private-target-id',
    },
    selectedAction: null,
    status: 'pending',
  };
}

function currentGraph(
  overrides: Readonly<{ categoryId?: string | null }> = {},
): ActualTransactionGraphV1 {
  const parent = {
    id: 'private-target-id',
    accountId: 'private-account-id',
    parentId: null,
    transferId: null,
    date: '2026-07-30',
    amountMinorUnits: -1250,
    payeeId: 'private-payee-id',
    categoryId: overrides.categoryId ?? null,
    notes: 'private note that must never appear',
    importedId: 'private imported id',
    importedPayee: 'Coffee Shop',
    cleared: true,
    reconciled: false,
    isParent: false,
    isChild: false,
    isStartingBalance: false,
    tombstone: false,
  } as const;
  const canonical = { children: [], contractVersion: 1 as const, parent };
  return { ...canonical, targetVersionHash: targetVersionHash(canonical) };
}

function snapshot(): ActualBudgetSnapshotV1 {
  return {
    contractVersion: 1,
    budget: {
      budgetKeyHash,
      capturedAt: '2026-07-31T12:00:30.000Z',
      currencyCode: 'USD',
    },
    accounts: [
      {
        id: 'private-account-id',
        name: 'Checking',
        offBudget: false,
        closed: false,
        syncSource: null,
        lastSync: null,
        syncStatus: null,
      },
    ],
    payees: [
      {
        id: 'private-payee-id',
        name: 'Coffee Payee',
        transferAccountId: null,
      },
    ],
    categories: [
      {
        id: 'private-category-id',
        name: 'Dining',
        groupId: 'private-group-id',
        isIncome: false,
        hidden: false,
      },
    ],
  };
}
