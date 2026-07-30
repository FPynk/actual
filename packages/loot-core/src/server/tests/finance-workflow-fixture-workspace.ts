import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { createSyntheticFinanceWorkflowFixture } from '#mocks/finance-workflow';
import type {
  SyntheticFinanceClock,
  SyntheticFinanceWorkflowFixture,
} from '#mocks/finance-workflow';

const workspaceDirectoryPrefix = 'actual-finance-fixture-';

type SyntheticFinanceFixtureWorkspaceOptions = {
  clock?: SyntheticFinanceClock;
  temporaryRoot?: string;
};

export type SyntheticFinanceFixtureWorkspace = Readonly<{
  directory: string;
  fixture: SyntheticFinanceWorkflowFixture;
  registerCleanup: (cleanup: () => void | Promise<void>) => void;
}>;

export function withSyntheticFinanceFixtureWorkspace<T>(
  run: (workspace: SyntheticFinanceFixtureWorkspace) => Promise<T>,
): Promise<T>;
export function withSyntheticFinanceFixtureWorkspace<T>(
  options: SyntheticFinanceFixtureWorkspaceOptions,
  run: (workspace: SyntheticFinanceFixtureWorkspace) => Promise<T>,
): Promise<T>;
export async function withSyntheticFinanceFixtureWorkspace<T>(
  optionsOrRun:
    | SyntheticFinanceFixtureWorkspaceOptions
    | ((workspace: SyntheticFinanceFixtureWorkspace) => Promise<T>),
  optionalRun?: (workspace: SyntheticFinanceFixtureWorkspace) => Promise<T>,
): Promise<T> {
  const options = typeof optionsOrRun === 'function' ? {} : optionsOrRun;
  const run = typeof optionsOrRun === 'function' ? optionsOrRun : optionalRun;

  if (!run) {
    throw new Error('A finance fixture workspace callback is required.');
  }

  const temporaryRootDirectory = await realpath(
    resolve(options.temporaryRoot ?? tmpdir()),
  );
  const workspaceDirectory = await realpath(
    await mkdtemp(join(temporaryRootDirectory, workspaceDirectoryPrefix)),
  );
  validateWorkspaceDirectory(workspaceDirectory, temporaryRootDirectory);

  const cleanups: Array<() => void | Promise<void>> = [];
  const workspace: SyntheticFinanceFixtureWorkspace = {
    directory: workspaceDirectory,
    fixture: createSyntheticFinanceWorkflowFixture({
      clock: options.clock,
    }),
    registerCleanup: cleanup => {
      cleanups.push(cleanup);
    },
  };

  let callbackOutcome:
    | Readonly<{ succeeded: true; result: T }>
    | Readonly<{ succeeded: false; error: unknown }>;

  try {
    callbackOutcome = { succeeded: true, result: await run(workspace) };
  } catch (error) {
    callbackOutcome = { succeeded: false, error };
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    validateWorkspaceDirectory(
      await realpath(workspaceDirectory),
      temporaryRootDirectory,
    );
    await rm(workspaceDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (callbackOutcome.succeeded === false) {
    attachCleanupErrors(callbackOutcome.error, cleanupErrors);
    throw callbackOutcome.error;
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Synthetic finance fixture workspace cleanup failed.',
    );
  }

  return callbackOutcome.result;
}

function validateWorkspaceDirectory(
  workspaceDirectory: string,
  temporaryRootDirectory: string,
): void {
  if (
    dirname(workspaceDirectory) !== temporaryRootDirectory ||
    !basename(workspaceDirectory).startsWith(workspaceDirectoryPrefix)
  ) {
    throw new Error(
      'Refusing to remove an unscoped finance fixture workspace.',
    );
  }
}

function attachCleanupErrors(
  callbackError: unknown,
  cleanupErrors: unknown[],
): void {
  if (cleanupErrors.length === 0 || !(callbackError instanceof Error)) {
    return;
  }

  Object.defineProperty(callbackError, 'cause', {
    configurable: true,
    value: new AggregateError(
      cleanupErrors,
      'Synthetic finance fixture workspace cleanup also failed.',
    ),
  });
}
