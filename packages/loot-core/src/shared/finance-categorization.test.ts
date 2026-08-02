import {
  categorizationFingerprint,
  getDefaultSelectedCategorizationCandidateIds,
  planCategorizationApply,
  prepareCategorizationCandidates,
  requestCategorizationProposalsSequentially,
  splitCategorizationProviderBatches,
  toCategorizationGatewayCandidate,
} from './finance-categorization';
import type {
  CategorizationTransactionSnapshot,
  PreparedCategorizationCandidate,
} from './finance-categorization';

function expense(
  overrides: Partial<CategorizationTransactionSnapshot> = {},
): CategorizationTransactionSnapshot {
  return {
    accountId: 'account-1',
    accountName: 'Checking',
    amount: -1_299,
    categoryId: null,
    date: '2026-08-01',
    importedPayee: 'CORNER SHOP 123',
    payeeId: 'payee-1',
    payeeName: 'Corner Shop',
    transactionId: 'transaction-1',
    ...overrides,
  };
}

function providerCandidate(
  candidateId: string,
): PreparedCategorizationCandidate {
  return {
    amount: '-12.99',
    amountInteger: -1_299,
    candidateId,
    currency: 'USD',
    date: '2026-08-01',
    description: 'CORNER SHOP 123',
    fingerprint: 'fingerprint',
    transactionId: `transaction-${candidateId}`,
  };
}

