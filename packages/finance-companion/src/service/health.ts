export const FINANCE_COMPANION_VERSION = '0.0.1';

export function createFinanceCompanionHealth(): Readonly<{
  status: 'healthy';
  version: string;
}> {
  return { status: 'healthy', version: FINANCE_COMPANION_VERSION };
}
