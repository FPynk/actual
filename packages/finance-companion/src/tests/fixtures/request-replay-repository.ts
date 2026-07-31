import { randomUUID } from 'node:crypto';

import type {
  RequestReplayRepository,
  RequestReplayResponse,
  RequestReplayScope,
} from '#service/request-replay-repository';

type TestReplay = Readonly<{
  replayId: string;
  scope: RequestReplayScope;
  response?: RequestReplayResponse;
}>;

export function createTestRequestReplayRepository(): RequestReplayRepository {
  const replays = new Map<string, TestReplay>();
  return {
    begin: scope => {
      const existing = replays.get(scope.idempotencyKey);
      if (existing === undefined) {
        const replayId = randomUUID();
        replays.set(scope.idempotencyKey, { replayId, scope });
        return { kind: 'execute', replayId, attempt: 1 };
      }
      if (
        existing.scope.budgetKeyHash !== scope.budgetKeyHash ||
        existing.scope.principalId !== scope.principalId ||
        existing.scope.invocationKind !== scope.invocationKind ||
        existing.scope.operationId !== scope.operationId ||
        existing.scope.requestHash !== scope.requestHash
      ) {
        return { kind: 'conflict' };
      }
      return existing.response === undefined
        ? { kind: 'in_progress' }
        : { kind: 'replay', response: existing.response };
    },
    complete: (replayId, response) => {
      const existing = [...replays.values()].find(
        replay => replay.replayId === replayId,
      );
      if (existing === undefined) {
        throw new Error('The test replay is missing.');
      }
      replays.set(existing.scope.idempotencyKey, { ...existing, response });
    },
    fail: () => undefined,
    recoverCompanionOnlyInterruptedRequests: () => ({
      recoveredCompanionOnlyCount: 0,
    }),
    purgeExpiredTerminalRows: () => 0,
  };
}
