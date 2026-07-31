import type { LocalPrincipalRepository } from '#security/local-security';

import { openCompanionDatabase } from './connection.ts';

export function createSqliteLocalPrincipalRepository(
  databasePath: string,
): LocalPrincipalRepository {
  return {
    readOwner: async () =>
      withDatabase(databasePath, database => {
        const principals = database
          .prepare('SELECT id, credential_hash FROM local_principals')
          .all() as readonly Readonly<{
          id: string;
          credential_hash: string;
        }>[];
        if (principals.length > 1) {
          throw new Error('The local principal state is invalid.');
        }
        const principal = principals[0];
        return principal === undefined
          ? null
          : { id: principal.id, credentialHash: principal.credential_hash };
      }),
    writeOwner: async principal => {
      withDatabase(databasePath, database => {
        database
          .prepare(
            'INSERT INTO local_principals (id, credential_hash, created_at, rotated_at) VALUES (?, ?, ?, ?)',
          )
          .run(
            principal.id,
            principal.credentialHash,
            new Date().toISOString(),
            null,
          );
      });
    },
    replaceOwnerCredentialHash: async (
      principalId,
      credentialHash,
      rotatedAt,
    ) =>
      withDatabase(databasePath, database => {
        const result = database
          .prepare(
            'UPDATE local_principals SET credential_hash = ?, rotated_at = ? WHERE id = ?',
          )
          .run(credentialHash, rotatedAt, principalId);
        return result.changes === 1;
      }),
  };
}

function withDatabase<Result>(
  databasePath: string,
  operation: (database: ReturnType<typeof openCompanionDatabase>) => Result,
): Result {
  const database = openCompanionDatabase(databasePath, true);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
