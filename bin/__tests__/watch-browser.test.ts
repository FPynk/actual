import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const watchBrowserPath = fileURLToPath(
  new URL('../../packages/desktop-client/bin/watch-browser', import.meta.url),
);
const shellPath =
  process.platform === 'win32'
    ? path.join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'Git',
        'bin',
        'sh.exe',
      )
    : 'sh';

async function runWatchBrowserFromCheckout(
  temporaryDirectoryPrefix: string,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), temporaryDirectoryPrefix),
  );
  const checkoutDirectory = path.join(temporaryDirectory, 'checkout');
  const launcherDirectory = path.join(checkoutDirectory, 'bin');
  const fakeYarnDirectory = path.join(temporaryDirectory, 'fake-bin');
  const outputFile = path.join(checkoutDirectory, '.watch-browser-test-output');

  try {
    await mkdir(launcherDirectory, { recursive: true });
    await mkdir(fakeYarnDirectory);
    await cp(watchBrowserPath, path.join(launcherDirectory, 'watch-browser'));
    await writeFile(
      path.join(fakeYarnDirectory, 'yarn'),
      `#!/bin/sh\nset -e\n\nexpected_root=$(cd "$WATCH_BROWSER_EXPECTED_ROOT" && pwd -P)\ntest "$(pwd -P)" = "$expected_root"\ntest "$PORT" = "3001"\ntest "$REACT_APP_BACKEND_WORKER_HASH" = "dev"\ntouch .watch-browser-test-output\n`,
    );
    await chmod(path.join(fakeYarnDirectory, 'yarn'), 0o755);

    await execFileAsync(
      shellPath,
      [path.join(launcherDirectory, 'watch-browser')],
      {
        env: {
          ...process.env,
          PATH: `${fakeYarnDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
          WATCH_BROWSER_EXPECTED_ROOT: checkoutDirectory,
        },
      },
    );

    expect(await readFile(outputFile, 'utf8')).toBe('');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

describe('watch-browser', () => {
  it('starts yarn from a checkout path containing spaces', async () => {
    await runWatchBrowserFromCheckout('watch browser ');
  });

  it('preserves non-spaced checkout path behavior', async () => {
    await runWatchBrowserFromCheckout('watch-browser-');
  });
});
