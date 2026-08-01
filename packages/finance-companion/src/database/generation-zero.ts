import type { CompanionDatabase } from './connection.ts';

export function assertNoUnresolvedBankSyncEvidence(
  database: CompanionDatabase,
): void {
  const hasBankSyncTables = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_runs'",
    )
    .get();
  if (hasBankSyncTables === undefined) return;

  const resolutionCode = 'authoritative-sync-completed-effects-unknown';
  const unresolvedEvidence = database
    .prepare(
      `SELECT 1
       FROM job_runs AS job
       LEFT JOIN job_run_account_operations AS account
         ON account.job_run_id = job.id
       WHERE job.job_kind = 'bank_sync'
         AND (
           job.status IN ('queued', 'running', 'outcome_unknown')
           OR account.status IN ('queued', 'running')
           OR (
             (
               account.status = 'outcome_unknown'
               OR account.quarantine_bundle_hash IS NOT NULL
               OR account.resolution_code IS NOT NULL
               OR account.resolved_at IS NOT NULL
             )
             AND NOT (
               job.status = 'failed'
               AND job.resolution_code = ?
               AND job.resolved_at IS NOT NULL
               AND account.status = 'outcome_unknown'
               AND account.quarantine_bundle_hash IS NOT NULL
               AND account.resolution_code = ?
               AND account.resolved_at = job.resolved_at
             )
           )
           OR (
             (job.resolution_code IS NOT NULL OR job.resolved_at IS NOT NULL)
             AND NOT (
               job.status = 'failed'
               AND job.resolution_code = ?
               AND job.resolved_at IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM job_run_account_operations AS resolved_account
                 WHERE resolved_account.job_run_id = job.id
                   AND resolved_account.status = 'outcome_unknown'
                   AND resolved_account.quarantine_bundle_hash IS NOT NULL
                   AND resolved_account.resolution_code = ?
                   AND resolved_account.resolved_at = job.resolved_at
               )
             )
           )
         )
       LIMIT 1`,
    )
    .get(resolutionCode, resolutionCode, resolutionCode, resolutionCode);
  if (unresolvedEvidence !== undefined) {
    throw new Error(
      'Companion maintenance is blocked by unresolved bank-sync evidence.',
    );
  }
}
