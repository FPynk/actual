const forbiddenSecrets = ['runner-secret', 'runner-encryption-secret'];

process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    const processMetadata = [
      ...process.argv,
      ...process.execArgv,
      ...Object.values(process.env),
    ];
    if (
      forbiddenSecrets.some(secret =>
        processMetadata.some(value => value?.includes(secret)),
      )
    ) {
      process.exit(2);
    }
    process.send?.({ kind: 'ready' });
    return;
  }
  if (message.kind === 'request') {
    process.send?.({
      kind: 'result',
      response: { kind: 'read-budget-snapshot' },
    });
    process.send?.({ kind: 'shutdown-complete' });
    process.disconnect();
  }
});
