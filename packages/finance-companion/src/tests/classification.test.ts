import { createHash } from 'node:crypto';

import { canonicalJson } from '#actual/canonical-json';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import {
  createClassificationRuleSetSnapshot,
  detectClassificationProposals,
  normalizeImportedPayeeV1,
  targetVersionHash,
  validateCategoryProposal,
  validateClassificationRuleIntent,
} from '#reviews/classification';
import { InMemoryClassificationProposalRepository } from '#reviews/in-memory-classification-repository';

const evaluatedAt = '2026-07-31T12:00:00.000Z';
const emptyRuleSetSnapshot = createClassificationRuleSetSnapshot([]);

describe('classification proposals', () => {
  it.each([
    {
      name: 'creates a normalized alias proposal from agreeing evidence',
      snapshot: snapshot([
        transaction({ id: 'alias-1', importedPayee: 'Caf\u00e9\u00a0Store' }),
        transaction({ id: 'alias-2', importedPayee: '  caf\u00e9 store  ' }),
      ]),
      expectedProposalKinds: ['merchant-alias'],
      expectedSuppressions: [],
    },
    {
      name: 'suppresses conflicting aliases',
      snapshot: snapshot([
        transaction({ id: 'alias-1' }),
        transaction({ id: 'alias-2', payeeId: 'payee-2' }),
      ]),
      expectedProposalKinds: [],
      expectedSuppressions: ['conflicting-payee-alias'],
    },
    {
      name: 'requires exactly three categorized history rows',
      snapshot: snapshot([
        transaction({ id: 'history-1', categoryId: 'category-1' }),
        transaction({ id: 'history-2', categoryId: 'category-1' }),
        transaction({ id: 'target', categoryId: null }),
      ]),
      expectedProposalKinds: ['merchant-alias'],
      expectedSuppressions: ['insufficient-history'],
    },
    {
      name: 'requires an eighty percent category majority',
      snapshot: snapshot([
        transaction({ id: 'history-1', categoryId: 'category-1' }),
        transaction({ id: 'history-2', categoryId: 'category-1' }),
        transaction({ id: 'history-3', categoryId: 'category-1' }),
        transaction({ id: 'history-4', categoryId: 'category-1' }),
        transaction({ id: 'history-5', categoryId: 'category-2' }),
        transaction({ id: 'target', categoryId: null }),
      ]),
      expectedProposalKinds: ['category', 'merchant-alias'],
      expectedSuppressions: [],
    },
    {
      name: 'suppresses a deleted dominant category as stale',
      snapshot: snapshot(
        [
          transaction({ id: 'history-1', categoryId: 'deleted-category' }),
          transaction({ id: 'history-2', categoryId: 'deleted-category' }),
          transaction({ id: 'history-3', categoryId: 'deleted-category' }),
          transaction({ id: 'target', categoryId: null }),
        ],
        { categories: [] },
      ),
      expectedProposalKinds: ['merchant-alias'],
      expectedSuppressions: ['category-deleted', 'target-stale'],
    },
  ])(
    '$name without changing the Actual snapshot',
    ({
      snapshot: inputSnapshot,
      expectedProposalKinds,
      expectedSuppressions,
    }) => {
      const beforeDetection = JSON.stringify(inputSnapshot);
      const result = detectClassificationProposals({
        boundBudgetCurrency: 'USD',
        evaluatedAt,
        repository: new InMemoryClassificationProposalRepository(),
        ruleSetSnapshot: emptyRuleSetSnapshot,
        snapshot: inputSnapshot,
      });

      expect(JSON.stringify(inputSnapshot)).toBe(beforeDetection);
      expect(
        result.proposals.map(record => record.proposal.kind).sort(),
      ).toEqual(expectedProposalKinds);
      expect(
        result.suppressions.flatMap(suppression => suppression.reasonCodes),
      ).toEqual(expect.arrayContaining(expectedSuppressions));
    },
  );

  it('keeps one-time categorization distinct from rule creation metadata', () => {
    const result = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository: new InMemoryClassificationProposalRepository(),
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: snapshot([
        transaction({ id: 'history-1', categoryId: 'category-1' }),
        transaction({ id: 'history-2', categoryId: 'category-1' }),
        transaction({ id: 'history-3', categoryId: 'category-1' }),
        transaction({ id: 'target', categoryId: null }),
      ]),
    });
    const categoryRecord = result.proposals.find(
      record => record.proposal.kind === 'category',
    );

    expect(categoryRecord?.availableIntents).toEqual([
      { kind: 'categorize_once' },
      {
        expectedRuleSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        kind: 'create_category_rule',
      },
    ]);
    expect(categoryRecord?.proposal.kind).toBe('category');
    expect('rule' in (categoryRecord?.proposal ?? {})).toBe(false);
  });

  it('does not count transfer payees as merchant alias evidence', () => {
    const result = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository: new InMemoryClassificationProposalRepository(),
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: snapshot(
        [
          transaction({ id: 'alias-1' }),
          transaction({ id: 'transfer', payeeId: 'transfer-payee' }),
          transaction({ id: 'alias-2' }),
        ],
        {
          payees: [
            { id: 'payee-1', name: 'Coffee Shop', transferAccountId: null },
            {
              id: 'transfer-payee',
              name: 'Transfer',
              transferAccountId: 'account-2',
            },
          ],
        },
      ),
    });
    const proposal = result.proposals.find(
      record => record.proposal.kind === 'merchant-alias',
    )?.proposal;

    expect(proposal).toMatchObject({
      evidenceTransactionIds: ['alias-1', 'alias-2'],
      proposedPayeeId: 'payee-1',
    });
  });

  it('suppresses a rejected semantic proposal for 180 days but not afterward', () => {
    const repository = new InMemoryClassificationProposalRepository();
    const inputSnapshot = snapshot([
      transaction({ id: 'alias-1' }),
      transaction({ id: 'alias-2' }),
    ]);
    const initialResult = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository,
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: inputSnapshot,
    });
    const proposal = initialResult.proposals[0]?.proposal;
    expect(proposal?.kind).toBe('merchant-alias');
    if (proposal?.kind !== 'merchant-alias') {
      throw new Error('Missing alias proposal');
    }
    repository.rejectMerchantAlias(proposal, evaluatedAt);

    const suppressedResult = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt: '2027-01-26T11:59:59.999Z',
      repository,
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: inputSnapshot,
    });
    const reissuedResult = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt: '2027-01-27T12:00:00.000Z',
      repository,
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: inputSnapshot,
    });

    expect(suppressedResult.proposals).toEqual([]);
    expect(suppressedResult.suppressions).toContainEqual({
      kind: 'merchant-alias',
      reasonCodes: ['suppressed'],
      subjectId: 'coffee shop',
    });
    expect(
      reissuedResult.proposals.map(record => record.proposal.kind),
    ).toEqual(['merchant-alias']);
  });

  it.each([
    {
      change: { reconciled: true },
      expectedReason: 'target-reconciled',
    },
    {
      change: { isChild: true, parentId: 'split-parent' },
      expectedReason: 'target-split',
    },
    {
      change: { categoryId: 'category-1' },
      expectedReason: 'target-already-categorized',
    },
  ])(
    'marks a changed target as stale when it is $expectedReason',
    ({ change, expectedReason }) => {
      const originalSnapshot = snapshot([
        transaction({ id: 'history-1', categoryId: 'category-1' }),
        transaction({ id: 'history-2', categoryId: 'category-1' }),
        transaction({ id: 'history-3', categoryId: 'category-1' }),
        transaction({ id: 'target', categoryId: null }),
      ]);
      const initialResult = detectClassificationProposals({
        boundBudgetCurrency: 'USD',
        evaluatedAt,
        repository: new InMemoryClassificationProposalRepository(),
        ruleSetSnapshot: emptyRuleSetSnapshot,
        snapshot: originalSnapshot,
      });
      const proposal = initialResult.proposals.find(
        record => record.proposal.kind === 'category',
      )?.proposal;
      if (proposal?.kind !== 'category') {
        throw new Error('Missing category proposal');
      }
      const changedSnapshot = snapshot(
        originalSnapshot.transactions!.map(candidate =>
          candidate.id === 'target' ? { ...candidate, ...change } : candidate,
        ),
      );

      const validation = validateCategoryProposal(proposal, changedSnapshot);

      expect(validation.isCurrent).toBe(false);
      expect(validation.reasonCodes).toEqual(
        expect.arrayContaining([expectedReason, 'target-stale']),
      );
    },
  );

  it.each([
    { winningHistoryCount: 39, totalHistoryCount: 49, isProposed: false },
    { winningHistoryCount: 40, totalHistoryCount: 50, isProposed: true },
  ])(
    'uses unrounded $winningHistoryCount/$totalHistoryCount category dominance',
    ({ winningHistoryCount, totalHistoryCount, isProposed }) => {
      const result = detectClassificationProposals({
        boundBudgetCurrency: 'USD',
        evaluatedAt,
        repository: new InMemoryClassificationProposalRepository(),
        ruleSetSnapshot: emptyRuleSetSnapshot,
        snapshot: snapshot([
          ...Array.from({ length: winningHistoryCount }, (_, index) =>
            transaction({ categoryId: 'category-1', id: `food-${index}` }),
          ),
          ...Array.from(
            { length: totalHistoryCount - winningHistoryCount },
            (_, index) =>
              transaction({ categoryId: 'category-2', id: `coffee-${index}` }),
          ),
          transaction({ id: 'target' }),
        ]),
      });

      expect(
        result.proposals.some(record => record.proposal.kind === 'category'),
      ).toBe(isProposed);
    },
  );

  it('keeps deleted category evidence in the category denominator', () => {
    const result = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository: new InMemoryClassificationProposalRepository(),
      ruleSetSnapshot: emptyRuleSetSnapshot,
      snapshot: snapshot([
        ...Array.from({ length: 4 }, (_, index) =>
          transaction({ categoryId: 'category-1', id: `food-${index}` }),
        ),
        transaction({ categoryId: 'deleted-category', id: 'deleted' }),
        transaction({ id: 'target' }),
      ]),
    });
    const categoryProposal = result.proposals.find(
      record => record.proposal.kind === 'category',
    )?.proposal;

    expect(categoryProposal).toMatchObject({
      confidence: 80,
      eligibleHistoryCount: 5,
      proposedCategoryCount: 4,
    });
  });

  it.each([
    { categoryId: 'category-1', expectedStatus: 'equivalent' },
    { categoryId: 'category-2', expectedStatus: 'competing' },
  ])(
    'suppresses a $expectedStatus category rule',
    ({ categoryId, expectedStatus }) => {
      const ruleSetSnapshot = createClassificationRuleSetSnapshot([
        {
          kind: 'supported',
          rule: {
            accountId: 'account-1',
            categoryId,
            kind: 'category',
            payeeId: 'payee-1',
          },
          ruleId: 'rule-1',
          ruleVersionHash: 'a'.repeat(64),
        },
      ]);
      const result = detectClassificationProposals({
        boundBudgetCurrency: 'USD',
        evaluatedAt,
        repository: new InMemoryClassificationProposalRepository(),
        ruleSetSnapshot,
        snapshot: snapshot([
          transaction({ id: 'history-1', categoryId: 'category-1' }),
          transaction({ id: 'history-2', categoryId: 'category-1' }),
          transaction({ id: 'history-3', categoryId: 'category-1' }),
          transaction({ id: 'target' }),
        ]),
      });

      expect(
        result.proposals.some(record => record.proposal.kind === 'category'),
      ).toBe(true);
      expect(
        result.proposals.find(record => record.proposal.kind === 'category')
          ?.availableIntents,
      ).toEqual([{ kind: 'categorize_once' }]);
      expect(result.suppressions).toContainEqual({
        kind: 'category',
        reasonCodes: ['suppressed'],
        ruleStatus: expectedStatus,
        subjectId: 'target',
      });
    },
  );

  it.each([
    { label: 'absent', ruleSetSnapshot: undefined },
    {
      label: 'incomplete',
      ruleSetSnapshot: {
        ...emptyRuleSetSnapshot,
        completeness: 'incomplete',
      },
    },
  ])('fails closed for an $label rule-set snapshot', ({ ruleSetSnapshot }) => {
    expect(() =>
      detectClassificationProposals({
        boundBudgetCurrency: 'USD',
        evaluatedAt,
        repository: new InMemoryClassificationProposalRepository(),
        ruleSetSnapshot,
        snapshot: snapshot([
          transaction({ id: 'alias-1' }),
          transaction({ id: 'alias-2' }),
        ]),
      } as never),
    ).toThrow('rule-set snapshot is incomplete');
  });

  it('includes unsupported rules in the complete hash and withholds rule intent', () => {
    const unsupportedRuleSet = createClassificationRuleSetSnapshot([
      {
        kind: 'unsupported',
        ruleId: 'unsupported-rule',
        ruleVersionHash: 'b'.repeat(64),
      },
    ]);
    const result = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository: new InMemoryClassificationProposalRepository(),
      ruleSetSnapshot: unsupportedRuleSet,
      snapshot: snapshot([
        transaction({ id: 'alias-1' }),
        transaction({ id: 'alias-2' }),
      ]),
    });

    expect(unsupportedRuleSet.ruleSetHash).not.toBe(
      emptyRuleSetSnapshot.ruleSetHash,
    );
    expect(result.proposals).toEqual([]);
    expect(result.suppressions).toContainEqual({
      kind: 'merchant-alias',
      reasonCodes: ['suppressed'],
      ruleStatus: 'unsupported',
      subjectId: 'coffee shop',
    });
  });

  it('treats overlapping payee spelling sets as competing', () => {
    const overlappingRuleSet = createClassificationRuleSetSnapshot([
      {
        kind: 'supported',
        rule: {
          kind: 'payee-rename',
          payeeId: 'payee-1',
          sourceSpellings: ['Coffee Shop'],
        },
        ruleId: 'rename-rule',
        ruleVersionHash: 'c'.repeat(64),
      },
    ]);
    const result = detectClassificationProposals({
      boundBudgetCurrency: 'USD',
      evaluatedAt,
      repository: new InMemoryClassificationProposalRepository(),
      ruleSetSnapshot: overlappingRuleSet,
      snapshot: snapshot([
        transaction({ id: 'alias-1', importedPayee: 'Coffee Shop' }),
        transaction({ id: 'alias-2', importedPayee: 'COFFEE SHOP' }),
      ]),
    });

    expect(result.suppressions).toContainEqual({
      kind: 'merchant-alias',
      reasonCodes: ['suppressed'],
      ruleStatus: 'competing',
      subjectId: 'coffee shop',
    });
  });

  it('orders rule spellings by UTF-8 bytes', () => {
    const ruleSet = createClassificationRuleSetSnapshot([
      {
        kind: 'supported',
        rule: {
          kind: 'payee-rename',
          payeeId: 'payee-1',
          sourceSpellings: ['\u00e9', 'z'],
        },
        ruleId: 'rename-rule',
        ruleVersionHash: 'd'.repeat(64),
      },
    ]);

    expect(ruleSet.entries[0]).toMatchObject({
      rule: { sourceSpellings: ['z', '\u00e9'] },
    });
  });

  it('marks a changed rule-set hash stale without applying a rule', () => {
    const originalRuleSet = createClassificationRuleSetSnapshot([]);
    const result = validateClassificationRuleIntent(
      {
        expectedRuleSetHash: originalRuleSet.ruleSetHash,
        kind: 'create_category_rule',
      },
      createClassificationRuleSetSnapshot([
        {
          kind: 'supported',
          rule: {
            accountId: 'account-1',
            categoryId: 'category-1',
            kind: 'category',
            payeeId: 'payee-1',
          },
          ruleId: 'rule-1',
          ruleVersionHash: 'a'.repeat(64),
        },
      ]),
      {
        accountId: 'account-1',
        categoryId: 'category-1',
        kind: 'category',
        payeeId: 'payee-1',
      },
    );

    expect(result).toEqual({ isCurrent: false, reasonCodes: ['target-stale'] });
  });

  it('uses the exact FIN-9 transaction graph hash domain', () => {
    const parent = transaction({ id: 'parent', isParent: true });
    const firstChild = transaction({
      id: 'a-child',
      isChild: true,
      parentId: 'parent',
    });
    const secondChild = transaction({
      id: 'z-child',
      isChild: true,
      parentId: 'parent',
    });
    const canonicalGraph = {
      children: [firstChild, secondChild],
      contractVersion: 1 as const,
      parent,
    };

    expect(
      targetVersionHash({
        children: [secondChild, firstChild],
        contractVersion: 1,
        parent,
      }),
    ).toBe(
      createHash('sha256')
        .update('finance-companion/actual-transaction-graph/v1\0')
        .update(canonicalJson(canonicalGraph))
        .digest('hex'),
    );
  });

  it('normalizes imported payees with the documented version-one comparison', () => {
    expect(normalizeImportedPayeeV1('  CAF\u00c9\u00a0\u00a0Store  ')).toBe(
      'caf\u00e9 store',
    );
  });
});

