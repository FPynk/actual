import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line actual/no-extraneous-dependencies -- node:test is built into Node.
import test from 'node:test';

import {
  createServiceCommands,
  FinanceLauncher,
  launcherEnvironment,
  LauncherStoppedError,
  parseArguments,
  persistentPaths,
  preflightCompanionConfiguration,
  yarnExecutable,
  yarnReleasePath,
} from './start-finance.mjs';

function writable() {
  return {
    text: '',
    write(value) {
      this.text += value;
    },
  };
}

function child(pid) {
  const process_ = new EventEmitter();
  process_.pid = pid;
  process_.exitCode = null;
  process_.killed = false;
  process_.stdout = new EventEmitter();
  process_.stdout.setEncoding = () => undefined;
  process_.stderr = new EventEmitter();
  process_.stderr.setEncoding = () => undefined;
  return process_;
}

function testLauncher({
  workerExists = true,
  portAvailable = async () => undefined,
  fetchImplementation,
  failingService,
  now,
  readinessTimeout,
} = {}) {
  const spawned = [];
  const opened = [];
  let nextPid = 100;
  const spawnProcess = (executable, arguments_, options) => {
    const result = child(nextPid++);
    spawned.push({ arguments_, executable, options, result });
    if (
      arguments_.some(argument =>
        argument.includes('validate-finance-companion-config.ts'),
      ) ||
      (arguments_.includes('vite') &&
        arguments_.includes('build') &&
        !arguments_.includes('--watch')) ||
      (arguments_.includes('@actual-app/finance-companion') &&
        arguments_.includes('build'))
    ) {
      queueMicrotask(() => result.emit('exit', 0, null));
    }
    if (executable === 'taskkill') {
      queueMicrotask(() => result.emit('exit', 0, null));
    }
    if (failingService && arguments_.includes(failingService)) {
      queueMicrotask(() => result.emit('exit', 9, null));
    }
    return result;
  };
  const output = writable();
  const errorOutput = writable();
  return {
    errorOutput,
    opened,
    output,
    spawned,
    launcher: new FinanceLauncher({
      environment: {
        FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY: 'USD',
        FINANCE_COMPANION_ACTUAL_BUDGET_ID: 'synthetic-budget',
        FINANCE_COMPANION_ACTUAL_PASSWORD_FILE: 'C:\\secrets\\password',
        FINANCE_COMPANION_ACTUAL_SERVER_URL: 'http://127.0.0.1:5006',
        FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE: 'C:\\secrets\\mac',
        FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL: 'synthetic-direct-secret',
        LOCALAPPDATA: 'C:\\Finance State',
      },
      fetchImplementation:
        fetchImplementation ?? (async () => ({ ok: true, status: 200 })),
      openBrowser: async url => opened.push(url),
      output,
      errorOutput,
      ensurePaths: () => undefined,
      preflight: () => undefined,
      platform: 'win32',
      portAvailable,
      now,
      readinessTimeout,
      sleep: async () => undefined,
      spawnProcess,
      workerExists: () => workerExists,
    }),
  };
}

test('rejects unknown arguments and accepts --no-open', () => {
  assert.deepEqual(parseArguments(['--no-open']), { noOpen: true });
  assert.throws(() => parseArguments(['--wrong']), /Unknown argument/);
});

