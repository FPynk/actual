process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') process.send?.({ kind: 'ready' });
  if (message.kind === 'request') setInterval(() => undefined, 1000);
});
