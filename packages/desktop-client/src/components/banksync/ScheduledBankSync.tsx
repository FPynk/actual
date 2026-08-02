import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { AccountEntity } from '@actual-app/core/types/models';
import type { BankSyncSchedule } from '@actual-app/core/types/prefs';

import { useSyncAndDownloadMutation } from '#accounts';
import { LabeledCheckbox } from '#components/forms/LabeledCheckbox';
import { useAccounts } from '#hooks/useAccounts';
import { useLocalPref } from '#hooks/useLocalPref';
import { useSelector } from '#redux';

const defaultBankSyncSchedule: BankSyncSchedule = {
  enabled: false,
  intervalMinutes: 240,
  accountIds: [],
};

const intervalOptions: Array<readonly [number, string]> = [
  [60, 'Every hour'],
  [240, 'Every 4 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Daily'],
] as const;

let isScheduledBankSyncRunning = false;

export function getSchedulableBankSyncAccounts(accounts: AccountEntity[]) {
  return accounts.filter(
    account =>
      account.bank &&
      account.account_sync_source &&
      !account.closed &&
      !account.tombstone,
  );
}

export function normalizeBankSyncSchedule(
  schedule: BankSyncSchedule | undefined,
): BankSyncSchedule {
  const intervalMinutes = schedule?.intervalMinutes;
  const supportsInterval = intervalOptions.some(
    ([optionInterval]) => optionInterval === intervalMinutes,
  );

  return {
    enabled: schedule?.enabled ?? defaultBankSyncSchedule.enabled,
    intervalMinutes: supportsInterval
      ? intervalMinutes
      : defaultBankSyncSchedule.intervalMinutes,
    accountIds: schedule?.accountIds ?? defaultBankSyncSchedule.accountIds,
    lastResult: schedule?.lastResult,
  };
}

export function isBankSyncScheduleDue(schedule: BankSyncSchedule, now: number) {
  if (!schedule.lastResult) {
    return true;
  }

  const completedAt = Date.parse(schedule.lastResult.completedAt);
  return (
    Number.isNaN(completedAt) ||
    now - completedAt >= schedule.intervalMinutes * 60 * 1000
  );
}

function getSelectedBankSyncAccountIds(
  schedule: BankSyncSchedule,
  accounts: AccountEntity[],
) {
  const schedulableAccounts = getSchedulableBankSyncAccounts(accounts);
  const selectedAccountIds = new Set(
    !schedule.enabled && schedule.accountIds.length === 0
      ? schedulableAccounts.map(account => account.id)
      : schedule.accountIds,
  );

  return schedulableAccounts
    .filter(account => selectedAccountIds.has(account.id))
    .map(account => account.id);
}

export async function runWithBankSyncScheduleLock<T>(run: () => Promise<T>) {
  if (isScheduledBankSyncRunning) {
    return undefined;
  }

  isScheduledBankSyncRunning = true;
  try {
    return await run();
  } finally {
    isScheduledBankSyncRunning = false;
  }
}

function useBankSyncSchedule() {
  const [storedSchedule, setStoredSchedule] = useLocalPref('bankSyncSchedule');
  const schedule = normalizeBankSyncSchedule(storedSchedule);

  return { schedule, setStoredSchedule };
}

function useRunScheduledBankSync({
  startScheduler = false,
}: {
  startScheduler?: boolean;
} = {}) {
  const { data: accounts = [] } = useAccounts();
  const accountsSyncing = useSelector(state => state.account.accountsSyncing);
  const { mutateAsync: syncAndDownload } = useSyncAndDownloadMutation();
  const { schedule, setStoredSchedule } = useBankSyncSchedule();
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;

  const runNow = useCallback(async () => {
    const accountIds = getSelectedBankSyncAccountIds(
      scheduleRef.current,
      accounts,
    );

    if (accountIds.length === 0 || accountsSyncing.length > 0) {
      return;
    }

    await runWithBankSyncScheduleLock(async () => {
      try {
        for (const id of accountIds) {
          await syncAndDownload({ id });
        }
        setStoredSchedule({
          ...scheduleRef.current,
          lastResult: {
            completedAt: new Date().toISOString(),
            outcome: 'completed',
          },
        });
      } catch {
        setStoredSchedule({
          ...scheduleRef.current,
          lastResult: {
            completedAt: new Date().toISOString(),
            outcome: 'failed',
          },
        });
      }
    });
  }, [accounts, accountsSyncing.length, setStoredSchedule, syncAndDownload]);

  useEffect(() => {
    if (!startScheduler || !schedule.enabled) {
      return;
    }

    const maybeRun = () => {
      if (isBankSyncScheduleDue(scheduleRef.current, Date.now())) {
        void runNow();
      }
    };

    maybeRun();
    const interval = window.setInterval(
      maybeRun,
      schedule.intervalMinutes * 60 * 1000,
    );
    return () => window.clearInterval(interval);
  }, [runNow, schedule.enabled, schedule.intervalMinutes, startScheduler]);

  return { runNow, isSyncing: accountsSyncing.length > 0 };
}