describe('finance categorization', () => {
  it('excludes categorized transactions by default and supports explicit inclusion', () => {
    const transactions = [
      expense(),
      expense({ transactionId: 'categorized', categoryId: 'groceries' }),
    ];
    const defaultResult = prepareCategorizationCandidates({
      transactions,
      includeCategorized: false,
      currency: 'USD',
      decimalPlaces: 2,
      createCandidateId: () => 'candidate',
    });
    const includedResult = prepareCategorizationCandidates({
      transactions,
      includeCategorized: true,
      currency: 'USD',
      decimalPlaces: 2,
      createCandidateId: () => 'candidate',
    });

    expect(defaultResult.candidates).toHaveLength(1);
    expect(defaultResult.skipped['already-categorized']).toBe(1);
    expect(includedResult.candidates).toHaveLength(2);
  });

  it('excludes non-expenses, transfers, splits, reconciled, starting balances, off-budget, and undescribed rows', () => {
    const transactions = [
      expense({ transactionId: 'income', amount: 100 }),
      expense({ transactionId: 'transfer', transferId: 'linked' }),
      expense({ transactionId: 'split', isChild: true }),
      expense({ transactionId: 'reconciled', reconciled: true }),
      expense({ transactionId: 'starting-balance', startingBalance: true }),
      expense({ transactionId: 'off-budget', accountOffBudget: true }),
      expense({
        transactionId: 'undescribed',
        importedPayee: '',
        payeeName: '',
      }),
    ];

    const result = prepareCategorizationCandidates({
      transactions,
      includeCategorized: false,
      currency: 'USD',
      decimalPlaces: 2,
      createCandidateId: () => 'candidate',
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toMatchObject({
      'missing-description': 1,
      'not-expense': 1,
      'off-budget': 1,
      reconciled: 1,
      split: 1,
      'starting-balance': 1,
      transfer: 1,
    });
  });

  it('uses opaque candidate IDs and omits Actual IDs and notes from provider data', () => {
    const [candidate] = prepareCategorizationCandidates({
      transactions: [expense()],
      includeCategorized: false,
      currency: 'USD',
      decimalPlaces: 2,
      createCandidateId: () => 'opaque-candidate',
    }).candidates;

    expect(candidate).toMatchObject({
      amount: '-12.99',
      candidateId: 'opaque-candidate',
      currency: 'USD',
      description: 'CORNER SHOP 123',
      payee: 'Corner Shop',
    });
    const providerPayload = toCategorizationGatewayCandidate(candidate);
    expect(providerPayload).not.toHaveProperty('transactionId');
    expect(providerPayload).not.toHaveProperty('fingerprint');
    expect(providerPayload).not.toHaveProperty('notes');
  });

  it('chunks no more than 25 candidates and requests batches sequentially', async () => {
    const candidates = Array.from({ length: 51 }, (_, index) =>
      providerCandidate(String(index)),
    );
    expect(
      splitCategorizationProviderBatches(candidates).map(x => x.length),
    ).toEqual([25, 25, 1]);

    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const requestedBatchSizes: number[] = [];
    const proposals = await requestCategorizationProposalsSequentially({
      candidates,
      allowedCategoryIds: new Set(['groceries']),
      requestBatch: async batch => {
        activeRequests++;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        requestedBatchSizes.push(batch.length);
        await Promise.resolve();
        activeRequests--;
        return batch.map(candidate => ({
          candidateId: candidate.candidateId,
          categoryId: 'groceries',
          confidence: 'high' as const,
          explanation: 'Matches the merchant.',
        }));
      },
    });

    expect(proposals).toEqual({
      outcome: 'complete',
      proposals: expect.arrayContaining([
        expect.objectContaining({ candidateId: '0' }),
      ]),
    });
    expect(proposals.proposals).toHaveLength(51);
    expect(requestedBatchSizes).toEqual([25, 25, 1]);
    expect(maximumActiveRequests).toBe(1);
  });

  it('keeps completed batches reviewable when a later batch fails', async () => {
    const candidates = Array.from({ length: 26 }, (_, index) =>
      providerCandidate(String(index)),
    );
    const result = await requestCategorizationProposalsSequentially({
      candidates,
      allowedCategoryIds: new Set(['groceries']),
      requestBatch: async batch => {
        if (batch[0].candidateId === '25') {
          throw new Error('network-failure');
        }
        return batch.map(candidate => ({
          candidateId: candidate.candidateId,
          categoryId: 'groceries',
          confidence: 'high' as const,
          explanation: 'Matches the merchant.',
        }));
      },
    });

    expect(result.outcome).toBe('failed');
    expect(result.proposals).toHaveLength(25);
    expect(result.proposals[0]).toMatchObject({ candidateId: '0' });
  });

  it('stops before later batches after cancellation and keeps completed batches', async () => {
    const candidates = Array.from({ length: 51 }, (_, index) =>
      providerCandidate(String(index)),
    );
    const controller = new AbortController();
    const requestedBatchSizes: number[] = [];
    const result = await requestCategorizationProposalsSequentially({
      candidates,
      allowedCategoryIds: new Set(['groceries']),
      signal: controller.signal,
      requestBatch: async batch => {
        requestedBatchSizes.push(batch.length);
        controller.abort();
        return batch.map(candidate => ({
          candidateId: candidate.candidateId,
          categoryId: 'groceries',
          confidence: 'high' as const,
          explanation: 'Matches the merchant.',
        }));
      },
    });

    expect(result.outcome).toBe('aborted');
    expect(result.proposals).toHaveLength(25);
    expect(requestedBatchSizes).toEqual([25]);
  });

  it('returns a failed result for invalid provider output before any apply operation', async () => {
    const result = await requestCategorizationProposalsSequentially({
      candidates: [providerCandidate('one')],
      allowedCategoryIds: new Set(['groceries']),
      requestBatch: async () => [
        {
          candidateId: 'unknown',
          categoryId: 'groceries',
          confidence: 'high',
          explanation: 'Invalid candidate.',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'failed', proposals: [] });
  });

  it('preselects only high-confidence proposals with a category', () => {
    expect(
      getDefaultSelectedCategorizationCandidateIds([
        {
          candidateId: 'high',
          categoryId: 'groceries',
          confidence: 'high',
          explanation: 'Strong match.',
        },
        {
          candidateId: 'medium',
          categoryId: 'groceries',
          confidence: 'medium',
          explanation: 'Possible match.',
        },
        {
          candidateId: 'none',
          categoryId: null,
          confidence: 'high',
          explanation: 'No suitable category.',
        },
      ]),
    ).toEqual(new Set(['high']));
  });

  it('partially applies valid rows while skipping stale and disallowed proposals', () => {
    const valid = expense();
    const stale = expense({ transactionId: 'stale' });
    const disallowed = expense({ transactionId: 'disallowed' });

    const result = planCategorizationApply({
      proposals: [
        {
          transactionId: valid.transactionId,
          categoryId: 'groceries',
          fingerprint: categorizationFingerprint(valid),
        },
        {
          transactionId: stale.transactionId,
          categoryId: 'groceries',
          fingerprint: categorizationFingerprint(stale),
        },
        {
          transactionId: disallowed.transactionId,
          categoryId: 'travel',
          fingerprint: categorizationFingerprint(disallowed),
        },
      ],
      currentTransactions: [valid, { ...stale, amount: -2_000 }, disallowed],
      allowedCategoryIds: new Set(['groceries']),
      includeCategorized: false,
    });

    expect(result.updates).toEqual([
      { id: 'transaction-1', category: 'groceries' },
    ]);
    expect(result.skipped).toEqual([
      { transactionId: 'stale', reason: 'stale' },
      { transactionId: 'disallowed', reason: 'category-not-allowed' },
    ]);
  });
});
