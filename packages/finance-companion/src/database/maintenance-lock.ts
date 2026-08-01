import { closeSync, openSync, unlinkSync } from 'node:fs';

export class MaintenanceRequiredError extends Error {
  constructor() {
    super('Exclusive maintenance is required.');
    this.name = 'MaintenanceRequiredError';
  }
}

export async function withExclusiveMaintenanceLock<T>(
  databasePath: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const lock = acquireExclusiveMaintenanceLock(databasePath);
  try {
    return await run();
  } finally {
    releaseExclusiveMaintenanceLock(lock);
  }
}

export function withExclusiveMaintenanceLockSync<T>(
  databasePath: string,
  run: () => T,
): T {
  const lock = acquireExclusiveMaintenanceLock(databasePath);
  try {
    return run();
  } finally {
    releaseExclusiveMaintenanceLock(lock);
  }
}

function acquireExclusiveMaintenanceLock(databasePath: string): Readonly<{
  descriptor: number;
  lockPath: string;
}> {
  const lockPath = `${databasePath}.maintenance.lock`;
  try {
    return { descriptor: openSync(lockPath, 'wx', 0o600), lockPath };
  } catch {
    throw new MaintenanceRequiredError();
  }
}

function releaseExclusiveMaintenanceLock(
  lock: Readonly<{ descriptor: number; lockPath: string }>,
): void {
  closeSync(lock.descriptor);
  try {
    unlinkSync(lock.lockPath);
  } catch {
    throw new MaintenanceRequiredError();
  }
}
