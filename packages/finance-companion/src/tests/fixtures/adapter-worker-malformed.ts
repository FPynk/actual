process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    process.send?.({ kind: 'unknown-worker-message' });
  }
});
