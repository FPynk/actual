import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFinanceCompanionConfiguration } from './config.ts';
import { openCompanionDatabase } from './database/connection.ts';
import { createSqliteSourceIdentityRepository } from './database/source-identity-repository.ts';
import { startFinanceCompanionHttpServer } from './http/server.ts';
import { SqliteReconciliationCandidateRepository } from './reconciliation/sqlite-reconciliation-candidate-repository.ts';
import { createFinanceCompanionSecurity } from './security/local-security.ts';
import type { LocalPrincipalRepository } from './security/local-security.ts';
import {
  createConfiguredActualAdapter,
  runConfiguredBankSyncJob,
} from './service/bank-sync-cli.ts';
import {
  bankSyncExitCode,
  BankSyncJobError,
  parseBankSyncCommandArguments,
} from './service/bank-sync.ts';
import type {
  BankSyncJobSummary,
  ParsedBankSyncCommand,
} from './service/bank-sync.ts';
import { createDurableLocalPrincipalRepository } from './service/durable-principal-repository.ts';
import { createSqliteRequestReplayRepository } from './service/request-replay-repository.ts';

const NOT_IMPLEMENTED_COMMANDS = [
  'test:db',
  'test:adapter',
  'test:e2e',
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
  loadLocalPrincipalRepository: (
    configuration: ReturnType<typeof loadFinanceCompanionConfiguration>,
  ) => Promise<LocalPrincipalRepository> = configuration =>
    createDurableLocalPrincipalRepository(
      configuration,
      path.resolve(import.meta.dirname, '../migrations'),
    ),
  startHttpServer = startFinanceCompanionHttpServer,
  commandArguments: readonly string[] = [],
  runBankSync?: (
    command_: ParsedBankSyncCommand,
    signal: AbortSignal,
  ) => Promise<BankSyncJobSummary>,
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
  if (command === 'job:bank-sync') {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const parsedCommand = parseBankSyncCommandArguments(commandArguments);
      let summary: BankSyncJobSummary;
      if (runBankSync === undefined) {
        const configuration = loadConfiguration();
        summary = await runConfiguredBankSyncJob(
          configuration,
          await loadLocalPrincipalRepository(configuration),
          parsedCommand,
          cancellation.signal,
        );
      } else {
        summary = await runBankSync(parsedCommand, cancellation.signal);
      }
      writeStandardOutput(`${JSON.stringify(summary)}\n`);
      return bankSyncExitCode(summary);
    } catch (error) {
      const code =
        error instanceof BankSyncJobError ? error.code : 'configuration_error';
      writeStandardError(`${JSON.stringify({ code, ok: false })}\n`);
      return code === 'adapter_unavailable' || code === 'operation_in_progress'
        ? 69
        : 64;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
  if (command !== 'start') {
    writeStandardError('{"ok":false,"code":"invalid_command"}\n');
    return 64;
  }
  const configuration = loadConfiguration();
  const security = await createFinanceCompanionSecurity({
    bootstrapCredential: configuration.ownerBootstrapCredential,
    bootstrapCredentialFile: configuration.ownerBootstrapCredentialFile,
    localPrincipalRepository: await loadLocalPrincipalRepository(configuration),
  });
  const reviewDatabase =
    startHttpServer === startFinanceCompanionHttpServer
      ? openCompanionDatabase(configuration.databasePath, true)
      : undefined;
  const server = await startHttpServer(
    configuration,
    path.resolve(import.meta.dirname, '../ui'),
    security,
    createSqliteRequestReplayRepository(configuration.databasePath),
    reviewDatabase === undefined
      ? undefined
      : {
          adapter: await createConfiguredActualAdapter(configuration),
          candidateRepository: new SqliteReconciliationCandidateRepository(
            reviewDatabase,
          ),
          sourceIdentityRepository: createSqliteSourceIdentityRepository(
            configuration.databasePath,
          ),
        },
  );
  const closeServer = () =>
    void new Promise<void>(resolve => server.close(() => resolve())).then(
      () => {
        reviewDatabase?.close();
        process.exit(0);
      },
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
    undefined,
    undefined,
    undefined,
    process.argv.slice(3),
  ).then(exitCode => {
    process.exitCode = exitCode;
  });
}
