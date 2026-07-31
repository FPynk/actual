process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    if (
      process.argv.some(value => value.includes('runner-secret')) ||
      Object.values(process.env).some(value => value?.includes('runner-secret'))
    ) {
      process.exit(2);
    }
    process.send?.({ kind: 'ready' });
    return;
  }
  if (message.kind === 'request') {
    for (let index = 0; index < 1024; index += 1) {
      process.stdout.write('discarded worker output');
      process.stderr.write('discarded worker error');
    }
    process.send?.({
      kind: 'result',
      response: {
        kind: 'read-budget-snapshot',
        snapshot: {
          budget: {
            budgetKeyHash: 'binding-from-fixture',
            capturedAt: '2026-07-31T12:00:00.000Z',
            currencyCode: 'USD',
          },
          contractVersion: 1,
        },
      },
    });
    process.send?.({ kind: 'shutdown-complete' });
    process.disconnect();
  }
});
