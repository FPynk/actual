import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFinanceCompanionConfiguration } from './config.ts';
import { startFinanceCompanionHttpServer } from './http/server.ts';

const NOT_IMPLEMENTED_COMMANDS = [
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
type FeatureNotImplementedCommand = (typeof NOT_IMPLEMENTED_COMMANDS)[number];

export type FeatureNotImplementedCommandResult = Readonly<{
  ok: false;
  code: 'feature_not_implemented';
  message: 'This command is not implemented yet.';
  command: FeatureNotImplementedCommand;
}>;

export async function runFinanceCompanionCommand(
  command: string | undefined,
  writeStandardOutput: (message: string) => void,
  writeStandardError: (message: string) => void,
  loadConfiguration = loadFinanceCompanionConfiguration,
): Promise<number> {
  if (isFeatureNotImplementedCommand(command)) {
    const result: FeatureNotImplementedCommandResult = {
      ok: false,
      code: 'feature_not_implemented',
      message: 'This command is not implemented yet.',
      command,
    };
    writeStandardError(`${JSON.stringify(result)}\n`);
    return 78;
  }
  if (command !== 'start') {
    writeStandardError('{"ok":false,"code":"invalid_command"}\n');
    return 64;
  }
  const server = await startFinanceCompanionHttpServer(
    loadConfiguration(),
    path.resolve(import.meta.dirname, '../ui'),
  );
  const closeServer = () =>
    void new Promise<void>(resolve => server.close(() => resolve())).then(() =>
      process.exit(0),
    );
  process.once('SIGINT', closeServer);
  process.once('SIGTERM', closeServer);
  writeStandardOutput('');
  return 0;
}

function isFeatureNotImplementedCommand(
  command: string | undefined,
): command is FeatureNotImplementedCommand {
  return NOT_IMPLEMENTED_COMMANDS.some(candidate => candidate === command);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  void runFinanceCompanionCommand(
    process.argv[2],
    message => process.stdout.write(message),
    message => process.stderr.write(message),
  ).then(exitCode => {
    process.exitCode = exitCode;
  });
}
