import { q } from '@actual-app/core/shared/query';

import {
  makeCategorizationScopeQuery,
  normalizeCategorizationCurrencyCode,
  prepareCategorizationScopeCandidates,
} from './categorization';
import type { CategorizationQueryRow } from './categorization';

describe('categorization transaction scopes', () => {
  it('uses an ISO-compatible placeholder for custom budget currencies', () => {
    expect(normalizeCategorizationCurrencyCode('usd')).toBe('USD');
    expect(normalizeCategorizationCurrencyCode('')).toBe('XXX');
    expect(normalizeCategorizationCurrencyCode('CUSTOM')).toBe('XXX');
  });

  it('resolves selected transactions without page visibility limits', () => {
    const query = makeCategorizationScopeQuery(
      {
        kind: 'selected',
        transactionIds: ['one', 'two'],
      },
      { limit: 500, offset: 0 },
    ).serialize();

    expect(query.filterExpressions).toEqual([
      { id: { $oneof: ['one', 'two'] } },
    ]);
    expect(query.limit).toBe(500);
    expect(query.offset).toBe(0);
    expect(query.tableOptions).toEqual({ splits: 'all' });
  });

  it('retains the complete current filter while replacing its paging', () => {
    const currentQuery = q('transactions')
      .filter({ account: 'checking' })
      .filter({ 'payee.name': { $like: '%market%' } })
      .limit(150)
      .offset(300)
      .serialize();

    const query = makeCategorizationScopeQuery(
      {
        kind: 'current-filter',
        query: currentQuery,
      },
      { limit: 500, offset: 1_000 },
    ).serialize();

    expect(query.filterExpressions).toEqual(currentQuery.filterExpressions);
    expect(query.offset).toBe(1_000);
    expect(query.limit).toBe(500);
  });

  it('uses inclusive date-range boundaries', () => {
    const query = makeCategorizationScopeQuery(
      {
        kind: 'date-range',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      },
      { limit: 500, offset: 0 },
    ).serialize();

    expect(query.filterExpressions).toEqual([
      {
        $and: [
          { date: { $gte: '2026-07-01' } },
          { date: { $lte: '2026-07-31' } },
        ],
      },
    ]);
  });

  it('uses all budget transactions for the all scope', () => {
    const query = makeCategorizationScopeQuery(
      {
        kind: 'all',
      },
      { limit: 500, offset: 0 },
    ).serialize();

    expect(query.filterExpressions).toEqual([]);
  });

  it('reads bounded pages and stops as soon as the eligible maximum is exceeded', async () => {
    const expenseRow = (id: string): CategorizationQueryRow => ({
      account: 'account-1',
      amount: -100,
      date: '2026-08-01',
      id,
      imported_payee: `Merchant ${id}`,
    });
    const requestedOffsets: Array<number | null> = [];

    const result = await prepareCategorizationScopeCandidates({
      scope: { kind: 'all' },
      includeCategorized: false,
      currency: 'USD',
      decimalPlaces: 2,
      createCandidateId: (() => {
        let candidateNumber = 0;
        return () => `candidate-${candidateNumber++}`;
      })(),
      maximumCandidates: 2,
      pageSize: 2,
      readPage: async query => {
        const { offset } = query.serialize();
        requestedOffsets.push(offset);
        if (offset === 0) {
          return [expenseRow('one'), { ...expenseRow('income'), amount: 100 }];
        }
        if (offset === 2) {
          return [expenseRow('two'), expenseRow('three')];
        }
        throw new Error('Unexpected unbounded read');
      },
    });

    expect(requestedOffsets).toEqual([0, 2]);
    expect(result.exceededMaximum).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.skipped['not-expense']).toBe(1);
  });
});
