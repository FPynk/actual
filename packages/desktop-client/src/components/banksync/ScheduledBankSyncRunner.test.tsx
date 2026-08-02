import type { AccountEntity } from '@actual-app/core/types/models';
import type { BankSyncSchedule } from '@actual-app/core/types/prefs';
import { render, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import { ScheduledBankSyncRunner } from './ScheduledBankSync';

const schedulerTestState = vi.hoisted(() => ({
  accounts: [] as AccountEntity[],
  accountsSyncing: [] as string[],
  schedule: undefined as BankSyncSchedule | undefined,
  setStoredSchedule: vi.fn(),
  syncAndDownload: vi.fn(),
}));

vi.mock('#accounts', () => ({
  useSyncAndDownloadMutation: () => ({
    mutateAsync: schedulerTestState.syncAndDownload,
  }),
}));

vi.mock('#hooks/useAccounts', () => ({
  useAccounts: () => ({ data: schedulerTestState.accounts }),
}));

vi.mock('#hooks/useLocalPref', () => ({
  useLocalPref: () => [
    schedulerTestState.schedule,
    schedulerTestState.setStoredSchedule,
  ],
}));

vi.mock('#redux', () => ({
  useSelector: <T,>(
    select: (state: { account: { accountsSyncing: string[] } }) => T,
  ) =>
    select({
      account: { accountsSyncing: schedulerTestState.accountsSyncing },
    }),
}));

function makeSchedule(
  schedule: Partial<BankSyncSchedule> = {},
): BankSyncSchedule {
  return {
    enabled: true,
    intervalMinutes: 60,
    accountIds: ['selected'],
    ...schedule,
  };
}

function makeAccount(account: Partial<AccountEntity> = {}): AccountEntity {
  return {
    id: 'selected',
    name: 'Selected linked account',
    bank: 'bank',
    account_sync_source: 'simpleFin',
    closed: false,
    tombstone: false,
    ...account,
  } as AccountEntity;
}

describe('ScheduledBankSyncRunner', () => {
  beforeEach(() => {
    schedulerTestState.accounts = [makeAccount()];
    schedulerTestState.accountsSyncing = [];
    schedulerTestState.schedule = makeSchedule();
    schedulerTestState.setStoredSchedule.mockReset();
    schedulerTestState.syncAndDownload = vi.fn().mockResolvedValue(undefined);
  });

  it('syncs only selected eligible linked accounts and records completion', async () => {
    schedulerTestState.accounts = [
      makeAccount(),
      makeAccount({ id: 'unselected' }),
      makeAccount({ id: 'closed', closed: true }),
      makeAccount({ id: 'unlinked', bank: null, account_sync_source: null }),
    ];

    const { unmount } = render(<ScheduledBankSyncRunner />);

    await waitFor(() => {
      expect(schedulerTestState.syncAndDownload).toHaveBeenCalledWith({
        id: 'selected',
      });
      expect(schedulerTestState.setStoredSchedule).toHaveBeenCalledWith({
        ...schedulerTestState.schedule,
        lastResult: {
          completedAt: expect.any(String),
          outcome: 'completed',
        },
      });
    });

    expect(schedulerTestState.syncAndDownload).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not sync while the schedule is disabled', () => {
    schedulerTestState.schedule = makeSchedule({ enabled: false });

    const { unmount } = render(<ScheduledBankSyncRunner />);

    expect(schedulerTestState.syncAndDownload).not.toHaveBeenCalled();
    expect(schedulerTestState.setStoredSchedule).not.toHaveBeenCalled();
    unmount();
  });

  it('records failures and prevents overlapping runner executions', async () => {
    let rejectSync: (error: Error) => void = () => {};
    schedulerTestState.syncAndDownload = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSync = reject;
        }),
    );

    const { unmount } = render(
      <>
        <ScheduledBankSyncRunner />
        <ScheduledBankSyncRunner />
      </>,
    );

    expect(schedulerTestState.syncAndDownload).toHaveBeenCalledTimes(1);
    rejectSync(new Error('synthetic sync failure'));

    await waitFor(() => {
      expect(schedulerTestState.setStoredSchedule).toHaveBeenCalledWith({
        ...schedulerTestState.schedule,
        lastResult: {
          completedAt: expect.any(String),
          outcome: 'failed',
        },
      });
    });

    unmount();
  });
});
