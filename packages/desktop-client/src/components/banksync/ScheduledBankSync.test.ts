import type { AccountEntity } from '@actual-app/core/types/models';
import type { BankSyncSchedule } from '@actual-app/core/types/prefs';
import { describe, expect, it } from 'vitest';

import {
  getSchedulableBankSyncAccounts,
  isBankSyncScheduleDue,
  normalizeBankSyncSchedule,
  runWithBankSyncScheduleLock,
} from './ScheduledBankSync';

function makeSchedule(
  schedule: Partial<BankSyncSchedule> = {},
): BankSyncSchedule {
  return {
    enabled: false,
    intervalMinutes: 240,
    accountIds: [],
    ...schedule,
  };
}

function makeAccount(account: Partial<AccountEntity> = {}): AccountEntity {
  return {
    id: 'linked-account',
    name: 'Linked account',
    bank: 'bank',
    account_sync_source: 'simpleFin',
    closed: false,
    tombstone: false,
    ...account,
  } as AccountEntity;
}

describe('ScheduledBankSync', () => {
  it('uses a safe default and ignores unsupported persisted intervals', () => {
    expect(normalizeBankSyncSchedule(undefined)).toEqual(makeSchedule());
    expect(
      normalizeBankSyncSchedule(makeSchedule({ intervalMinutes: 13 })),
    ).toMatchObject({ intervalMinutes: 240 });
  });

  it('only offers open linked bank-sync accounts', () => {
    expect(
      getSchedulableBankSyncAccounts([
        makeAccount(),
        makeAccount({ id: 'closed', closed: 1 }),
        makeAccount({ id: 'unlinked', bank: null, account_sync_source: null }),
        makeAccount({ id: 'deleted', tombstone: 1 }),
      ]).map(account => account.id),
    ).toEqual(['linked-account']);
  });

  it('runs a newly enabled schedule and waits for its configured interval', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z');
    const schedule = makeSchedule({
      enabled: true,
      lastResult: {
        completedAt: '2026-08-02T08:00:00.000Z',
        outcome: 'completed',
      },
    });

    expect(isBankSyncScheduleDue(makeSchedule({ enabled: true }), now)).toBe(
      true,
    );
    expect(isBankSyncScheduleDue(schedule, now - 1)).toBe(false);
    expect(isBankSyncScheduleDue(schedule, now)).toBe(true);
  });

  it('does not allow overlapping scheduled runs', async () => {
    let releaseFirstRun: (() => void) | undefined;
    const firstRun = runWithBankSyncScheduleLock(
      () =>
        new Promise<void>(resolve => {
          releaseFirstRun = resolve;
        }),
    );

    await expect(
      runWithBankSyncScheduleLock(async () => 'second'),
    ).resolves.toBeUndefined();
    releaseFirstRun?.();
    await firstRun;
    await expect(
      runWithBankSyncScheduleLock(async () => 'third'),
    ).resolves.toBe('third');
  });
});
