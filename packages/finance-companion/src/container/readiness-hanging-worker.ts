process.on('message', message => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'start'
  ) {
    process.send?.({ kind: 'ready' });
  }
});
