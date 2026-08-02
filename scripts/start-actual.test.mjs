import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
// eslint-disable-next-line actual/no-extraneous-dependencies -- node:test is a Node.js built-in.
import test from 'node:test';

import {
  ActualLauncher,
  createServiceCommands,
  launcherEnvironment,
  LauncherStoppedError,
  parseArguments,
  persistentPaths,
  requiredBuildOutputs,
  yarnExecutable,
  yarnReleasePath,
} from './start-actual.mjs';

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
  environment = {},
  fileExists = () => true,
  portAvailable = async () => undefined,
  fetchImplementation,
  failingService,
  spawnErrorService,
  now,
  readinessTimeout,
} = {}) {
  const spawned = [];
  const opened = [];
  let nextPid = 100;
  const spawnProcess = (executable, arguments_, options) => {
    const result = child(nextPid++);
    spawned.push({ arguments_, executable, options, result });
    const isOneShotBuild =
      arguments_.includes('build-dev') ||
      (arguments_.includes('vite') &&
        arguments_.includes('build') &&
        !arguments_.includes('--watch'));
    if (isOneShotBuild || executable === 'taskkill') {
      queueMicrotask(() => result.emit('exit', 0, null));
    }
    if (failingService && arguments_.includes(failingService)) {
      queueMicrotask(() => result.emit('exit', 9, null));
    }
    if (spawnErrorService && arguments_.includes(spawnErrorService)) {
      queueMicrotask(() =>
        result.emit('error', new Error('synthetic spawn failure')),
      );
    }
    return result;
  };
  const output = writable();
  const errorOutput = writable();
  return {
    errorOutput,
    launcher: new ActualLauncher({
      environment: {
        LOCALAPPDATA: 'C:\\Actual State',
        ...environment,
      },
      fetchImplementation:
        fetchImplementation ?? (async () => ({ ok: true, status: 200 })),
      openBrowser: async url => opened.push(url),
      output,
      errorOutput,
      ensurePaths: () => undefined,
      fileExists,
      platform: 'win32',
      portAvailable,
      now,
      readinessTimeout,
      sleep: async () => undefined,
      spawnProcess,
    }),
    opened,
    output,
    spawned,
  };
}

function serviceName(item) {
  if (item.arguments_.includes('--watch')) return 'worker';
  if (item.arguments_.includes('build-dev')) return 'plugin-build';
  if (
    item.arguments_.includes('@actual-app/core') &&
    item.arguments_.includes('build')
  ) {
    return 'worker-build';
  }
  if (
    item.arguments_.includes('plugins-service') &&
    item.arguments_.includes('watch')
  ) {
    return 'plugins';
  }
  if (item.arguments_.includes('@actual-app/web')) return 'frontend';
  if (item.arguments_.includes('@actual-app/sync-server')) return 'actual';
  return 'unknown';
}

void test('accepts --no-open and rejects every unknown argument', () => {
  assert.deepEqual(parseArguments([]), { noOpen: false });
  assert.deepEqual(parseArguments(['--no-open']), { noOpen: true });
  assert.throws(() => parseArguments(['--wrong']), /Unknown argument/);
});

void test('uses the committed Yarn release and one stable Actual data path', () => {
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
  assert.deepEqual(Object.keys(first), ['actualDataDirectory']);
  const commands = createServiceCommands();
  assert.equal(commands.frontend[0], process.execPath);
  assert.equal(commands.frontend[1][0], yarnReleasePath());
  assert.equal(commands.frontend[1].includes('sh'), false);
});

void test('honors an explicit Actual data directory without requiring a platform default', () => {
  assert.deepEqual(
    persistentPaths({ ACTUAL_DATA_DIR: 'D:\\Actual State' }, 'win32'),
    { actualDataDirectory: 'D:\\Actual State' },
  );
});

void test('builds workers, starts native Actual services, verifies readiness, and opens one URL', async () => {
  const requested = [];
  const checkedPorts = [];
  const { launcher, opened, spawned } = testLauncher({
    fetchImplementation: async url => {
      requested.push(url);
      return { ok: true, status: 200 };
    },
    portAvailable: async port => checkedPorts.push(port),
  });
  await launcher.start();
  assert.deepEqual(checkedPorts, [3001, 5006]);
  assert.deepEqual(opened, ['http://127.0.0.1:5006']);
  assert.deepEqual(requested, [
    'http://127.0.0.1:5006/info',
    'http://127.0.0.1:5006/',
    'http://127.0.0.1:5006/kcab/kcab.worker.dev.js',
    'http://127.0.0.1:5006/service-worker/plugin-sw.js',
  ]);
  assert.deepEqual(spawned.slice(0, 6).map(serviceName), [
    'worker-build',
    'plugin-build',
    'worker',
    'plugins',
    'frontend',
    'actual',
  ]);
});

