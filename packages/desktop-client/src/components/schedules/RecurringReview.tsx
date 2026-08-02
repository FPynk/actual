import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { detectRecurringPayments } from '@actual-app/core/shared/finance/recurring-detector';
import type {
  RecurringPaymentCandidate,
  RecurringPaymentReason,
  RecurringPaymentSchedule,
  RecurringPaymentTransaction,
  RecurringPaymentType,
} from '@actual-app/core/shared/finance/recurring-detector';
import { q } from '@actual-app/core/shared/query';
import type { FinanceReviewDecisionRecord } from '@actual-app/core/types/finance';
import type {
  ScheduleEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import type { TFunction } from 'i18next';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';
import { usePayeesById } from '#hooks/usePayees';
import { aqlQuery } from '#queries/aqlQuery';

type RecurringReviewDecision = 'deferred' | 'rejected' | 'applied';

type RecurringReviewDecisionRecord = FinanceReviewDecisionRecord &
  Readonly<{
    decision: RecurringReviewDecision;
    feature: 'recurring';
  }>;

export function RecurringReview() {
  const { t } = useTranslation();
  const format = useFormat();
  const { data: payees = {} } = usePayeesById();
  const [candidates, setCandidates] = useState<
    readonly RecurringPaymentCandidate[]
  >([]);
  const [decisions, setDecisions] = useState<
    readonly RecurringReviewDecisionRecord[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeCandidateKey, setActiveCandidateKey] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [transactionResult, scheduleResult, currentDecisions] =
        await Promise.all([
          aqlQuery(q('transactions').select('*')),
          aqlQuery(q('schedules').select('*')),
          send('finance/recurring/get-decisions'),
        ]);
      const currentTransactions = transactionResult.data as TransactionEntity[];
      const currentSchedules = scheduleResult.data as ScheduleEntity[];

      setCandidates(
        detectRecurringPayments(
          projectTransactions(currentTransactions, payees),
          currentSchedules.map(projectSchedule),
        ),
      );
      setDecisions(currentDecisions);
    } catch {
      setError(t('Recurring payments could not be scanned.'));
    } finally {
      setIsLoading(false);
    }
  }, [payees, t]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const decisionsByCandidateKey = useMemo(
    () =>
      new Map(
        decisions.map(decision => [decision.candidateKey, decision] as const),
      ),
    [decisions],
  );

  async function recordDecision(
    candidate: RecurringPaymentCandidate,
    decision: Exclude<RecurringReviewDecision, 'applied'>,
  ) {
    setActiveCandidateKey(candidate.candidateKey);
    setError(null);
    setSuccess(null);
    try {
      await send('finance/recurring/save-decision', {
        candidateKey: candidate.candidateKey,
        decision,
      });
      await scan();
    } catch {
      setError(t('The recurring review decision could not be saved.'));
    } finally {
      setActiveCandidateKey(null);
    }
  }

  async function reopen(candidate: RecurringPaymentCandidate) {
    setActiveCandidateKey(candidate.candidateKey);
    setError(null);
    setSuccess(null);
    try {
      await send('finance/recurring/reopen-decision', {
        candidateKey: candidate.candidateKey,
      });
      await scan();
    } catch {
      setError(t('The recurring payment could not be reopened.'));
    } finally {
      setActiveCandidateKey(null);
    }
  }

  async function approve(candidate: RecurringPaymentCandidate) {
    setActiveCandidateKey(candidate.candidateKey);
    setError(null);
    setSuccess(null);
    try {
      const result = await send('finance/recurring/apply', {
        candidateKey: candidate.candidateKey,
        evidenceFingerprint: candidate.evidenceFingerprint,
      });
      if (result.status === 'created') {
        setSuccess(t('The recurring schedule was created.'));
      } else if (result.status === 'updated') {
        setSuccess(t('The existing recurring schedule was updated.'));
      } else {
        setError(getApplyError(t, result.status));
      }
      await scan();
    } catch {
      setError(t('The recurring schedule could not be saved.'));
    } finally {
      setActiveCandidateKey(null);
    }
  }

  return (
    <Modal
      name="recurring-review"
      containerProps={{ style: { width: 760, maxHeight: 720 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Recurring payment review')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 10, padding: 16, overflow: 'auto' }}>
            <Text>
              <Trans>
                Scan current ledger history, review the evidence, and explicitly
                approve a candidate before Actual creates or updates a schedule.
              </Trans>
            </Text>
            <Button
              isDisabled={isLoading || activeCandidateKey != null}
              onPress={() => void scan()}
            >
              <Trans>Scan transactions</Trans>
            </Button>
            {isLoading && (
              <Text>
                <Trans>Scanning transactions...</Trans>
              </Text>
            )}
            {error != null && (
              <Text style={{ color: theme.errorText }}>{error}</Text>
            )}
            {success != null && (
              <Text style={{ color: theme.noticeTextLight }}>{success}</Text>
            )}
            {!isLoading && candidates.length === 0 && (
              <Text>
                <Trans>No recurring payment candidates were found.</Trans>
              </Text>
            )}
            {candidates.map(candidate => {
              const currentDecision = decisionsByCandidateKey.get(
                candidate.candidateKey,
              );
              const isActing = activeCandidateKey === candidate.candidateKey;
              const isApprovalBlocked =
                candidate.cadence === 'ambiguous' ||
                candidate.hasReconciledHistory ||
                candidate.relatedScheduleIds.length > 1;

              return (
                <View
                  key={candidate.candidateKey}
                  style={{
                    backgroundColor: theme.tableBackground,
                    gap: 6,
                    padding: 12,
                  }}
                >
                  <Text style={{ fontWeight: 600 }}>{candidate.payeeName}</Text>
                  <Text>
                    {getTypeLabel(t, candidate.type)}
                    {' · '}
                    {getCadenceLabel(t, candidate.cadence)}
                    {' · '}
                    {t('{{count}} occurrences', {
                      count: candidate.occurrenceCount,
                    })}
                    {' · '}
                    {t('{{confidence}}% confidence', {
                      confidence: candidate.confidence,
                    })}
                  </Text>
                  <Text>
                    <Trans>Median amount:</Trans>{' '}
                    <FinancialText>
                      {format(candidate.medianAmount, 'financial')}
                    </FinancialText>
                    {' · '}
                    {t('Amount variance: {{percent}}%', {
                      percent: (
                        candidate.amountVarianceBasisPoints / 100
                      ).toFixed(1),
                    })}
                    {' · '}
                    {t('Date variance: {{count}} days', {
                      count: candidate.dateVarianceDays,
                    })}
                  </Text>
                  <Text>
                    {t('{{firstDate}} through {{lastDate}}', {
                      firstDate: candidate.firstDate,
                      lastDate: candidate.lastDate,
                    })}
                    {' · '}
                    {candidate.relatedScheduleIds.length === 0
                      ? t('No existing schedule')
                      : t('{{count}} existing schedule', {
                          count: candidate.relatedScheduleIds.length,
                        })}
                  </Text>
                  <Text>
                    {candidate.reasons
                      .map(reason => getReasonLabel(t, reason))
                      .join(' · ')}
                  </Text>
                  {currentDecision != null && (
                    <Text>
                      {t('Review status: {{status}}', {
                        status: getDecisionLabel(t, currentDecision.decision),
                      })}
                    </Text>
                  )}
                  {currentDecision == null ? (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button
                        isDisabled={isActing || isApprovalBlocked}
                        onPress={() => void approve(candidate)}
                      >
                        <Trans>Approve</Trans>
                      </Button>
                      <Button
                        isDisabled={isActing}
                        onPress={() =>
                          void recordDecision(candidate, 'deferred')
                        }
                      >
                        <Trans>Defer</Trans>
                      </Button>
                      <Button
                        isDisabled={isActing}
                        onPress={() =>
                          void recordDecision(candidate, 'rejected')
                        }
                      >
                        <Trans>Reject</Trans>
                      </Button>
                    </View>
                  ) : (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button
                        isDisabled={isActing}
                        onPress={() => void reopen(candidate)}
                      >
                        <Trans>Reopen</Trans>
                      </Button>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </>
      )}
    </Modal>
  );
}

function projectTransactions(
  transactions: readonly TransactionEntity[],
  payees: Readonly<
    Record<
      string,
      Readonly<{ name?: string; transfer_acct?: string | null }> | undefined
    >
  >,
): RecurringPaymentTransaction[] {
  return transactions.map(transaction => ({
    accountId: transaction.account,
    amount: transaction.amount,
    date: transaction.date,
    id: transaction.id,
    isReconciled: transaction.reconciled === true,
    isSplitParent: transaction.is_parent === true,
    isStartingBalance: transaction.starting_balance_flag === true,
    isTombstone:
      transaction.tombstone === true || transaction._deleted === true,
    isTransfer:
      transaction.transfer_id != null ||
      (transaction.payee != null &&
        payees[transaction.payee]?.transfer_acct != null),
    payeeId: transaction.payee ?? null,
    payeeName:
      transaction.payee == null
        ? null
        : (payees[transaction.payee]?.name ?? null),
  }));
}

function projectSchedule(schedule: ScheduleEntity): RecurringPaymentSchedule {
  return {
    accountId: schedule._account ?? null,
    amount: schedule._amount ?? null,
    amountOperator: schedule._amountOp ?? null,
    id: schedule.id,
    isCompleted: schedule.completed,
    payeeId: schedule._payee ?? null,
    recurrence: schedule._date ?? null,
  };
}

function getTypeLabel(t: TFunction, type: RecurringPaymentType): string {
  if (type === 'optional-subscription') return t('Optional subscription');
  if (type === 'household-bill') return t('Household bill');
  return t('Financial bill');
}

function getCadenceLabel(
  t: TFunction,
  cadence: RecurringPaymentCandidate['cadence'],
): string {
  if (cadence === 'weekly') return t('Weekly');
  if (cadence === 'monthly') return t('Monthly');
  if (cadence === 'quarterly') return t('Quarterly');
  if (cadence === 'annual') return t('Annual');
  return t('Ambiguous cadence');
}

function getReasonLabel(t: TFunction, reason: RecurringPaymentReason): string {
  switch (reason) {
    case 'cadence-weekly':
      return t('Weekly cadence');
    case 'cadence-monthly':
      return t('Monthly cadence');
    case 'cadence-quarterly':
      return t('Quarterly cadence');
    case 'cadence-annual':
      return t('Annual cadence');
    case 'cadence-ambiguous':
      return t('Cadence is ambiguous');
    case 'minimum-occurrences':
      return t('Enough occurrences');
    case 'billing-date-variance':
      return t('Billing date varies');
    case 'stable-amount':
      return t('Amount is stable');
    case 'amount-variance':
      return t('Amount varies');
    case 'price-change':
      return t('Recent price change');
    case 'gap-detected':
      return t('One occurrence may be missing');
    case 'reconciled-history':
      return t('Includes reconciled history and is read-only');
    case 'existing-schedule':
      return t('Matches an existing schedule');
    case 'schedule-ambiguous':
      return t('Multiple schedules require manual review');
    default:
      return t('Unknown evidence');
  }
}

function getDecisionLabel(
  t: TFunction,
  decision: RecurringReviewDecision,
): string {
  if (decision === 'deferred') return t('Deferred');
  if (decision === 'rejected') return t('Rejected');
  return t('Applied');
}

function getApplyError(
  t: TFunction,
  status:
    | 'stale'
    | 'blocked-reconciled'
    | 'blocked-ambiguous-cadence'
    | 'blocked-ambiguous-schedules',
): string {
  if (status === 'stale') {
    return t('The evidence changed. Review the refreshed candidate.');
  }
  if (status === 'blocked-reconciled') {
    return t('Schedules cannot be changed from reconciled evidence.');
  }
  if (status === 'blocked-ambiguous-cadence') {
    return t('Choose the cadence manually in Actual Schedules.');
  }
  return t('Multiple schedules match. Resolve them in Actual Schedules first.');
}
