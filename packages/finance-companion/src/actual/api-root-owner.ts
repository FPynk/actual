import { randomBytes } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '#actual/canonical-json';
import { samePath } from '#database/path-safety';

type ActualApiOwner = Readonly<{
  formatVersion: 1;
  companionInstanceId: string;
  budgetBindingHash: string;
  directoryNonce: string;
}>;

export async function prepareActualApiOwnerDirectory(
  actualApiDirectory: string,
  databaseExists: boolean,
  companionInstanceId: string | undefined,
  budgetBindingHash: string,
): Promise<Readonly<{ actualApiDirectory: string; ownerExists: boolean }>> {
  const canonicalDirectory =
    await canonicalExistingDirectory(actualApiDirectory);
  const ownerPath = path.join(canonicalDirectory, 'owner.json');
  const owner = await readActualApiOwner(ownerPath);
  if (owner === undefined) {
    if ((await readdir(canonicalDirectory)).length !== 0) {
      throw new Error(
        'Actual API directory is not empty without an owner marker.',
      );
    }
    return { actualApiDirectory: canonicalDirectory, ownerExists: false };
  }
  if (!databaseExists || companionInstanceId === undefined) {
    throw new Error(
      'Actual API owner marker exists before companion initialization.',
    );
  }
  if (
    owner.companionInstanceId !== companionInstanceId ||
    owner.budgetBindingHash !== budgetBindingHash
  ) {
    throw new Error('Actual API owner marker does not match the companion.');
  }
  return { actualApiDirectory: canonicalDirectory, ownerExists: true };
}

export async function createActualApiOwner(
  actualApiDirectory: string,
  companionInstanceId: string,
  budgetBindingHash: string,
): Promise<void> {
  const nonceBytes = randomBytes(32);
  try {
    const owner: ActualApiOwner = {
      formatVersion: 1,
      companionInstanceId,
      budgetBindingHash,
      directoryNonce: nonceBytes.toString('base64url'),
    };
    const ownerPath = path.join(actualApiDirectory, 'owner.json');
    const file = await open(ownerPath, 'wx', 0o600);
    try {
      await file.writeFile(canonicalJson(owner), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  } finally {
    nonceBytes.fill(0);
  }
}

async function canonicalExistingDirectory(directory: string): Promise<string> {
  const absoluteDirectory = path.resolve(directory);
  const status = await lstat(absoluteDirectory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Actual API directory is not a regular directory.');
  }
  const canonicalDirectory = await realpath(absoluteDirectory);
  if (!samePath(absoluteDirectory, canonicalDirectory)) {
    throw new Error('Actual API directory traverses a symbolic link.');
  }
  return canonicalDirectory;
}

async function readActualApiOwner(
  ownerPath: string,
): Promise<ActualApiOwner | undefined> {
  let status;
  try {
    status = await lstat(ownerPath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (typeof status.nlink === 'number' && status.nlink !== 1)
  ) {
    throw new Error('Actual API owner marker is not a protected regular file.');
  }
  const canonicalPath = await realpath(ownerPath);
  if (!samePath(ownerPath, canonicalPath)) {
    throw new Error('Actual API owner marker traverses a symbolic link.');
  }
  const serialized = await readFile(ownerPath, 'utf8');
  let owner: Record<string, unknown>;
  try {
    owner = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    throw new Error('Actual API owner marker is invalid.');
  }
  if (
    canonicalJson(owner) !== serialized ||
    !hasExactKeys(owner, [
      'formatVersion',
      'companionInstanceId',
      'budgetBindingHash',
      'directoryNonce',
    ]) ||
    owner.formatVersion !== 1 ||
    typeof owner.companionInstanceId !== 'string' ||
    typeof owner.budgetBindingHash !== 'string' ||
    !isDirectoryNonce(owner.directoryNonce)
  ) {
    throw new Error('Actual API owner marker is invalid.');
  }
  return owner as ActualApiOwner;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
  );
}

function isDirectoryNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64url');
  try {
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } finally {
    decoded.fill(0);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
