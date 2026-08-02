import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const actualUrl = 'http://127.0.0.1:5006';
const companionUrl = 'http://127.0.0.1:4100';
const readinessTimeoutMilliseconds = 60_000;
const shutdownGraceMilliseconds = 10_000;

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
  const dataHome =
    platform === 'win32'
      ? environment.LOCALAPPDATA
      : environment.XDG_DATA_HOME ||
        path.join(homeDirectory, '.local', 'share');
  if (!dataHome) throw new Error('LOCALAPPDATA is required on Windows.');
  const actualDataDirectory =
    environment.ACTUAL_DATA_DIR || path.join(dataHome, 'ActualBudgetServer');
  const companionRoot = path.join(dataHome, 'ActualFinanceCompanion');
  return {
    actualDataDirectory,
    companionDataDirectory:
      environment.FINANCE_COMPANION_DATA_DIR ||
      path.join(companionRoot, 'data'),
    actualApiDirectory:
      environment.FINANCE_COMPANION_ACTUAL_API_DIR ||
      path.join(companionRoot, 'actual-api'),
    integrityAnchorPath:
      environment.FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH ||
      path.join(companionRoot, 'anchor', 'integrity-anchor.json'),
  };
}

export function launcherEnvironment(
  environment = process.env,
  paths = persistentPaths(environment),
) {
  return {
    ...environment,
    ACTUAL_DATA_DIR: paths.actualDataDirectory,
    ACTUAL_HOSTNAME: '127.0.0.1',
    ACTUAL_PORT: '5006',
    BROWSER: 'none',
    FINANCE_COMPANION_BIND_ADDRESS: '127.0.0.1',
    FINANCE_COMPANION_PORT: '4100',
    FINANCE_COMPANION_ORIGIN: companionUrl,
    FINANCE_COMPANION_DATA_DIR: paths.companionDataDirectory,
    FINANCE_COMPANION_ACTUAL_API_DIR: paths.actualApiDirectory,
    FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH: paths.integrityAnchorPath,
    PORT: '3001',
    REACT_APP_BACKEND_WORKER_HASH: 'dev',
    ACTUAL_EXTERNAL_LOOT_CORE_WATCHER: '1',
  };
}

function withoutCompanionConfiguration(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.startsWith('FINANCE_COMPANION_'),
    ),
  );
}

export function createServiceCommands() {
  const yarn = [yarnReleasePath()];
  return {
    validateCompanion: [
      yarnExecutable(),
      [
        ...yarn,
        'workspace',
        '@actual-app/finance-companion',
        'exec',
        'node',
        '--experimental-strip-types',
        '../../scripts/validate-finance-companion-config.ts',
      ],
    ],
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
    buildCompanion: [
      yarnExecutable(),
      [...yarn, 'workspace', '@actual-app/finance-companion', 'build'],
    ],
    companion: [process.execPath, ['./dist/service/cli.js', 'start']],
  };
}

