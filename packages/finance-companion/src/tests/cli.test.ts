import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runFinanceCompanionCommand } from '#cli';
import type { FinanceCompanionConfiguration } from '#config';
import type { FinanceCompanionSecurity } from '#security/local-security';

const commands = [
  'test:db',
  'test:adapter',
  'test:e2e',
  'job:bank-sync',
  'db:migrate',
  'owner:rotate',
  'backup:create',
  'backup:verify',
  'backup:restore',
  'integrity:verify',
  'smoke:container',
] as const;
const scaffoldPackageScriptCommands = commands.filter(
  command => command !== 'test:db' && command !== 'test:adapter',
);
const implementedPackageScriptCommands = ['test:db', 'test:adapter'] as const;

describe('runFinanceCompanionCommand', () => {
  it.each(commands)(
    'writes the exact feature result for %s before configuration access',
    async command => {
      const standardOutput: string[] = [];
      const standardError: string[] = [];
      const loadConfiguration = vi.fn(() => {
        throw new Error('configuration must not be loaded');
      });

      const exitCode = await runFinanceCompanionCommand(
        command,
        message => standardOutput.push(message),
        message => standardError.push(message),
        loadConfiguration,
      );

      expect(exitCode).toBe(78);
      expect(standardOutput.join('')).toBe('');
      expect(standardError.join('')).toBe(
        `${JSON.stringify({ ok: false, code: 'feature_not_implemented', message: 'This command is not implemented yet.', command })}\n`,
      );
      expect(loadConfiguration).not.toHaveBeenCalled();
    },
  );

  it.each(scaffoldPackageScriptCommands)(
    'runs the real %s package script with no extra output',
    command => {
      const result = runPackageScript(command);
      const expected = JSON.stringify({
        ok: false,
        code: 'feature_not_implemented',
        message: 'This command is not implemented yet.',
        command,
      });
      expect(result.status).toBe(78);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${expected}\n`);
    },
  );

  it.each(implementedPackageScriptCommands)(
    'runs the implemented %s package gate',
    command => {
      const result = runPackageScript(command);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Test Files');
      expect(result.stdout).toContain('passed');
      expect(result.stderr).toBe('');
    },
  );

  it('initializes the durable owner repository before starting the server', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-start-'),
    );
    try {
      const dataDirectory = path.join(temporaryDirectory, 'data');
      await mkdir(dataDirectory);
      const integrityMacKeyFile = path.join(
        temporaryDirectory,
        'integrity.key',
      );
      const integrityMacKey = Buffer.alloc(32, 8).toString('base64url');
      if (process.platform !== 'win32') {
        await writeFile(integrityMacKeyFile, Buffer.alloc(32, 8), {
          mode: 0o600,
        });
        await chmod(integrityMacKeyFile, 0o600);
      }
      const credential = Buffer.alloc(32, 9).toString('base64url');
      const configuration: FinanceCompanionConfiguration = {
        bindAddress: '127.0.0.1',
        port: 4100,
        origin: 'http://127.0.0.1:4100',
        dataDirectory,
        databasePath: path.join(dataDirectory, 'companion.sqlite'),
        integrityAnchorPath: path.join(temporaryDirectory, 'integrity.anchor'),
        integrityMacKeyFile:
          process.platform === 'win32' ? undefined : integrityMacKeyFile,
        integrityMacKey:
          process.platform === 'win32' ? integrityMacKey : undefined,
        budgetKeyHash: 'a'.repeat(64),
        budgetCurrencyCode: 'USD',
        ownerBootstrapCredential: credential,
        ownerBootstrapCredentialFile: undefined,
      };
      let startedSecurity: FinanceCompanionSecurity | undefined;

      const exitCode = await runFinanceCompanionCommand(
        'start',
        () => undefined,
        () => undefined,
        () => configuration,
        undefined,
        async (_configuration, _staticUiDirectory, security) => {
          startedSecurity = security;
          return createServer();
        },
      );

      expect(exitCode).toBe(0);
      expect(startedSecurity).toBeDefined();
      expect(await startedSecurity?.login(credential)).not.toBeNull();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

function runPackageScript(command: (typeof commands)[number]) {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
  const yarnRelease = path.join(
    repositoryRoot,
    '.yarn/releases/yarn-4.17.1.cjs',
  );
  return spawnSync(
    process.execPath,
    [yarnRelease, 'workspace', '@actual-app/finance-companion', 'run', command],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        FINANCE_COMPANION_MISSPELLED_SECURITY_SETTING: 'must-not-be-read',
      },
    },
  );
}