export function ScheduledBankSyncRunner() {
  useRunScheduledBankSync({ startScheduler: true });
  return null;
}

function ScheduleSetting({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        padding: 16,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}

export function ScheduledBankSyncSettings() {
  const { t } = useTranslation();
  const { data: accounts = [] } = useAccounts();
  const { schedule, setStoredSchedule } = useBankSyncSchedule();
  const { runNow, isSyncing } = useRunScheduledBankSync();
  const schedulableAccounts = getSchedulableBankSyncAccounts(accounts);
  const selectedAccountIds = new Set(
    getSelectedBankSyncAccountIds(schedule, accounts),
  );

  function updateSchedule(update: Partial<BankSyncSchedule>) {
    setStoredSchedule({ ...schedule, ...update });
  }

  function toggleSchedule(enabled: boolean) {
    updateSchedule({
      enabled,
      accountIds:
        enabled && schedule.accountIds.length === 0
          ? schedulableAccounts.map(account => account.id)
          : schedule.accountIds,
    });
  }

  function toggleAccount(accountId: string, checked: boolean) {
    const accountIds = new Set(schedule.accountIds);
    if (checked) {
      accountIds.add(accountId);
    } else {
      accountIds.delete(accountId);
    }
    updateSchedule({ accountIds: [...accountIds] });
  }

  const lastResult = schedule.lastResult
    ? `${schedule.lastResult.outcome === 'completed' ? t('Completed') : t('Failed')} ${new Date(schedule.lastResult.completedAt).toLocaleString()}`
    : t('Not run yet');

  return (
    <ScheduleSetting>
      <View style={{ gap: 4 }}>
        <Text style={{ fontWeight: 600 }}>
          <Trans>Scheduled bank sync</Trans>
        </Text>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Runs only while this copy of Actual is open. It does not create a
            background server job.
          </Trans>
        </Text>
      </View>

      <LabeledCheckbox
        id="bank-sync-schedule-enabled"
        checked={schedule.enabled}
        disabled={schedulableAccounts.length === 0}
        onChange={event => toggleSchedule(event.currentTarget.checked)}
      >
        <Trans>Enable scheduled sync</Trans>
      </LabeledCheckbox>

      {schedulableAccounts.length > 0 && (
        <>
          <View style={{ gap: 6 }}>
            <Text>
              <Trans>Interval</Trans>
            </Text>
            <Select<number>
              value={schedule.intervalMinutes}
              onChange={intervalMinutes => updateSchedule({ intervalMinutes })}
              options={intervalOptions}
              disabled={!schedule.enabled}
              style={{ width: 180 }}
            />
          </View>

          <View style={{ gap: 2 }}>
            <Text>
              <Trans>Accounts</Trans>
            </Text>
            {schedulableAccounts.map(account => (
              <LabeledCheckbox
                key={account.id}
                id={`bank-sync-schedule-${account.id}`}
                checked={selectedAccountIds.has(account.id)}
                disabled={!schedule.enabled}
                onChange={event =>
                  toggleAccount(account.id, event.currentTarget.checked)
                }
              >
                {account.name}
              </LabeledCheckbox>
            ))}
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Button
              variant="primary"
              isDisabled={isSyncing || selectedAccountIds.size === 0}
              onPress={() => void runNow()}
            >
              <Trans>Sync now</Trans>
            </Button>
            <Text style={{ color: theme.pageTextSubdued }}>
              {t('Last attempt: {{lastResult}}', { lastResult })}
            </Text>
          </View>
        </>
      )}

      {schedulableAccounts.length === 0 && (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>Link a bank account before creating a schedule.</Trans>
        </Text>
      )}
    </ScheduleSetting>
  );
}