void test('supports --no-open and reports a missing generated worker before services start', async () => {
  const outputs = requiredBuildOutputs();
  const missingPlugin = testLauncher({
    fileExists: filePath => filePath !== outputs[1].path,
  });
  await assert.rejects(
    missingPlugin.launcher.start({ noOpen: true }),
    /plugin worker build did not produce plugin-sw\.js/,
  );
  assert.deepEqual(missingPlugin.opened, []);
  assert.deepEqual(missingPlugin.spawned.map(serviceName), [
    'worker-build',
    'plugin-build',
  ]);

  const noOpen = testLauncher();
  await noOpen.launcher.start({ noOpen: true });
  assert.deepEqual(noOpen.opened, []);
});

void test('fails before spawning when a required port is occupied', async () => {
  const { launcher, spawned } = testLauncher({
    portAvailable: async port => {
      if (port === 5006) throw new Error('Port 5006 is already in use.');
    },
  });
  await assert.rejects(launcher.start(), /5006/);
  assert.equal(spawned.length, 0);
});

void test('stops startup on an unexpected native service failure', async () => {
  const { launcher, opened } = testLauncher({ failingService: 'watch' });
  await assert.rejects(launcher.start(), /plugins exited unexpectedly/);
  assert.deepEqual(opened, []);
});

void test('reports a child spawn error without waiting for readiness timeout', async () => {
  const { errorOutput, launcher } = testLauncher({
    fetchImplementation: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    spawnErrorService: '--watch',
  });

  await assert.rejects(
    launcher.start({ noOpen: true }),
    /worker could not start: synthetic spawn failure/,
  );
  assert.match(
    errorOutput.text,
    /worker could not start: synthetic spawn failure/,
  );
});

void test('cleans up every owned child when readiness times out', async () => {
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
  assert.equal(taskkill.length >= 4, true);
  assert.equal(
    taskkill.every(item => item.arguments_.includes('/T')),
    true,
  );
});

void test('shutdown aborts readiness immediately without a duplicate error', async () => {
  let readinessFetchStarted = false;
  const { errorOutput, launcher, spawned } = testLauncher({
    fetchImplementation: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        readinessFetchStarted = true;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const starting = launcher.start({ noOpen: true });
  while (!readinessFetchStarted) await Promise.resolve();
  await launcher.requestShutdown();
  await assert.rejects(starting, LauncherStoppedError);
  assert.equal(errorOutput.text, '');
  assert.equal(
    spawned.filter(item => item.executable === 'taskkill').length >= 4,
    true,
  );
});

void test('shutdown during a port check prevents every child spawn', async () => {
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

void test('Windows cleanup targets only recorded child process trees', async () => {
  const { launcher, spawned } = testLauncher();
  launcher.children = [{ name: 'owned', child: child(321) }];
  await launcher.shutdown();
  const taskkill = spawned.filter(item => item.executable === 'taskkill');
  assert.deepEqual(taskkill[0].arguments_, ['/PID', '321', '/T']);
  assert.equal(
    taskkill.every(item => item.arguments_.includes('321')),
    true,
  );
});

void test('launcher preserves explicit Actual and OpenAI settings while enforcing loopback development ports', async () => {
  const environment = launcherEnvironment({
    ACTUAL_DATA_DIR: 'D:\\Actual State',
    LOCALAPPDATA: 'C:\\Unused',
    OPENAI_API_KEY: 'synthetic-only',
  });
  assert.equal(environment.ACTUAL_DATA_DIR, 'D:\\Actual State');
  assert.equal(environment.ACTUAL_HOSTNAME, '127.0.0.1');
  assert.equal(environment.ACTUAL_PORT, '5006');
  assert.equal(environment.ACTUAL_EXTERNAL_LOOT_CORE_WATCHER, '1');
  assert.equal(environment.OPENAI_API_KEY, 'synthetic-only');
  assert.equal(
    Object.keys(environment).some(name =>
      name.startsWith('FINANCE_COMPANION_'),
    ),
    false,
  );

  const { launcher, spawned } = testLauncher({
    environment: {
      OPENAI_API_KEY: 'synthetic-only',
      openai_api_key: 'lowercase-synthetic-only',
    },
  });
  await launcher.start({ noOpen: true });
  const actual = spawned.find(item =>
    item.arguments_.includes('@actual-app/sync-server'),
  );
  assert.equal(actual.options.env.OPENAI_API_KEY, 'synthetic-only');
  assert.equal(
    spawned
      .filter(item => item !== actual)
      .every(
        item =>
          item.options.env.OPENAI_API_KEY === undefined &&
          item.options.env.openai_api_key === undefined,
      ),
    true,
  );
});

void test('the frontend exposes both worker assets through the normal Actual URL', async () => {
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
  assert.match(
    frontendConfiguration,
    /server\.middlewares\.use\('\/service-worker'/,
  );
  assert.match(frontendConfiguration, /env\.BROWSER === 'none'/);
  assert.match(syncServer, /target: 'http:\/\/127\.0\.0\.1:3001'/);
  assert.equal(
    path.basename(requiredBuildOutputs()[0].path),
    'kcab.worker.dev.js',
  );
});