test('uses Node plus the committed Yarn release on Windows paths and stable disjoint persistent paths', () => {
  const environment = { LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' };
  const first = persistentPaths(environment, 'win32');
  const second = persistentPaths(environment, 'win32');
  assert.equal(yarnExecutable(), process.execPath);
  assert.match(
    yarnReleasePath(),
    /\.yarn[\\/]releases[\\/]yarn-4\.17\.1\.cjs$/,
  );
  assert.deepEqual(first, second);
  assert.match(first.actualDataDirectory, /ActualBudgetServer$/);
  assert.match(
    first.companionDataDirectory,
    /ActualFinanceCompanion[\\/]data$/,
  );
  assert.match(
    first.actualApiDirectory,
    /ActualFinanceCompanion[\\/]actual-api$/,
  );
  assert.match(
    first.integrityAnchorPath,
    /ActualFinanceCompanion[\\/]anchor[\\/]integrity-anchor\.json$/,
  );
  const commands = createServiceCommands('win32');
  assert.equal(commands.frontend[0], process.execPath);
  assert.equal(commands.frontend[1][0], yarnReleasePath());
  assert.equal(commands.frontend[1].includes('sh'), false);
  const yarnVersion = spawnSync(
    yarnExecutable(),
    [yarnReleasePath(), '--version'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(yarnVersion.status, 0, yarnVersion.stderr);
  assert.match(yarnVersion.stdout, /^4\.17\.1/);
});

test('starts in required order, waits for all readiness URLs, then opens proxied Actual', async () => {
  const requested = [];
  const { launcher, opened, spawned } = testLauncher({
    fetchImplementation: async url => {
      requested.push(url);
      return { ok: true, status: 200 };
    },
  });
  await launcher.start();
  assert.deepEqual(opened, ['http://127.0.0.1:5006', 'http://127.0.0.1:4100']);
  assert.deepEqual(requested, [
    'http://127.0.0.1:5006/info',
    'http://127.0.0.1:5006/',
    'http://127.0.0.1:5006/kcab/kcab.worker.dev.js',
    'http://127.0.0.1:4100/health',
  ]);
  assert.deepEqual(
    spawned.slice(0, 8).map(item => {
      if (
        item.arguments_.some(argument =>
          argument.includes('validate-finance-companion-config.ts'),
        )
      ) {
        return 'configuration';
      }
      if (
        item.arguments_.includes('@actual-app/finance-companion') &&
        item.arguments_.includes('build')
      ) {
        return 'companion-build';
      }
      if (item.arguments_.includes('./dist/service/cli.js')) return 'companion';
      if (item.arguments_.includes('--watch')) return 'worker';
      if (item.arguments_.includes('plugins-service')) return 'plugins';
      if (item.arguments_.includes('@actual-app/web')) return 'frontend';
      if (item.arguments_.includes('@actual-app/sync-server')) return 'actual';
      return 'worker-build';
    }),
    [
      'configuration',
      'worker-build',
      'companion-build',
      'worker',
      'plugins',
      'frontend',
      'actual',
      'companion',
    ],
  );
});

test('does not open a browser when requested and fails if the worker is absent', async () => {
  const missingWorker = testLauncher({ workerExists: false });
  await assert.rejects(
    missingWorker.launcher.start({ noOpen: true }),
    /did not produce/,
  );
  assert.deepEqual(missingWorker.opened, []);
  const noOpen = testLauncher();
  await noOpen.launcher.start({ noOpen: true });
  assert.deepEqual(noOpen.opened, []);
});

test('fails before spawning when a required port is occupied and never includes secret values in its error', async () => {
  const { errorOutput, launcher, output, spawned } = testLauncher({
    portAvailable: async port => {
      if (port === 4100) throw new Error('Port 4100 is already in use.');
    },
  });
  await assert.rejects(launcher.start(), /4100/);
  assert.equal(spawned.length, 0);
  assert.equal(output.text.includes('synthetic-direct-secret'), false);
  assert.equal(errorOutput.text.includes('synthetic-direct-secret'), false);
});

test('rejects an absent secret file before any child starts without reading its contents', () => {
  assert.throws(
    () =>
      preflightCompanionConfiguration({
        FINANCE_COMPANION_ACTUAL_SERVER_URL: 'http://127.0.0.1:5006',
        FINANCE_COMPANION_ACTUAL_PASSWORD_FILE: 'C:\\missing\\password',
      }),
    /FINANCE_COMPANION_ACTUAL_PASSWORD_FILE/,
  );
});

test('passes companion configuration only to its validator and companion runtime child', async () => {
  const { launcher, spawned } = testLauncher();
  await launcher.start({ noOpen: true });
  const directSecret = 'synthetic-direct-secret';
  const configurationAndCompanion = spawned.filter(
    item =>
      item.arguments_.some(argument =>
        argument.includes('validate-finance-companion-config.ts'),
      ) || item.arguments_.includes('./dist/service/cli.js'),
  );
  assert.equal(
    configurationAndCompanion.every(
      item =>
        item.options.env.FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL ===
        directSecret,
    ),
    true,
  );
  const unrelated = spawned.filter(
    item => !configurationAndCompanion.includes(item),
  );
  assert.equal(
    unrelated.every(
      item =>
        !Object.keys(item.options.env).some(name =>
          name.startsWith('FINANCE_COMPANION_'),
        ),
    ),
    true,
  );
  const actual = spawned.find(item =>
    item.arguments_.includes('@actual-app/sync-server'),
  );
  const companionBuild = spawned.find(
    item =>
      item.arguments_.includes('@actual-app/finance-companion') &&
      item.arguments_.includes('build'),
  );
  const companionRuntime = spawned.find(item =>
    item.arguments_.includes('./dist/service/cli.js'),
  );
  const frontend = spawned.find(item =>
    item.arguments_.includes('@actual-app/web'),
  );
  assert.equal(
    Object.keys(companionBuild.options.env).some(name =>
      name.startsWith('FINANCE_COMPANION_'),
    ),
    false,
  );
  assert.equal(
    companionRuntime.options.env.FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL,
    directSecret,
  );
  assert.equal(actual.options.env.ACTUAL_HOSTNAME, '127.0.0.1');
  assert.equal(actual.options.env.NODE_ENV, 'development');
  assert.equal(frontend.options.env.BROWSER, 'none');
  assert.equal(frontend.options.env.PORT, '3001');
});

test('stops startup on an unexpected child failure before opening a browser', async () => {
  const { launcher, opened } = testLauncher({
    failingService: 'plugins-service',
  });
  await assert.rejects(launcher.start(), /plugins exited unexpectedly/);
  assert.deepEqual(opened, []);
});

test('cleans up every owned child when readiness fails', async () => {
  let currentTime = 0;
  const { launcher, spawned } = testLauncher({
    fetchImplementation: async () => ({ ok: false, status: 503 }),
    now: () => currentTime++,
    readinessTimeout: 2,
  });
  await assert.rejects(
    launcher.start({ noOpen: true }),
    /Actual server was not ready/,
  );
  const taskkill = spawned.filter(item => item.executable === 'taskkill');
  assert.equal(taskkill.length >= 5, true);
  assert.equal(
    taskkill.every(item => item.arguments_.includes('/T')),
    true,
  );
});

test('shutdown aborts readiness immediately without writing a duplicate error', async () => {
  let readinessFetchStarted;
  const { errorOutput, launcher, spawned } = testLauncher({
    fetchImplementation: (_url, { signal }) =>
      new Promise((resolve, reject) => {
        readinessFetchStarted = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const starting = launcher.start({ noOpen: true });
  while (readinessFetchStarted === undefined) await Promise.resolve();
  await launcher.requestShutdown();
  await assert.rejects(starting, LauncherStoppedError);
  assert.equal(errorOutput.text, '');
  assert.equal(
    spawned.filter(item => item.executable === 'taskkill').length >= 5,
    true,
  );
});

test('shutdown during a pre-spawn awaited stage prevents every later child', async () => {
  let releasePortCheck;
  let portCheckStarted = false;
  let firstPortCheck = true;
  const { launcher, spawned } = testLauncher({
    portAvailable: async () => {
      if (!firstPortCheck) return;
      firstPortCheck = false;
      portCheckStarted = true;
      await new Promise(resolve => {
        releasePortCheck = resolve;
      });
    },
  });
  const starting = launcher.start({ noOpen: true });
  while (!portCheckStarted) await Promise.resolve();
  await launcher.requestShutdown();
  releasePortCheck();
  await assert.rejects(starting, LauncherStoppedError);
  assert.equal(spawned.length, 0);
});

test('selects only recorded Windows child PIDs for graceful and forced cleanup', async () => {
  const { launcher, spawned } = testLauncher();
  const active = child(321);
  launcher.children = [{ name: 'owned', child: active }];
  await launcher.shutdown();
  const taskkill = spawned.filter(item => item.executable === 'taskkill');
  assert.deepEqual(taskkill[0].arguments_, ['/PID', '321', '/T']);
  assert.equal(
    taskkill.every(item => item.arguments_.includes('321')),
    true,
  );
});

test('launcher defaults preserve explicit paths while applying loopback service settings', () => {
  const environment = launcherEnvironment({
    ACTUAL_DATA_DIR: 'D:\\Actual State',
    FINANCE_COMPANION_DATA_DIR: 'D:\\Companion Data',
    LOCALAPPDATA: 'C:\\Unused',
  });
  assert.equal(environment.ACTUAL_DATA_DIR, 'D:\\Actual State');
  assert.equal(environment.FINANCE_COMPANION_DATA_DIR, 'D:\\Companion Data');
  assert.equal(environment.ACTUAL_HOSTNAME, '127.0.0.1');
  assert.equal(environment.ACTUAL_EXTERNAL_LOOT_CORE_WATCHER, '1');
});

test('the development frontend keeps worker middleware and does not auto-open a raw Vite tab', async () => {
  const frontendConfiguration = await readFile(
    new URL('../packages/desktop-client/vite.config.mts', import.meta.url),
    'utf8',
  );
  const syncServer = await readFile(
    new URL('../packages/sync-server/src/app.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    frontendConfiguration,
    /ACTUAL_EXTERNAL_LOOT_CORE_WATCHER !== '1'/,
  );
  assert.match(frontendConfiguration, /server\.middlewares\.use\('\/kcab'/);
  assert.match(frontendConfiguration, /env\.BROWSER === 'none'/);
  assert.match(syncServer, /target: 'http:\/\/127\.0\.0\.1:3001'/);
});
