import type { FinanceCompanionConfiguration } from '#config';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { createSqliteLocalPrincipalRepository } from '#database/sqlite-local-principal-repository';
import { decodeIntegrityMacKey, readIntegrityMacKey } from '#integrity/anchor';
import { hashOwnerBootstrapCredential } from '#security/local-security';
import type { LocalPrincipalRepository } from '#security/local-security';

export async function createDurableLocalPrincipalRepository(
  configuration: FinanceCompanionConfiguration,
  migrationsDirectory: string,
): Promise<LocalPrincipalRepository> {
  let anchorMacKey: Buffer;
  if (configuration.integrityMacKey !== undefined) {
    anchorMacKey = decodeIntegrityMacKey(configuration.integrityMacKey);
  } else {
    if (configuration.integrityMacKeyFile === undefined) {
      throw new Error('The integrity key is invalid.');
    }
    anchorMacKey = await readIntegrityMacKey(configuration.integrityMacKeyFile);
  }
  try {
    await initializeCompanionDatabaseAndAnchor({
      databasePath: configuration.databasePath,
      migrationsDirectory,
      anchorPath: configuration.integrityAnchorPath,
      anchorMacKey,
      budgetKeyHash: configuration.budgetKeyHash,
      budgetCurrencyCode: configuration.budgetCurrencyCode,
      createOwnerCredentialHash: () =>
        hashOwnerBootstrapCredential(
          configuration.ownerBootstrapCredential,
          configuration.ownerBootstrapCredentialFile,
        ),
    });
  } finally {
    anchorMacKey.fill(0);
  }
  return createSqliteLocalPrincipalRepository(configuration.databasePath);
}
