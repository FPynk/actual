let retryJitter = '';

process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    retryJitter = Array.isArray(message.bankSyncRetryJitterMilliseconds)
      ? message.bankSyncRetryJitterMilliseconds.join(',')
      : '';
    process.send?.({ kind: 'ready' });
    return;
  }
  if (message.kind !== 'request') return;
  if (
    typeof message.request !== 'object' ||
    message.request === null ||
    !('kind' in message.request) ||
    message.request.kind !== 'run-account-bank-sync' ||
    !('accountId' in message.request) ||
    typeof message.request.accountId !== 'string' ||
    retryJitter !== '3,3'
  ) {
    process.exit(2);
    return;
  }
  void runAttempts(message.request.accountId);
});

async function runAttempts(accountId: string): Promise<void> {
  const processId = process.pid;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (process.pid !== processId) process.exit(3);
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.send?.({
    kind: 'result',
    response: {
      kind: 'run-account-bank-sync',
      result: {
        accountId,
        completedAt: '2026-07-31T12:00:01.000Z',
        contractVersion: 1,
        finalSyncCode: 'succeeded',
        outcomeCode: 'succeeded',
        startedAt: '2026-07-31T12:00:00.000Z',
        transactionCounts: null,
      },
    },
  });
  process.send?.({ kind: 'shutdown-complete' });
  process.disconnect();
}
