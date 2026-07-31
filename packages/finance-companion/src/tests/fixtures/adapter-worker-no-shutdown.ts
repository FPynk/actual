process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') process.send?.({ kind: 'ready' });
  if (message.kind === 'request') {
    process.send?.({
      kind: 'result',
      response: { kind: 'read-budget-snapshot', snapshot: {} },
    });
    process.disconnect();
  }
});
