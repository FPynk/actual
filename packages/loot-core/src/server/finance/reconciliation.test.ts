import type { FinanceMetadata } from '#types/finance';
import type { TransactionEntity } from '#types/models';

import {
  buildNativeReconciliationCandidates,
  scoreNativeReconciliationPair,
} from './reconciliation';

function transaction(
  id: string,
  overrides: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id,
    account: 'checking',
    amount: -1299,
    date: '2026-07-10',
    payee: 'merchant',
    ...overrides,
  };
}

const payees = new Map([['merchant', 'Corner Shop']]);

describe('native reconciliation candidates', () => {
  test('scores an imported pending and posted pair with visible evidence', () => {
    const candidate = scoreNativeReconciliationPair(
      transaction('pending', {
        cleared: false,
        imported_id: 'bank-123',
        imported_payee: 'CORNER SHOP 123',
      }),
      transaction('posted', {
        cleared: true,
        imported_id: 'bank-123',
        imported_payee: 'CORNER SHOP 123',
      }),
      payees,
    );

    expect(candidate).toMatchObject({
      confidence: 'high',
      transactionIds: ['pending', 'posted'],
      amount: -1299,
    });
    expect(candidate?.reasons).toEqual(
      expect.arrayContaining([
        'same imported transaction ID',
        'same transaction date',
        'same normalized merchant',
        'pending and posted states differ',
      ]),
    );
  });

  test('does not compare transactions across accounts or amounts', () => {
    const source = transaction('source');

    expect(
      scoreNativeReconciliationPair(
        source,
        transaction('other-account', { account: 'savings' }),
        payees,
      ),
    ).toBeNull();
    expect(
      scoreNativeReconciliationPair(
        source,
        transaction('other-amount', { amount: -1300 }),
        payees,
      ),
    ).toBeNull();
  });

  test.each([
    { reconciled: true },
    { is_parent: true },
    { is_child: true },
    { parent_id: 'parent' },
    { transfer_id: 'transfer' },
    { tombstone: true },
    { _deleted: true },
  ] satisfies Partial<TransactionEntity>[])(
    'excludes unsafe transaction shape %#',
    unsafeFields => {
      expect(
        scoreNativeReconciliationPair(
          transaction('safe'),
          transaction('unsafe', unsafeFields),
          payees,
        ),
      ).toBeNull();
    },
  );

  test('honours a prior keep-both decision for a legitimate repeat', () => {
    const repeatedPurchases = [
      transaction('first', { date: '2026-07-10' }),
      transaction('second', { date: '2026-07-11' }),
    ];
    const candidate = buildNativeReconciliationCandidates(
      repeatedPurchases,
      payees,
    )[0];
    expect(candidate).toBeDefined();

    const metadata: FinanceMetadata = {
      version: 1,
      reviewDecisions: [
        {
          candidateKey: candidate.candidateKey,
          decision: 'keep-both',
          feature: 'reconciliation',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      ],
    };

    expect(
      buildNativeReconciliationCandidates(repeatedPurchases, payees, metadata),
    ).toEqual([]);
  });

  test('changes the fingerprint when review evidence changes', () => {
    const initial = scoreNativeReconciliationPair(
      transaction('one', { notes: 'Pending card purchase' }),
      transaction('two'),
      payees,
    );
    const changed = scoreNativeReconciliationPair(
      transaction('one', { notes: 'User changed this note' }),
      transaction('two'),
      payees,
    );

    expect(initial?.fingerprint).not.toBe(changed?.fingerprint);
  });
});
