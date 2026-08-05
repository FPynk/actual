import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const actualUrl = 'http://127.0.0.1:5006';
const readinessTimeoutMilliseconds = 60_000;
const readinessRetryMilliseconds = 250;
const shutdownGraceMilliseconds = 3_000;

const readinessEndpoints = [
  {
    name: 'Actual server',
    path: '/info',
    validate: validateInfoResponse,
  },
  {
    name: 'Actual launch bootstrap',
    path: '/kcab/actual-launch.html',
    validate: validateLaunchBootstrapResponse,
  },
  {
    name: 'Actual frontend',
    path: '/',
    validate: validateFrontendResponse,
  },
  {
    name: 'Actual worker',
    path: '/kcab/kcab.worker.dev.js',
    validate: response => validateJavaScriptResponse(response, 'var backend'),
  },
  {
    name: 'Actual plugin worker',
    path: '/service-worker/plugin-sw.js',
    validate: response =>
      validateJavaScriptResponse(response, 'Plugins Worker installing'),
  },
];

export class LauncherStoppedError extends Error {
  constructor() {
    super('Launcher stopped.');
    this.name = 'LauncherStoppedError';
  }
}

export function parseArguments(arguments_) {
  const noOpen = arguments_.includes('--no-open');
  const unknown = arguments_.filter(argument => argument !== '--no-open');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown.join(', ')}`);
  }
  return { noOpen };
}

export function launchUrl(nonce) {
  if (!nonce) throw new Error('A browser launch nonce is required.');
  const url = new URL('/kcab/actual-launch.html', actualUrl);
  url.searchParams.set('actual-launch', nonce);
  return url.href;
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) ?? '';
}

function hasJavaScriptMimeType(contentType) {
  return /(?:application|text)\/(?:javascript|ecmascript)|application\/x-javascript/i.test(
    contentType,
  );
}

function validateIsolationHeaders(response) {
  if (
    responseHeader(response, 'cross-origin-opener-policy') !== 'same-origin'
  ) {
    return 'missing Cross-Origin-Opener-Policy: same-origin';
  }
  if (
    responseHeader(response, 'cross-origin-embedder-policy') !== 'require-corp'
  ) {
    return 'missing Cross-Origin-Embedder-Policy: require-corp';
  }
  return undefined;
}

async function responseText(response) {
  if (typeof response.text !== 'function') {
    throw new Error('response did not provide a body');
  }
  return response.text();
}

async function validateInfoResponse(response) {
  if (!response.ok) return `HTTP ${response.status}`;
  try {
    const info = JSON.parse(await responseText(response));
    if (info?.build?.name !== '@actual-app/sync-server') {
      return 'JSON response was not the Actual sync server info payload';
    }
    if (typeof info.build.version !== 'string' || !info.build.version) {
      return 'Actual sync server info payload did not include a build version';
    }
  } catch {
    return 'expected a valid Actual sync server JSON response';
  }
  return undefined;
}

async function validateFrontendResponse(response) {
  if (!response.ok) return `HTTP ${response.status}`;
  const isolationError = validateIsolationHeaders(response);
  if (isolationError) return isolationError;
  const contentType = responseHeader(response, 'content-type');
  if (!contentType.toLowerCase().includes('text/html')) {
    return `expected HTML entry, received ${contentType || 'no content type'}`;
  }
  try {
    const html = await responseText(response);
    if (
      !/<title>Actual<\/title>/i.test(html) ||
      !/<div id="root"><\/div>/i.test(html) ||
      !/\/@vite\/client/.test(html)
    ) {
      return 'HTML response was not the Actual Vite entry point';
    }
  } catch {
    return 'could not read the Actual Vite HTML entry';
  }
  return undefined;
}

async function validateLaunchBootstrapResponse(response) {
  if (!response.ok) return `HTTP ${response.status}`;
  const isolationError = validateIsolationHeaders(response);
  if (isolationError) return isolationError;
  const contentType = responseHeader(response, 'content-type');
  if (!contentType.toLowerCase().includes('text/html')) {
    return `expected HTML bootstrap, received ${contentType || 'no content type'}`;
  }
  try {
    const html = await responseText(response);
    if (
      !/id="actual-launch-bootstrap"/.test(html) ||
      !/actual-launch-service-worker-cleanup:/.test(html) ||
      !/location\.replace/.test(html)
    ) {
      return 'HTML response was not the Actual launch bootstrap';
    }
  } catch {
    return 'could not read the Actual launch bootstrap';
  }
  return undefined;
}

async function validateJavaScriptResponse(response, marker) {
  if (!response.ok) return `HTTP ${response.status}`;
  const contentType = responseHeader(response, 'content-type');
  if (!hasJavaScriptMimeType(contentType)) {
    return `expected JavaScript MIME type, received ${contentType || 'no content type'}`;
  }
  try {
    const body = await responseText(response);
    const trimmedBody = body.trim();
    if (!trimmedBody) return 'received an empty JavaScript response';
    if (/^<(?:!doctype\b|html\b)/i.test(trimmedBody)) {
      return 'received HTML instead of JavaScript';
    }
    if (!trimmedBody.includes(marker)) {
      return 'JavaScript response was missing its expected Actual marker';
    }
  } catch {
    return 'could not read the JavaScript response';
  }
  return undefined;
}

export function yarnExecutable() {
  return process.execPath;
}

export function yarnReleasePath() {
  return path.join(repositoryRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs');
}

export function persistentPaths(
  environment = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
) {
  if (environment.ACTUAL_DATA_DIR) {
    return { actualDataDirectory: environment.ACTUAL_DATA_DIR };
  }
  const dataHome =
    platform === 'win32'
      ? environment.LOCALAPPDATA
      : environment.XDG_DATA_HOME ||
        path.join(homeDirectory, '.local', 'share');
  if (!dataHome) throw new Error('LOCALAPPDATA is required on Windows.');
  return {
    actualDataDirectory: path.join(dataHome, 'ActualBudgetServer'),
  };
}

export function launcherEnvironment(
  environment = process.env,
  paths = persistentPaths(environment),
) {
  return {
    ...environment,
    ACTUAL_DATA_DIR: paths.actualDataDirectory,
    ACTUAL_EXTERNAL_LOOT_CORE_WATCHER: '1',
    ACTUAL_HOSTNAME: '127.0.0.1',
    ACTUAL_PORT: '5006',
    BROWSER: 'none',
    PORT: '3001',
    REACT_APP_BACKEND_WORKER_HASH: 'dev',
  };
}

function withoutServerSecrets(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name.toUpperCase() !== 'OPENAI_API_KEY',
    ),
  );
}

export function createServiceCommands() {
  const yarn = [yarnReleasePath()];
  return {
    buildWorker: [
      yarnExecutable(),
      [
        ...yarn,
        'workspace',
        '@actual-app/core',
        'exec',
        'vite',
        'build',
        '--mode',
        'development',
      ],
    ],
    buildPlugins: [
      yarnExecutable(),
      [...yarn, 'workspace', 'plugins-service', 'build-dev'],
    ],
    watchWorker: [
      yarnExecutable(),
      [
        ...yarn,
        'workspace',
        '@actual-app/core',
        'exec',
        'vite',
        'build',
        '--mode',
        'development',
        '--watch',
      ],
    ],
    watchPlugins: [
      yarnExecutable(),
      [...yarn, 'workspace', 'plugins-service', 'watch'],
    ],
    frontend: [
      yarnExecutable(),
      [
        ...yarn,
        'workspace',
        '@actual-app/web',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        '3001',
        '--strictPort',
        '--mode',
        'browser',
      ],
    ],
    actual: [
      yarnExecutable(),
      [...yarn, 'workspace', '@actual-app/sync-server', 'start'],
    ],
  };
}

export function requiredBuildOutputs() {
  return [
    {
      name: 'loot-core worker',
      path: path.join(
        repositoryRoot,
        'packages',
        'loot-core',
        'lib-dist',
        'browser',
        'kcab.worker.dev.js',
      ),
    },
    {
      name: 'plugin worker',
      path: path.join(
        repositoryRoot,
        'packages',
        'plugins-service',
        'dist',
        'plugin-sw.js',
      ),
    },
  ];
}

export function ensurePersistentPaths(paths) {
  mkdirSync(paths.actualDataDirectory, { recursive: true });
}

export function prefixedOutput(name, stream, output = process.stdout) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) output.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) output.write(`[${name}] ${pending}\n`);
  });
}

export class ActualLauncher {
  constructor({
    environment = process.env,
    platform = process.platform,
    spawnProcess = spawn,
    fetchImplementation = fetch,
    openBrowser = defaultBrowserOpen,
    output = process.stdout,
    errorOutput = process.stderr,
    ensurePaths = ensurePersistentPaths,
    fileExists = existsSync,
    portAvailable = assertPortAvailable,
    readinessTimeout = readinessTimeoutMilliseconds,
    sleep = milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
    createLaunchNonce,
    onFailure = () => undefined,
  } = {}) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.fetchImplementation = fetchImplementation;
    this.openBrowser = openBrowser;
    this.output = output;
    this.errorOutput = errorOutput;
    this.ensurePaths = ensurePaths;
    this.fileExists = fileExists;
    this.portAvailable = portAvailable;
    this.readinessTimeout = readinessTimeout;
    this.sleep = sleep;
    this.now = now;
    this.createLaunchNonce = createLaunchNonce ?? (() => String(this.now()));
    this.onFailure = onFailure;
    this.paths = persistentPaths(environment, platform);
    this.environment = launcherEnvironment(environment, this.paths);
    this.nonServerEnvironment = withoutServerSecrets(this.environment);
    this.commands = createServiceCommands();
    this.children = [];
    this.shuttingDown = false;
    this.shutdownRequested = false;
    this.failure = undefined;
    this.reportedFailure = false;
    this.readinessAbortController = new AbortController();
  }

  async start({ noOpen = false } = {}) {
    try {
      this.ensurePaths(this.paths);
      await this.assertPortsAvailable([3001, 5006]);
      this.throwIfStopping();
      await this.runOnce('worker-build', ...this.commands.buildWorker);
      this.throwIfStopping();
      await this.runOnce('plugin-build', ...this.commands.buildPlugins);
      this.throwIfStopping();
      for (const output of requiredBuildOutputs()) {
        if (!this.fileExists(output.path)) {
          throw new Error(
            `The ${output.name} build did not produce ${path.basename(output.path)}. Check the build output above, then run corepack yarn start:actual again.`,
          );
        }
      }

      const services = [
        ['worker', this.commands.watchWorker],
        ['plugins', this.commands.watchPlugins],
        ['frontend', this.commands.frontend],
        ['actual', this.commands.actual],
      ];
      for (const [name, command] of services) {
        this.throwIfStopping();
        this.startChild(name, ...command);
      }

      await this.waitForReadiness();
      if (!noOpen) await this.openBrowser(launchUrl(this.createLaunchNonce()));
      this.output.write(
        `Actual is ready at ${actualUrl}. Press Ctrl+C to stop.\n`,
      );
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  startChild(name, executable, arguments_, allowExit = false) {
    this.throwIfStopping();
    const child = this.spawnProcess(executable, arguments_, {
      cwd: repositoryRoot,
      detached: this.platform !== 'win32',
      env: this.childEnvironment(name),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, name };
    this.children.push(record);
    prefixedOutput(name, child.stdout, this.output);
    prefixedOutput(name, child.stderr, this.errorOutput);
    child.once(
      'error',
      error => void this.fail(`${name} could not start: ${error.message}`),
    );
    child.once('exit', (code, signal) => {
      if (!allowExit && !this.shuttingDown) {
        this.failure ??= new Error(
          `${name} exited unexpectedly (${code ?? signal ?? 'unknown'}). Check the prefixed service output above.`,
        );
        void this.fail(this.failure.message);
      }
    });
    return record;
  }

  childEnvironment(name) {
    if (name === 'actual') {
      return {
        ...this.environment,
        ACTUAL_HOSTNAME: '127.0.0.1',
        NODE_ENV: 'development',
      };
    }
    if (name === 'frontend') {
      return { ...this.nonServerEnvironment, BROWSER: 'none', PORT: '3001' };
    }
    return { ...this.nonServerEnvironment };
  }

  throwIfStopping() {
    if (this.failure) throw this.failure;
    if (this.shutdownRequested || this.shuttingDown) {
      throw new LauncherStoppedError();
    }
  }

  async runOnce(name, executable, arguments_) {
    const record = this.startChild(name, executable, arguments_, true);
    await new Promise((resolve, reject) => {
      record.child.once('error', reject);
      record.child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${name} failed (${code ?? signal ?? 'unknown'}). Check the prefixed build output above.`,
            ),
          );
        }
      });
    });
    this.children = this.children.filter(child => child !== record);
  }

  async assertPortsAvailable(ports) {
    for (const port of ports) await this.portAvailable(port);
  }

  async waitForReadiness() {
    const deadline = this.now() + this.readinessTimeout;
    let consecutiveSuccessfulRounds = 0;
    let lastError = 'not responding';

    while (this.now() < deadline) {
      this.throwIfStopping();
      const result = await this.checkReadinessRound();
      if (result.ok) {
        consecutiveSuccessfulRounds++;
        if (consecutiveSuccessfulRounds === 2) return;
      } else {
        consecutiveSuccessfulRounds = 0;
        lastError = result.error;
      }

      if (this.now() < deadline) await this.sleep(readinessRetryMilliseconds);
    }

    throw new Error(
      `Actual readiness did not stabilize within ${this.readinessTimeout / 1000} seconds (${lastError}). Check the prefixed service output above.`,
    );
  }

  async checkReadinessRound() {
    for (const endpoint of readinessEndpoints) {
      const url = `${actualUrl}${endpoint.path}`;
      try {
        const response = await this.fetchImplementation(url, {
          signal: AbortSignal.any([
            this.readinessAbortController.signal,
            AbortSignal.timeout(2_000),
          ]),
        });
        const validationError = await endpoint.validate(response);
        if (validationError) {
          return { ok: false, error: `${endpoint.name}: ${validationError}` };
        }
      } catch {
        this.throwIfStopping();
        return { ok: false, error: `${endpoint.name}: request failed` };
      }
    }
    return { ok: true };
  }

  async fail(message) {
    if (this.shuttingDown) return;
    this.failure ??= new Error(message);
    this.reportedFailure = true;
    this.errorOutput.write(`${message}\n`);
    await this.shutdown();
    this.onFailure();
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.readinessAbortController.abort();
    const records = [...this.children];
    await Promise.all(records.map(record => this.stopChild(record, false)));
    if (records.length > 0) await this.sleep(shutdownGraceMilliseconds);
    await Promise.all(
      records
        .filter(({ child }) => child.exitCode === null && !child.killed)
        .map(record => this.stopChild(record, true)),
    );
    this.children = [];
  }

  async requestShutdown() {
    this.shutdownRequested = true;
    await this.shutdown();
  }

  async stopChild(record, force) {
    const { child } = record;
    if (!child.pid || child.exitCode !== null) return;
    if (this.platform === 'win32') {
      const arguments_ = ['/PID', String(child.pid), '/T'];
      if (force) arguments_.push('/F');
      const taskkill = this.spawnProcess('taskkill', arguments_, {
        shell: false,
        stdio: 'ignore',
      });
      await new Promise(resolve => taskkill.once('exit', resolve));
      return;
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

export function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error =>
      reject(
        new Error(
          `Port ${port} is already in use or unavailable (${error.code ?? error.message}). Close the process using it, then run corepack yarn start:actual again.`,
        ),
      ),
    );
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(resolve));
  });
}

function defaultBrowserOpen(url) {
  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const arguments_ =
    process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function main() {
  let launcher;
  try {
    launcher = new ActualLauncher({
      onFailure: () => {
        process.exitCode = 1;
      },
    });
    const stop = () => void launcher.requestShutdown();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await launcher.start(parseArguments(process.argv.slice(2)));
  } catch (error) {
    await launcher?.shutdown();
    if (error instanceof LauncherStoppedError) return;
    if (!launcher?.reportedFailure) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