function snapshot(
  transactions: readonly ActualTransactionV1[],
  overrides: Partial<ActualBudgetSnapshotV1> = {},
): ActualBudgetSnapshotV1 {
  return {
    budget: {
      budgetKeyHash: 'b'.repeat(64),
      capturedAt: evaluatedAt,
      currencyCode: 'USD',
    },
    categories: [
      {
        groupId: 'group-1',
        hidden: false,
        id: 'category-1',
        isIncome: false,
        name: 'Food',
      },
      {
        groupId: 'group-1',
        hidden: false,
        id: 'category-2',
        isIncome: false,
        name: 'Coffee',
      },
    ],
    contractVersion: 1,
    payees: [
      { id: 'payee-1', name: 'Coffee Shop', transferAccountId: null },
      { id: 'payee-2', name: 'Other Coffee', transferAccountId: null },
    ],
    transactions,
    ...overrides,
  };
}

function transaction({
  id,
  ...overrides
}: Partial<ActualTransactionV1> &
  Pick<ActualTransactionV1, 'id'>): ActualTransactionV1 {
  return {
    accountId: 'account-1',
    amountMinorUnits: -500,
    categoryId: null,
    cleared: false,
    date: '2026-07-30',
    id,
    importedId: `import-${id}`,
    importedPayee: 'Coffee Shop',
    isChild: false,
    isParent: false,
    isStartingBalance: false,
    notes: null,
    parentId: null,
    payeeId: 'payee-1',
    reconciled: false,
    tombstone: false,
    transferId: null,
    ...overrides,
  };
}
