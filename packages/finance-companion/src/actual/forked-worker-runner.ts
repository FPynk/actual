import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  ActualAdapterConfiguration,
  AdapterOperation,
  AdapterWorkerRunner,
} from '#actual/adapter';
import type {
  AdapterWorkerMessage,
  AdapterWorkerStartMessage,
} from '#actual/adapter-worker-protocol';
import { ActualAdapterError } from '#contracts/adapter';

export function createForkedAdapterWorkerRunner(
  configuration: ActualAdapterConfiguration,
  workerEntry = new URL(
    import.meta.url.endsWith('.ts')
      ? './adapter-worker-entry.ts'
      : './adapter-worker-entry.js',
    import.meta.url,
  ),
): AdapterWorkerRunner {
  return (operation, signal) =>
    new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(workerEntry), [], {
        env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
        execArgv: ['--experimental-strip-types'],
        serialization: 'json',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let terminalResponse:
        | Extract<AdapterWorkerMessage, { kind: 'result' | 'problem' }>
        | undefined;
      let didReceiveReady = false;
      let didReceiveShutdown = false;
      let didExit = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let didSettle = false;
      let protocolFailed = false;
      let forcedKillTimeout: NodeJS.Timeout | undefined;
      const abort = () => {
        if (didExit) return;
        if (child.connected) {
          try {
            child.send({ kind: 'terminate' });
          } catch {
            child.kill('SIGKILL');
            return;
          }
        }
        forcedKillTimeout = setTimeout(
          () => child.kill('SIGKILL'),
          Math.floor(configuration.workerExitTimeoutMilliseconds / 2),
        );
      };
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', () => {
        terminalResponse = {
          kind: 'problem',
          code: 'adapter_unhealthy',
        };
      });
      child.on('message', (message: unknown) => {
        if (isOversizedFrame(message) || !isWorkerMessage(message)) {
          failProtocol();
          return;
        }
        if (message.kind === 'ready') {
          if (
            didReceiveReady ||
            terminalResponse !== undefined ||
            didReceiveShutdown
          ) {
            failProtocol();
            return;
          }
          didReceiveReady = true;
          child.send({ kind: 'request', request: operation.request });
          return;
        }
        if (message.kind === 'result' || message.kind === 'problem') {
          if (
            !didReceiveReady ||
            terminalResponse !== undefined ||
            didReceiveShutdown
          ) {
            failProtocol();
            return;
          }
          terminalResponse = message;
          settle();
          return;
        }
        if (message.kind === 'shutdown-complete') {
          if (
            !didReceiveReady ||
            terminalResponse === undefined ||
            didReceiveShutdown
          ) {
            failProtocol();
            return;
          }
          didReceiveShutdown = true;
        }
        settle();
      });
      child.once('exit', (code, exitReason) => {
        didExit = true;
        exitCode = code;
        exitSignal = exitReason;
        settle();
      });
      child.send(startMessage(configuration, operation));
      if (signal.aborted) abort();

      function failProtocol(): void {
        protocolFailed = true;
        terminalResponse = {
          kind: 'problem',
          code: 'adapter_unhealthy',
        };
        child.kill('SIGKILL');
      }

      function settle(): void {
        if (didSettle || !didExit) return;
        didSettle = true;
        signal.removeEventListener('abort', abort);
        if (forcedKillTimeout !== undefined) clearTimeout(forcedKillTimeout);
        if (
          !protocolFailed &&
          terminalResponse?.kind === 'result' &&
          didReceiveReady &&
          didReceiveShutdown &&
          exitCode === 0 &&
          exitSignal === null
        ) {
          resolve(terminalResponse.response);
          return;
        }
        reject(
          terminalResponse?.kind === 'problem'
            ? new ActualAdapterError(terminalResponse.code)
            : new ActualAdapterError('adapter_unhealthy'),
        );
      }
    });
}

function isOversizedFrame(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized === undefined ||
      Buffer.byteLength(serialized, 'utf8') > 16 * 1024 * 1024
    );
  } catch {
    return true;
  }
}

function startMessage(
  configuration: ActualAdapterConfiguration,
  operation: AdapterOperation,
): AdapterWorkerStartMessage {
  return {
    kind: 'start',
    configuration: {
      actualApiDirectory: configuration.actualApiDirectory,
      actualApiDirectoryNonce: configuration.actualApiDirectoryNonce,
      budgetBindingHash: configuration.budgetBindingHash,
      companionInstanceId: configuration.companionInstanceId,
      serviceInstanceNonce: configuration.serviceInstanceNonce,
      actualBudgetCurrency: configuration.actualBudgetCurrency,
      actualBudgetEncryptionPassword:
        configuration.actualBudgetEncryptionPassword,
      actualBudgetId: configuration.actualBudgetId,
      actualPassword: configuration.actualPassword,
      actualServerUrl: configuration.actualServerUrl,
    },
    operationDirectory: operation.operationDirectory,
    operationOwnerMarker: operation.operationOwnerMarker,
    ownershipNonce: operation.ownershipNonce,
    workerOperationId: operation.workerOperationId,
  };
}

function isWorkerMessage(value: unknown): value is AdapterWorkerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === 'ready' || record.kind === 'shutdown-complete') {
    return Object.keys(record).length === 1;
  }
  if (record.kind === 'result') {
    return Object.keys(record).length === 2 && 'response' in record;
  }
  return (
    record.kind === 'problem' &&
    Object.keys(record).length === 2 &&
    ['adapter_unhealthy', 'actual_conflict', 'payload_too_large'].includes(
      record.code as string,
    )
  );
}
