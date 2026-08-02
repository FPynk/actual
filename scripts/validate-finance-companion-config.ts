import { loadFinanceCompanionConfiguration } from '../packages/finance-companion/src/config.ts';

loadFinanceCompanionConfiguration({ ...process.env });