export function preflightCompanionConfiguration(environment) {
  if (environment.FINANCE_COMPANION_ACTUAL_SERVER_URL !== actualUrl) {
    throw new Error(
      `FINANCE_COMPANION_ACTUAL_SERVER_URL must be ${actualUrl}.`,
    );
  }
  for (const name of [
    'FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE',
    'FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE',
    'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE',
    'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE',
    'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE',
  ]) {
    const filePath = environment[name];
    if (filePath === undefined) continue;
    try {
      accessSync(filePath, constants.R_OK);
      if (!statSync(filePath).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(
        `Required secret file is missing or unreadable: ${name}.`,
      );
    }
  }
}

export function ensurePersistentPaths(paths) {
  for (const directory of [
    paths.actualDataDirectory,
    paths.companionDataDirectory,
    paths.actualApiDirectory,
    path.dirname(paths.integrityAnchorPath),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
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

export class FinanceLauncher {
  constructor({
    environment = process.env,
    platform = process.platform,
    spawnProcess = spawn,
    fetchImplementation = fetch,
    openBrowser = defaultBrowserOpen,
    output = process.stdout,
    errorOutput = process.stderr,
    ensurePaths = ensurePersistentPaths,
    preflight = preflightCompanionConfiguration,
    onFailure = () => undefined,
    workerExists = existsSync,
    portAvailable = assertPortAvailable,
    readinessTimeout = readinessTimeoutMilliseconds,
    sleep = milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
  } = {}) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.fetchImplementation = fetchImplementation;
    this.openBrowser = openBrowser;
    this.output = output;
    this.errorOutput = errorOutput;
    this.ensurePaths = ensurePaths;
    this.preflight = preflight;
    this.onFailure = onFailure;
    this.workerExists = workerExists;
    this.portAvailable = portAvailable;
    this.readinessTimeout = readinessTimeout;
    this.sleep = sleep;
    this.now = now;
    this.paths = persistentPaths(environment, platform);
    this.environment = launcherEnvironment(environment, this.paths);
    this.nonCompanionEnvironment = withoutCompanionConfiguration(
      this.environment,
    );
    this.commands = createServiceCommands(platform);
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
      this.preflight(this.environment);
      await this.assertPortsAvailable([3001, 4100, 5006]);
      this.throwIfStopping();
      await this.runOnce('configuration', ...this.commands.validateCompanion);
      this.throwIfStopping();
      await this.runOnce('worker-build', ...this.commands.buildWorker);
      this.throwIfStopping();
      await this.runOnce('companion-build', ...this.commands.buildCompanion);
      this.throwIfStopping();
      const workerPath = path.join(
        repositoryRoot,
        'packages',
        'loot-core',
        'lib-dist',
        'browser',
        'kcab.worker.dev.js',
      );
      if (!this.workerExists(workerPath)) {
        throw new Error(
          'The loot-core worker build did not produce kcab.worker.dev.js.',
        );
      }

      for (const [name, command] of [
        ['worker', this.commands.watchWorker],
        ['plugins', this.commands.watchPlugins],
        ['frontend', this.commands.frontend],
        ['actual', this.commands.actual],
        ['companion', this.commands.companion],
      ]) {
        this.throwIfStopping();
        this.startChild(
          name,
          ...command,
          false,
          name === 'companion'
            ? path.join(repositoryRoot, 'packages', 'finance-companion')
            : repositoryRoot,
        );
      }

      await this.waitForReadiness();
      if (!noOpen) {
        await this.openBrowser(actualUrl);
        await this.openBrowser(companionUrl);
      }
      this.output.write(
        `Finance services are ready at ${actualUrl} and ${companionUrl}. Press Ctrl+C to stop.\n`,
      );
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  startChild(
    name,
    executable,
    arguments_,
    allowExit = false,
    cwd = repositoryRoot,
  ) {
    this.throwIfStopping();
    const child = this.spawnProcess(executable, arguments_, {
      cwd,
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
          `${name} exited unexpectedly (${code ?? signal ?? 'unknown'}).`,
        );
        void this.fail(this.failure.message);
      }
    });
    return record;
  }

  childEnvironment(name) {
    if (name === 'configuration' || name === 'companion') {
      return { ...this.environment };
    }
    if (name === 'actual') {
      return {
        ...this.nonCompanionEnvironment,
        ACTUAL_HOSTNAME: '127.0.0.1',
        NODE_ENV: 'development',
      };
    }
    if (name === 'frontend') {
      return { ...this.nonCompanionEnvironment, BROWSER: 'none', PORT: '3001' };
    }
    return { ...this.nonCompanionEnvironment };
  }

  throwIfStopping() {
    if (this.failure) throw this.failure;
    if (this.shutdownRequested || this.shuttingDown) {
      throw new LauncherStoppedError();
    }
  }

  async runOnce(name, executable, arguments_) {
    const record = this.startChild(name, executable, arguments_, true);
    const result = await new Promise((resolve, reject) => {
      record.child.once('error', reject);
      record.child.once('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${name} failed (${code ?? signal ?? 'unknown'}).`));
        }
      });
    });
    this.children = this.children.filter(child => child !== record);
    return result;
  }

  async assertPortsAvailable(ports) {
    for (const port of ports) await this.portAvailable(port);
  }

  async waitForReadiness() {
    await this.waitForUrl(`${actualUrl}/info`, 'Actual server');
    await this.waitForUrl(`${actualUrl}/`, 'Actual frontend');
    await this.waitForUrl(
      `${actualUrl}/kcab/kcab.worker.dev.js`,
      'Actual worker',
    );
    await this.waitForUrl(`${companionUrl}/health`, 'Finance Companion');
  }

  async waitForUrl(url, name) {
    const deadline = this.now() + this.readinessTimeout;
    let lastError = 'not responding';
    while (this.now() < deadline) {
      if (this.shutdownRequested) throw new LauncherStoppedError();
      if (this.failure) throw this.failure;
      try {
        const response = await this.fetchImplementation(url, {
          signal: AbortSignal.any([
            this.readinessAbortController.signal,
            AbortSignal.timeout(2_000),
          ]),
        });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        if (this.shutdownRequested) throw new LauncherStoppedError();
        if (this.failure) throw this.failure;
        lastError = error instanceof Error ? error.message : String(error);
      }
      await this.sleep(250);
    }
    throw new Error(
      `${name} was not ready within ${this.readinessTimeout / 1000} seconds (${lastError}).`,
    );
  }

  async fail(message) {
    if (this.shuttingDown) return;
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
    await this.sleep(shutdownGraceMilliseconds);
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
          `Port ${port} is already in use or unavailable (${error.code ?? error.message}).`,
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
    launcher = new FinanceLauncher({
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
