process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    process.send?.({ kind: 'ready' });
    return;
  }
  if (message.kind === 'request') {
    process.send?.({ kind: 'shutdown-complete' });
    process.send?.({
      kind: 'result',
      response: { kind: 'read-budget-snapshot' },
    });
    process.disconnect();
  }
});
