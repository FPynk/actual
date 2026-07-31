import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '#actual/canonical-json';

type LockOwner = Readonly<{
  acquiredAt: string;
  directoryOwnershipNonce: string;
  formatVersion: 1;
  pid: number;
  processStartIdentity: string;
  serviceInstanceNonce: string;
  workerOperationId: string;
}>;

export async function acquireActualApiLock(
  actualApiDirectory: string,
  workerOperationId: string,
  directoryOwnershipNonce: string,
  serviceInstanceNonce: string,
): Promise<() => Promise<void>> {
  const lockDirectory = path.join(
    actualApiDirectory,
    'locks',
    'actual-api.lock',
  );
  const owner = createLockOwner(
    workerOperationId,
    directoryOwnershipNonce,
    serviceInstanceNonce,
  );
  await mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });
  try {
    await writeLock(lockDirectory, owner);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await reclaimStaleLock(lockDirectory, directoryOwnershipNonce);
    await writeLock(lockDirectory, owner);
  }
  return async () => {
    if (
      canonicalJson(await readLockOwner(lockDirectory)) !== canonicalJson(owner)
    ) {
      throw new Error('Actual API lock ownership changed.');
    }
    const releaseDirectory = `${lockDirectory}.release-${workerOperationId}`;
    await rename(lockDirectory, releaseDirectory);
    if (
      canonicalJson(await readLockOwner(releaseDirectory)) !==
      canonicalJson(owner)
    ) {
      throw new Error('Actual API lock ownership changed.');
    }
    await rm(releaseDirectory, {
      recursive: true,
      force: false,
      maxRetries: 0,
    });
  };
}

async function writeLock(
  lockDirectory: string,
  owner: LockOwner,
): Promise<void> {
  await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  await writeFile(
    path.join(lockDirectory, 'owner.json'),
    canonicalJson(owner),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

async function reclaimStaleLock(
  lockDirectory: string,
  directoryOwnershipNonce: string,
): Promise<void> {
  const lockStatus = await lstat(lockDirectory);
  if (!lockStatus.isDirectory() || lockStatus.isSymbolicLink()) {
    throw new Error('Actual API lock is invalid.');
  }
  const owner = await readLockOwner(lockDirectory);
  if (
    owner.directoryOwnershipNonce !== directoryOwnershipNonce ||
    processHasMatchingIdentity(owner.pid, owner.processStartIdentity)
  ) {
    throw new Error('Actual API lock cannot be reclaimed.');
  }
  await rename(
    lockDirectory,
    `${lockDirectory}.stale-${owner.workerOperationId}`,
  );
}

async function readLockOwner(lockDirectory: string): Promise<LockOwner> {
  const markerPath = path.join(lockDirectory, 'owner.json');
  const markerStatus = await lstat(markerPath);
  if (!markerStatus.isFile() || markerStatus.isSymbolicLink()) {
    throw new Error('Actual API lock marker is invalid.');
  }
  const serialized = await readFile(markerPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('Actual API lock marker is invalid.');
  }
  if (!isLockOwner(parsed) || canonicalJson(parsed) !== serialized) {
    throw new Error('Actual API lock marker is invalid.');
  }
  return parsed;
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 7 &&
    (value as Record<string, unknown>).formatVersion === 1 &&
    typeof (value as Record<string, unknown>).directoryOwnershipNonce ===
      'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(
      (value as Record<string, unknown>).directoryOwnershipNonce as string,
    ) &&
    Number.isSafeInteger((value as Record<string, unknown>).pid) &&
    ((value as Record<string, unknown>).pid as number) > 0 &&
    typeof (value as Record<string, unknown>).acquiredAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      (value as Record<string, unknown>).acquiredAt as string,
    ) &&
    typeof (value as Record<string, unknown>).processStartIdentity ===
      'string' &&
    ((value as Record<string, unknown>).processStartIdentity as string).length >
      0 &&
    typeof (value as Record<string, unknown>).serviceInstanceNonce ===
      'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(
      (value as Record<string, unknown>).serviceInstanceNonce as string,
    ) &&
    typeof (value as Record<string, unknown>).workerOperationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      (value as Record<string, unknown>).workerOperationId as string,
    )
  );
}

function createLockOwner(
  workerOperationId: string,
  directoryOwnershipNonce: string,
  serviceInstanceNonce: string,
): LockOwner {
  return {
    acquiredAt: new Date().toISOString(),
    directoryOwnershipNonce,
    formatVersion: 1,
    pid: process.pid,
    processStartIdentity: processStartIdentity(process.pid),
    serviceInstanceNonce,
    workerOperationId,
  };
}

function processHasMatchingIdentity(
  pid: number,
  expectedIdentity: string,
): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Process identity inspection is unavailable.');
  }
  try {
    return processStartIdentity(pid) === expectedIdentity;
  } catch {
    throw new Error('Process identity inspection is unavailable.');
  }
}

function processStartIdentity(pid: number): string {
  if (process.platform === 'linux') {
    const bootId = readSystemValue('/proc/sys/kernel/random/boot_id');
    const fields = readSystemValue(`/proc/${pid}/stat`).split(' ');
    if (!fields[21]) throw new Error('Linux process identity is unavailable.');
    return `linux:${bootId}:${fields[21]}`;
  }
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process -Id ([int]$env:FINANCE_COMPANION_INSPECTED_PROCESS_ID)).StartTime.ToUniversalTime().Ticks',
      ],
      {
        encoding: 'utf8',
        env: {
          FINANCE_COMPANION_INSPECTED_PROCESS_ID: String(pid),
          SystemRoot: process.env.SystemRoot,
        },
        windowsHide: true,
      },
    );
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error('Windows process identity is unavailable.');
    }
    return `windows:${result.stdout.trim()}`;
  }
  throw new Error('Process identity inspection is unavailable.');
}

function readSystemValue(filePath: string): string {
  const result = spawnSync('cat', [filePath], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Process identity is unavailable.');
  return result.stdout.trim();
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
