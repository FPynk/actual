export const FINANCE_COMPANION_VERSION = '0.0.1';

export type FinanceCompanionHealth = Readonly<{
  status: 'healthy' | 'not-healthy';
  version: string;
}>;

export function createFinanceCompanionHealth(): Readonly<{
  status: 'healthy';
  version: string;
}>;
export function createFinanceCompanionHealth(
  adapterHealth: 'healthy' | 'degraded' | 'unhealthy',
): FinanceCompanionHealth;
export function createFinanceCompanionHealth(
  adapterHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy',
): FinanceCompanionHealth {
  return {
    status: adapterHealth === 'unhealthy' ? 'not-healthy' : 'healthy',
    version: FINANCE_COMPANION_VERSION,
  };
}
