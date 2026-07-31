import { createHash } from 'node:crypto';

export function calculateBudgetBindingHash(
  actualServerUrl: string,
  actualBudgetId: string,
): string {
  const normalizedOrigin = new URL(actualServerUrl).origin.toLowerCase();
  return createHash('sha256')
    .update('finance-companion/budget-binding/v1\0')
    .update(normalizedOrigin)
    .update('\0')
    .update(actualBudgetId)
    .digest('hex');
}

export function effectiveCurrencyCode(preferences: {
  defaultCurrencyCode?: string;
  'flags.currency'?: string;
}): string {
  if (preferences['flags.currency'] !== 'true') return 'USD';
  if (!/^[A-Z]{3}$/.test(preferences.defaultCurrencyCode ?? '')) {
    throw new Error('Explicit currency is invalid.');
  }
  return preferences.defaultCurrencyCode!;
}
