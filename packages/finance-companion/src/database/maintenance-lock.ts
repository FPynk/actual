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
  const lockPath = `${databasePath}.maintenance.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new MaintenanceRequiredError();
  }
  try {
    return await run();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      throw new MaintenanceRequiredError();
    }
  }
}
