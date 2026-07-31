process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    process.send?.({ kind: 'ready' });
    return;
  }
  if (message.kind === 'request') {
    process.send?.({
      kind: 'result',
      response: {
        kind: 'read-budget-snapshot',
        oversized: 'x'.repeat(16 * 1024 * 1024),
      },
    });
  }
});
