import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function canonicalExistingRegularFile(
  filePath: string,
): Promise<string> {
  const absolutePath = path.resolve(filePath);
  const file = await lstat(absolutePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('A protected path is not a regular file.');
  }
  const canonicalPath = await realpath(absolutePath);
  if (!samePath(absolutePath, canonicalPath)) {
    throw new Error('A protected path traverses a symbolic link.');
  }
  return canonicalPath;
}

export async function canonicalUnusedFile(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    await lstat(absolutePath);
    throw new Error('The destination already exists.');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const parentPath = path.dirname(absolutePath);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('The destination parent is not a regular directory.');
  }
  const canonicalParentPath = await realpath(parentPath);
  if (!samePath(parentPath, canonicalParentPath)) {
    throw new Error('The destination path traverses a symbolic link.');
  }
  return path.join(canonicalParentPath, path.basename(absolutePath));
}

export function assertDistinctPaths(paths: readonly string[]): void {
  const normalizedPaths = paths.map(normalizedPath);
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error('Protected paths must be distinct.');
  }
}

export async function assertDistinctExistingFiles(
  paths: readonly string[],
): Promise<void> {
  const identities = await Promise.all(
    paths.map(async filePath => {
      const file = await lstat(filePath, { bigint: true });
      return `${file.dev}:${file.ino}`;
    }),
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error('Protected paths must not alias the same file.');
  }
}

export async function assertNoSqliteSidecars(
  databasePath: string,
): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      await access(`${databasePath}${suffix}`, constants.F_OK);
      throw new Error('SQLite sidecars must be resolved before maintenance.');
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

export function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
