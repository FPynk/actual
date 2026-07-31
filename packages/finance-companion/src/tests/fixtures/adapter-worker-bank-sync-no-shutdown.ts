let budgetBindingHash = '';

process.on('message', (message: Record<string, unknown>) => {
  if (message.kind === 'start') {
    if (
      typeof message.configuration !== 'object' ||
      message.configuration === null ||
      !('budgetBindingHash' in message.configuration) ||
      typeof message.configuration.budgetBindingHash !== 'string'
    ) {
      process.exit(2);
      return;
    }
    budgetBindingHash = message.configuration.budgetBindingHash;
    process.send?.({ kind: 'ready' });
    return;
  }
  if (
    message.kind !== 'request' ||
    typeof message.request !== 'object' ||
    message.request === null ||
    !('kind' in message.request)
  ) {
    return;
  }
  if (message.request.kind === 'read-budget-snapshot') {
    process.send?.({
      kind: 'result',
      response: {
        kind: 'read-budget-snapshot',
        snapshot: {
          accounts: [
            {
              closed: false,
              id: 'account-1',
              lastSync: null,
              name: 'Account 1',
              offBudget: false,
              syncSource: 'simpleFin',
              syncStatus: null,
            },
          ],
          budget: {
            budgetKeyHash: budgetBindingHash,
            capturedAt: '2026-07-31T12:00:00.000Z',
            currencyCode: 'USD',
          },
          contractVersion: 1,
        },
      },
    });
    process.send?.({ kind: 'shutdown-complete' });
    process.disconnect();
    return;
  }
  if (
    message.request.kind !== 'run-account-bank-sync' ||
    !('accountId' in message.request) ||
    typeof message.request.accountId !== 'string'
  ) {
    process.exit(3);
    return;
  }
  process.send?.({
    kind: 'result',
    response: {
      kind: 'run-account-bank-sync',
      result: {
        accountId: message.request.accountId,
        completedAt: '2026-07-31T12:00:01.000Z',
        contractVersion: 1,
        finalSyncCode: 'not-attempted',
        outcomeCode: 'canceled',
        startedAt: '2026-07-31T12:00:00.000Z',
        transactionCounts: null,
      },
    },
  });
  process.disconnect();
});
