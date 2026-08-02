import { describe, expect, it } from 'vitest';

import { detectRecurringPayments } from './recurring-detector';

describe('detectRecurringPayments', () => {
  it('classifies recurring optional, household, and financial payments', () => {
    const candidates = detectRecurringPayments([
      ...monthly('streaming', 'Streaming Service'),
      ...monthly('utility', 'City Electric'),
      ...monthly('loan', 'Bank Loan'),
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cadence: 'monthly',
          payeeName: 'Streaming Service',
          type: 'optional-subscription',
        }),
        expect.objectContaining({
          payeeName: 'City Electric',
          type: 'household-bill',
        }),
        expect.objectContaining({
          payeeName: 'Bank Loan',
          type: 'financial-bill',
        }),
      ]),
    );
  });

  it('excludes transfers and requires enough observations for each cadence', () => {
    expect(
      detectRecurringPayments([
        ...monthly('short', 'Too Short').slice(0, 2),
        ...monthly('transfer', 'Transfer').map(transaction => ({
          ...transaction,
          isTransfer: true,
        })),
      ]),
    ).toEqual([]);
  });
});

function monthly(payeeId: string, payeeName: string) {
  return ['2026-01-05', '2026-02-05', '2026-03-05'].map((date, index) => ({
    id: `${payeeId}-${index}`,
    accountId: 'account',
    payeeId,
    payeeName,
    date,
    amount: -1000,
    isTransfer: false,
    isSplitParent: false,
    isReconciled: false,
  }));
}
