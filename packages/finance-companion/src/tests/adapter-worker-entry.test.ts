import { runAccountBankSync } from '#actual/adapter-worker-entry';

vi.mock('@actual-app/api', () => ({}));

describe('Actual adapter bank-sync worker', () => {
  it('returns canceled when cancellation interrupts the retry delay', async () => {
    vi.useFakeTimers();
    const retryTimer = vi.spyOn(globalThis, 'setTimeout');
    const runBankSync = vi.fn(async () => {
      throw new Error('retryable provider failure');
    });
    const readAccountRows = vi.fn(async () => [
      { bank_sync_status: 'rate-limit-exceeded', id: 'account-1' },
    ]);
    const sync = vi.fn(async () => undefined);
    const cancellation = new AbortController();

    try {
      const completion = runAccountBankSync(
        'account-1',
        [0, 0],
        cancellation.signal,
        { readAccountRows, runBankSync, sync },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(retryTimer).toHaveBeenCalledWith(expect.any(Function), 1_000);

      cancellation.abort();

      await expect(completion).resolves.toMatchObject({
        accountId: 'account-1',
        finalSyncCode: 'not-attempted',
        outcomeCode: 'canceled',
      });
      expect(runBankSync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(1);
    } finally {
      retryTimer.mockRestore();
      vi.useRealTimers();
    }
  });
});
