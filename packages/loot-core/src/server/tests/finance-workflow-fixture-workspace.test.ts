import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { withSyntheticFinanceFixtureWorkspace } from './finance-workflow-fixture-workspace';

const testRootPrefix = 'actual finance fixture tests-';

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), testRootPrefix));
});

afterEach(async () => {
  if (
    dirname(testRoot) !== tmpdir() ||
    !basename(testRoot).startsWith(testRootPrefix)
  ) {
    throw new Error('Refusing to remove an unscoped fixture test root.');
  }

  await rm(testRoot, { recursive: true, force: true });
});

describe('synthetic finance fixture workspace', () => {
  test('creates unique parallel children beneath a root containing spaces', async () => {
    const workspaceDirectories = await Promise.all(
      Array.from({ length: 4 }, () =>
        withSyntheticFinanceFixtureWorkspace(
          { temporaryRoot: testRoot },
          async workspace => {
            expect(dirname(workspace.directory)).toBe(testRoot);
            expect(basename(workspace.directory)).toMatch(
              /^actual-finance-fixture-/,
            );
            expect(workspace.fixture.accounts).toHaveLength(2);
            return workspace.directory;
          },
        ),
      ),
    );

    expect(new Set(workspaceDirectories).size).toBe(
      workspaceDirectories.length,
    );
    expect(await readdir(testRoot)).toEqual([]);
    await Promise.all(
      workspaceDirectories.map(async directory => {
        expect(await pathExists(directory)).toBe(false);
      }),
    );
  });

  test('awaits cleanup callbacks in reverse order before removing the child', async () => {
    const cleanupOrder: string[] = [];
    let workspaceDirectory = '';
    let secondCleanupCount = 0;

    await withSyntheticFinanceFixtureWorkspace(
      { temporaryRoot: testRoot },
      async workspace => {
        workspaceDirectory = workspace.directory;
        await writeFile(
          join(workspace.directory, 'owned-handle.txt'),
          'fixture',
        );
        workspace.registerCleanup(async () => {
          cleanupOrder.push('first');
          expect(await pathExists(workspace.directory)).toBe(true);
        });
        workspace.registerCleanup(async () => {
          secondCleanupCount += 1;
          await Promise.resolve();
          cleanupOrder.push('second');
          expect(await pathExists(workspace.directory)).toBe(true);
        });
      },
    );

    expect(cleanupOrder).toEqual(['second', 'first']);
    expect(secondCleanupCount).toBe(1);
    expect(await pathExists(workspaceDirectory)).toBe(false);
    expect(await readdir(testRoot)).toEqual([]);
  });

  test('runs cleanup once and removes the child when the callback fails', async () => {
    const callbackError = new Error('primary callback failure');
    let cleanupCount = 0;
    let workspaceDirectory = '';

    await expect(
      withSyntheticFinanceFixtureWorkspace(
        { temporaryRoot: testRoot },
        async workspace => {
          workspaceDirectory = workspace.directory;
          workspace.registerCleanup(() => {
            cleanupCount += 1;
          });
          throw callbackError;
        },
      ),
    ).rejects.toBe(callbackError);

    expect(cleanupCount).toBe(1);
    expect(await pathExists(workspaceDirectory)).toBe(false);
    expect(await readdir(testRoot)).toEqual([]);
  });

  test('preserves the callback error and attaches cleanup failures', async () => {
    const callbackError = new Error('primary callback failure');
    const cleanupError = new Error('secondary cleanup failure');

    try {
      await withSyntheticFinanceFixtureWorkspace(
        { temporaryRoot: testRoot },
        async workspace => {
          workspace.registerCleanup(() => {
            throw cleanupError;
          });
          throw callbackError;
        },
      );
      throw new Error('Expected the workspace callback to fail.');
    } catch (error) {
      expect(error).toBe(callbackError);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.cause).toBeInstanceOf(AggregateError);
      if (!(error.cause instanceof AggregateError)) {
        throw error.cause;
      }
      expect(error.cause.errors).toEqual([cleanupError]);
    }

    expect(await readdir(testRoot)).toEqual([]);
  });

  test('supports the overload without options and removes its child', async () => {
    let workspaceDirectory = '';

    const result = await withSyntheticFinanceFixtureWorkspace(
      async workspace => {
        workspaceDirectory = workspace.directory;
        return workspace.fixture.ids.accounts.checking;
      },
    );

    expect(result).toBe('10000000-0000-4000-8000-000000000001');
    expect(await pathExists(workspaceDirectory)).toBe(false);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
