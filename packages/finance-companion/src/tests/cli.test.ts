import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { runFinanceCompanionCommand } from '#cli';

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

  it.each(commands)(
    'runs the real %s package script with no extra output',
    command => {
      const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
      const yarnRelease = path.join(
        repositoryRoot,
        '.yarn/releases/yarn-4.17.1.cjs',
      );
      const result = spawnSync(
        process.execPath,
        [
          yarnRelease,
          'workspace',
          '@actual-app/finance-companion',
          'run',
          command,
        ],
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
});
