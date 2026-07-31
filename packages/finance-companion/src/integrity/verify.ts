import {
  openCompanionDatabase,
  verifySqliteDatabase,
} from '#database/connection';
import { withExclusiveMaintenanceLock } from '#database/maintenance-lock';
import {
  assertDistinctExistingFiles,
  assertDistinctPaths,
  canonicalExistingRegularFile,
} from '#database/path-safety';
import { hasRestoreRecoveryArtifacts } from '#database/restore-journal';

import { readIntegrityAnchor } from './anchor.ts';
import type { IntegrityAnchorV1 } from './anchor.ts';

export type IntegrityVerificationRequest = Readonly<{
  databasePath: string;
  anchorPath: string;
  anchorMacKey: Buffer;
  expectedBudgetKeyHash: string;
  expectedCurrencyCode: string;
}>;

export type IntegrityVerificationResult = Readonly<{
  schemaVersion: number;
  writeCapabilityState: 'disabled' | 'enabled' | 'recovery_required';
}>;

export async function verifyCompanionIntegrity(
  request: IntegrityVerificationRequest,
): Promise<IntegrityVerificationResult> {
  const databasePath = await canonicalExistingRegularFile(request.databasePath);
  const anchorPath = await canonicalExistingRegularFile(request.anchorPath);
  assertDistinctPaths([databasePath, anchorPath]);
  await assertDistinctExistingFiles([databasePath, anchorPath]);
  return withExclusiveMaintenanceLock(databasePath, () =>
    verify({ ...request, databasePath, anchorPath }),
  );
}

async function verify(
  request: IntegrityVerificationRequest,
): Promise<IntegrityVerificationResult> {
  const database = openCompanionDatabase(request.databasePath, true);
  try {
    const instance = database
      .prepare(
        'SELECT budget_key_hash, budget_currency_code, write_capability_state, write_capability_generation, write_capability_event_hash FROM companion_instance WHERE singleton_key = ?',
      )
      .get('main') as
      | Readonly<{
          budget_key_hash: string;
          budget_currency_code: string;
          write_capability_state: IntegrityVerificationResult['writeCapabilityState'];
          write_capability_generation: number;
          write_capability_event_hash: string | null;
        }>
      | undefined;
    if (
      instance === undefined ||
      instance.budget_key_hash !== request.expectedBudgetKeyHash ||
      instance.budget_currency_code !== request.expectedCurrencyCode ||
      hasRestoreRecoveryArtifacts(request.databasePath, request.anchorPath)
    ) {
      return requireRecovery(database);
    }
    let anchor: IntegrityAnchorV1;
    try {
      anchor = await readIntegrityAnchor(
        request.anchorPath,
        request.anchorMacKey,
      );
    } catch {
      return requireRecovery(database);
    }
    const eventCount = (
      database
        .prepare('SELECT COUNT(*) AS count FROM write_capability_events')
        .get() as Readonly<{ count: number }>
    ).count;
    const isGenerationZero =
      instance.write_capability_generation === 0 &&
      instance.write_capability_event_hash === null &&
      eventCount === 0 &&
      anchor.highestIssuedIntentSequence === 0 &&
      anchor.highestIssuedIntentHash === null &&
      anchor.highestAppliedReceiptSequence === 0 &&
      anchor.highestAppliedReceiptHash === null &&
      anchor.lastVerifiedPairedBackupManifestHash === null;
    const hasExactAnchor =
      anchor.budgetKeyHash === instance.budget_key_hash &&
      anchor.writeCapabilityGeneration ===
        instance.write_capability_generation &&
      anchor.writeCapabilityEventHash === instance.write_capability_event_hash;
    if (
      !hasExactAnchor ||
      (!isGenerationZero &&
        instance.write_capability_state !== 'recovery_required')
    ) {
      return requireRecovery(database);
    }
    verifySqliteDatabase(database);
    return {
      schemaVersion: schemaVersion(database),
      writeCapabilityState: instance.write_capability_state,
    };
  } catch {
    return requireRecovery(database);
  } finally {
    database.close();
  }
}

function requireRecovery(
  database: ReturnType<typeof openCompanionDatabase>,
): IntegrityVerificationResult {
  try {
    database
      .prepare(
        "UPDATE companion_instance SET write_capability_state = 'recovery_required' WHERE singleton_key = 'main'",
      )
      .run();
  } catch {
    // The failed proof remains fail-closed even if the state cannot persist.
  }
  return {
    schemaVersion: schemaVersion(database),
    writeCapabilityState: 'recovery_required',
  };
}

function schemaVersion(
  database: ReturnType<typeof openCompanionDatabase>,
): number {
  const result = database
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as Readonly<{ version: number }>;
  return result.version;
}
