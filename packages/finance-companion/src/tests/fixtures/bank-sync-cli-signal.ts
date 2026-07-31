import { runFinanceCompanionCommand } from '#cli';

process.on('message', message => {
  if (message === 'SIGTERM') process.emit('SIGTERM');
});

void runFinanceCompanionCommand(
  'job:bank-sync',
  message => process.stdout.write(message),
  message => process.stderr.write(message),
  undefined,
  undefined,
  undefined,
  ['--idempotency-key', 'signal-test-key-1234'],
  async (_command, signal) => {
    process.send?.('ready');
    if (!signal.aborted) {
      await new Promise<void>(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    }
    const completedAt = new Date().toISOString();
    return {
      accountResults: [
        {
          accountId: 'synthetic-account',
          outcomeCode: 'canceled',
          transactionCounts: null,
        },
      ],
      completedAt,
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'bank-sync',
      retryable: true,
      startedAt: completedAt,
      status: 'canceled',
    };
  },
).then(exitCode => {
  process.exitCode = exitCode;
  process.disconnect();
});
