import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function restoreJournalPath(databasePath: string): string {
  return `${databasePath}.restore-journal`;
}

export function hasRestoreRecoveryArtifacts(
  databasePath: string,
  anchorPath: string,
): boolean {
  return (
    existsSync(restoreJournalPath(databasePath)) ||
    hasRestoreIntentSibling(anchorPath) ||
    hasRestoreSibling(databasePath) ||
    hasRestoreSibling(anchorPath)
  );
}

function hasRestoreIntentSibling(anchorPath: string): boolean {
  const directory = path.dirname(anchorPath);
  return (
    existsSync(directory) &&
    readdirSync(directory).some(entry =>
      entry.startsWith('.finance-companion-restore-intent-'),
    )
  );
}

function hasRestoreSibling(filePath: string): boolean {
  const directory = path.dirname(filePath);
  const name = path.basename(filePath);
  const contractPrefix = `.${name}.restore-`;
  const legacyPrefix = `${name}.restore-`;
  return (
    existsSync(directory) &&
    readdirSync(directory).some(
      entry =>
        entry.startsWith(contractPrefix) || entry.startsWith(legacyPrefix),
    )
  );
}
