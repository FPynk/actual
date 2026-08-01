import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runFinanceCompanionCommand } from '#cli';
import type { FinanceCompanionConfiguration } from '#config';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import type { FinanceCompanionSecurity } from '#security/local-security';
import { BankSyncJobError } from '#service/bank-sync';

const commands = [
  'test:db',
  'test:adapter',
  'test:e2e',
  'owner:rotate',
] as const;
const scaffoldPackageScriptCommands = ['owner:rotate'] as const;
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
    15_000,
  );

  it('writes the synthetic container smoke result', async () => {
    const standardOutput: string[] = [];
    const standardError: string[] = [];
    const result = {
      checks: ['non-root-volumes'],
      ok: true,
    };

    const exitCode = await runFinanceCompanionCommand(
      'smoke:container',
      message => standardOutput.push(message),
      message => standardError.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => result,
    );

    expect(exitCode).toBe(0);
    expect(standardOutput).toEqual([`${JSON.stringify(result)}\n`]);
    expect(standardError).toEqual([]);
  });

  it('writes one bank-sync summary and its deterministic exit code', async () => {
    const standardOutput: string[] = [];
    const standardError: string[] = [];
    const summary = {
      accountResults: [],
      completedAt: '2026-07-31T12:00:01.000Z',
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'bank-sync' as const,
      retryable: false,
      startedAt: '2026-07-31T12:00:00.000Z',
      status: 'skipped' as const,
    };

    const exitCode = await runFinanceCompanionCommand(
      'job:bank-sync',
      message => standardOutput.push(message),
      message => standardError.push(message),
      undefined,
      undefined,
      undefined,
      ['--scheduler', '--idempotency-key', 'a-valid-idempotency-key'],
      async command_ => {
        expect(command_).toEqual({
          accountIds: null,
          idempotencyKey: 'a-valid-idempotency-key',
          invocationKind: 'scheduler',
        });
        return summary;
      },
    );

    expect(exitCode).toBe(0);
    expect(standardOutput).toEqual([`${JSON.stringify(summary)}\n`]);
    expect(standardError).toEqual([]);
  });

  it('maps an in-progress bank-sync job to unavailable exit 69', async () => {
    const standardError: string[] = [];
    const exitCode = await runFinanceCompanionCommand(
      'job:bank-sync',
      () => undefined,
      message => standardError.push(message),
      undefined,
      undefined,
      undefined,
      ['--idempotency-key', 'a-valid-idempotency-key'],
      async () => {
        throw new BankSyncJobError('operation_in_progress');
      },
    );
    expect(exitCode).toBe(69);
    expect(standardError.join('')).toContain('operation_in_progress');
  });

  it('does not expose an arbitrary bank-sync error code', async () => {
    const standardError: string[] = [];
    const exitCode = await runFinanceCompanionCommand(
      'job:bank-sync',
      () => undefined,
      message => standardError.push(message),
      undefined,
      undefined,
      undefined,
      ['--idempotency-key', 'a-valid-idempotency-key'],
      async () => {
        const error = Object.assign(new Error('synthetic'), {
          code: 'unexpected_error_code',
        });
        throw error;
      },
    );
    expect(exitCode).toBe(64);
    expect(standardError).toEqual([
      '{"code":"configuration_error","ok":false}\n',
    ]);
  });

  it('translates a spawned CLI SIGTERM into a persisted cancellation result', async () => {
    const fixture = path.resolve(
      import.meta.dirname,
      'fixtures/bank-sync-cli-signal.ts',
    );
    const result = await new Promise<
      Readonly<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>
    >(resolve => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', fixture],
        {
          cwd: path.resolve(import.meta.dirname, '../../../..'),
          env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let stdout = '';
      let stderr = '';
      if (child.stdout === null || child.stderr === null) {
        throw new Error('The spawned CLI output pipes are unavailable.');
      }
      child.stdout.setEncoding('utf8').on('data', value => {
        stdout += value;
      });
      child.stderr.setEncoding('utf8').on('data', value => {
        stderr += value;
      });
      child.once('message', () => child.send('SIGTERM'));
      child.once('exit', code => resolve({ code, stderr, stdout }));
    });
    expect(result.code).toBe(130);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'canceled' });
  });

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

  it('runs synthetic backup restore and integrity verification through the CLI', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-lifecycle-cli-'),
    );
    try {
      const dataDirectory = path.join(temporaryDirectory, 'data');
      await mkdir(dataDirectory);
      const backupEncryptionKeyFile = path.join(
        temporaryDirectory,
        'backup.key',
      );
      const backupEncryptionKey = randomBytes(32);
      const integrityMacKey = randomBytes(32);
      await writeFile(backupEncryptionKeyFile, backupEncryptionKey, {
        mode: 0o600,
      });
      const configuration: FinanceCompanionConfiguration = {
        bindAddress: '127.0.0.1',
        port: 4100,
        origin: 'http://127.0.0.1:4100',
        dataDirectory,
        databasePath: path.join(dataDirectory, 'companion.sqlite'),
        integrityAnchorPath: path.join(temporaryDirectory, 'integrity.anchor'),
        integrityMacKeyFile: undefined,
        integrityMacKey: integrityMacKey.toString('base64url'),
        backupEncryptionKeyFile,
        budgetKeyHash: 'a'.repeat(64),
        budgetCurrencyCode: 'USD',
        ownerBootstrapCredential: undefined,
        ownerBootstrapCredentialFile: undefined,
      };
      await initializeCompanionDatabaseAndAnchor({
        databasePath: configuration.databasePath,
        migrationsDirectory: path.resolve(
          import.meta.dirname,
          '../../migrations',
        ),
        anchorPath: configuration.integrityAnchorPath,
        anchorMacKey: integrityMacKey,
        budgetKeyHash: configuration.budgetKeyHash,
        budgetCurrencyCode: configuration.budgetCurrencyCode,
        createOwnerCredentialHash: async () => 'synthetic-owner-hash',
      });
      const backupPath = path.join(temporaryDirectory, 'companion.backup');
      const standardOutput: string[] = [];
      const standardError: string[] = [];

      await expect(
        runFinanceCompanionCommand(
          'backup:create',
          message => standardOutput.push(message),
          message => standardError.push(message),
          () => configuration,
          undefined,
          undefined,
          ['--backup-path', backupPath],
        ),
      ).resolves.toBe(0);
      await writeFile(
        configuration.integrityAnchorPath,
        '{"synthetic":"damaged"}',
      );
      await expect(
        runFinanceCompanionCommand(
          'backup:restore',
          message => standardOutput.push(message),
          message => standardError.push(message),
          () => configuration,
          undefined,
          undefined,
          ['--backup-path', backupPath],
        ),
      ).resolves.toBe(0);
      await expect(
        runFinanceCompanionCommand(
          'integrity:verify',
          message => standardOutput.push(message),
          message => standardError.push(message),
          () => configuration,
        ),
      ).resolves.toBe(0);
      expect(standardError).toEqual([]);
      expect(JSON.parse(standardOutput.at(-1) ?? '')).toEqual({
        ok: true,
        schemaVersion: 7,
        writeCapabilityState: 'disabled',
      });
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
