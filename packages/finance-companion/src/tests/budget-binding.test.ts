import {
  calculateBudgetBindingHash,
  effectiveCurrencyCode,
} from '#actual/budget-binding';

describe('Actual budget binding and currency', () => {
  it('normalizes scheme, host, and default port before binding', () => {
    expect(
      calculateBudgetBindingHash(
        'HTTPS://ACTUAL.EXAMPLE.TEST:443',
        'budget-id',
      ),
    ).toBe(
      calculateBudgetBindingHash('https://actual.example.test', 'budget-id'),
    );
  });

  it('uses USD only when the explicit currency flag is not enabled', () => {
    expect(
      effectiveCurrencyCode({
        'flags.currency': 'false',
        defaultCurrencyCode: 'EUR',
      }),
    ).toBe('USD');
  });

  it('requires a valid explicit currency when the flag is enabled', () => {
    expect(
      effectiveCurrencyCode({
        'flags.currency': 'true',
        defaultCurrencyCode: 'EUR',
      }),
    ).toBe('EUR');
    expect(() => effectiveCurrencyCode({ 'flags.currency': 'true' })).toThrow(
      'Explicit currency is invalid.',
    );
  });
});
