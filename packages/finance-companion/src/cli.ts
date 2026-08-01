import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFinanceCompanionConfiguration } from './config.ts';
import { runDatabaseLifecycleCommand } from './database/lifecycle-cli.ts';
import type {
  FinanceCompanionSecurity,
  LocalPrincipalRepository,
} from './security/local-security.ts';
import type {
  BankSyncJobError,
  BankSyncJobSummary,
  ParsedBankSyncCommand,
} from './service/bank-sync.ts';

const NOT_IMPLEMENTED_COMMANDS = [
  'test:db',
  'test:adapter',
  'test:e2e',
  'owner:rotate',
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
  loadLocalPrincipalRepository?: (
    configuration: ReturnType<typeof loadFinanceCompanionConfiguration>,
  ) => Promise<LocalPrincipalRepository>,
  startHttpServer?: (
    configuration: ReturnType<typeof loadFinanceCompanionConfiguration>,
    staticUiDirectory: string,
    security: FinanceCompanionSecurity,
    requestReplayRepository: unknown,
    reviewDependencies?: unknown,
  ) => Promise<Readonly<{ close: (callback: () => void) => void }>>,
  commandArguments: readonly string[] = [],
  runBankSync?: (
    command_: ParsedBankSyncCommand,
    signal: AbortSignal,
  ) => Promise<BankSyncJobSummary>,
  runContainerSmoke?: () => Promise<Readonly<Record<string, unknown>>>,
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
    let BankSyncJobErrorConstructor: typeof BankSyncJobError | undefined;
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const bankSync = await import('./service/bank-sync.ts');
      BankSyncJobErrorConstructor = bankSync.BankSyncJobError;
      const { bankSyncExitCode, parseBankSyncCommandArguments } = bankSync;
      const parsedCommand = parseBankSyncCommandArguments(commandArguments);
      let summary: BankSyncJobSummary;
      if (runBankSync === undefined) {
        const configuration = loadConfiguration();
        const { createDurableLocalPrincipalRepository } =
          await import('./service/durable-principal-repository.ts');
        const { runConfiguredBankSyncJob } =
          await import('./service/bank-sync-cli.ts');
        summary = await runConfiguredBankSyncJob(
          configuration,
          await (
            loadLocalPrincipalRepository ??
            (value =>
              createDurableLocalPrincipalRepository(
                value,
                path.resolve(import.meta.dirname, '../migrations'),
              ))
          )(configuration),
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
        BankSyncJobErrorConstructor !== undefined &&
        error instanceof BankSyncJobErrorConstructor
          ? error.code
          : 'configuration_error';
      writeStandardError(`${JSON.stringify({ code, ok: false })}\n`);
      return code === 'adapter_unavailable' || code === 'operation_in_progress'
        ? 69
        : 64;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
  if (command === 'smoke:container') {
    try {
      const result = await (
        runContainerSmoke ??
        (async () => {
          const { runContainerReadinessSmoke } =
            await import('./container/readiness-smoke.ts');
          return runContainerReadinessSmoke();
        })
      )();
      writeStandardOutput(`${JSON.stringify(result)}\n`);
      return 0;
    } catch {
      writeStandardError('{"ok":false,"code":"container_smoke_failed"}\n');
      return 70;
    }
  }
  if (
    command === 'db:migrate' ||
    command === 'backup:create' ||
    command === 'backup:verify' ||
    command === 'backup:restore' ||
    command === 'integrity:verify'
  ) {
    try {
      const result = await runDatabaseLifecycleCommand(
        command,
        loadConfiguration(),
        commandArguments,
      );
      writeStandardOutput(`${JSON.stringify(result)}\n`);
      return 0;
    } catch {
      writeStandardError('{"ok":false,"code":"database_lifecycle_failed"}\n');
      return 65;
    }
  }
  if (command !== 'start') {
    writeStandardError('{"ok":false,"code":"invalid_command"}\n');
    return 64;
  }
  const configuration = loadConfiguration();
  const { createFinanceCompanionSecurity } =
    await import('./security/local-security.ts');
  const { createDurableLocalPrincipalRepository } =
    await import('./service/durable-principal-repository.ts');
  const { startFinanceCompanionHttpServer } = await import('./http/server.ts');
  const { openCompanionDatabase } = await import('./database/connection.ts');
  const { createSqliteRequestReplayRepository } =
    await import('./service/request-replay-repository.ts');
  const { createSqliteSourceIdentityRepository } =
    await import('./database/source-identity-repository.ts');
  const { SqliteReconciliationCandidateRepository } =
    await import('./reconciliation/sqlite-reconciliation-candidate-repository.ts');
  const { SqliteClassificationProposalRepository } =
    await import('./reviews/sqlite-classification-repository.ts');
  const { SqliteSubscriptionCandidateRepository } =
    await import('./subscriptions/sqlite-subscription-candidate-repository.ts');
  const { createConfiguredActualAdapter } =
    await import('./service/bank-sync-cli.ts');
  const getLocalPrincipalRepository =
    loadLocalPrincipalRepository ??
    (value =>
      createDurableLocalPrincipalRepository(
        value,
        path.resolve(import.meta.dirname, '../migrations'),
      ));
  const security = await createFinanceCompanionSecurity({
    bootstrapCredential: configuration.ownerBootstrapCredential,
    bootstrapCredentialFile: configuration.ownerBootstrapCredentialFile,
    localPrincipalRepository: await getLocalPrincipalRepository(configuration),
  });
  const reviewDatabase =
    startHttpServer === undefined
      ? openCompanionDatabase(configuration.databasePath, true)
      : undefined;
  const server = await (startHttpServer ?? startFinanceCompanionHttpServer)(
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
          classificationRepository: new SqliteClassificationProposalRepository(
            reviewDatabase,
          ),
          subscriptionRepository: new SqliteSubscriptionCandidateRepository(
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
