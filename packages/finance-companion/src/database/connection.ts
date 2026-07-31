import Database from 'better-sqlite3';

export type CompanionDatabase = Database.Database;

export function openCompanionDatabase(
  databasePath: string,
  mustExist = false,
): CompanionDatabase {
  const database = new Database(databasePath, { fileMustExist: mustExist });
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  return database;
}

export function verifySqliteDatabase(database: CompanionDatabase): void {
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error('The companion database integrity check failed.');
  }
  const foreignKeyErrors = database.pragma(
    'foreign_key_check',
  ) as readonly unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error('The companion database foreign key check failed.');
  }
}
