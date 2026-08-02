import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type { RecurConfig, TransactionEntity } from '@actual-app/core/types/models';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { usePayeesById } from '#hooks/usePayees';
import { aqlQuery } from '#queries/aqlQuery';

import {
  detectRecurringPayments,
  type RecurringPaymentCandidate,
} from './recurring-detector';

export function RecurringReview() {
  const { t } = useTranslation();
  const { data: payees = {} } = usePayeesById();
  const [candidates, setCandidates] = useState<readonly RecurringPaymentCandidate[]>([]);
  const [transactions, setTransactions] = useState<readonly TransactionEntity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hiddenCandidates, setHiddenCandidates] = useState(new Set<string>());

  async function scan() {
    setIsLoading(true);
    const { data } = await aqlQuery(q('transactions').select('*'));
    const currentTransactions = data as TransactionEntity[];
    setTransactions(currentTransactions);
    setCandidates(
      detectRecurringPayments(
        currentTransactions.map(transaction => ({
          accountId: transaction.account,
          amount: transaction.amount,
          date: transaction.date,
          id: transaction.id,
          isReconciled: transaction.cleared,
          isSplitParent: transaction.is_parent,
          isTransfer: transaction.payee != null && payees[transaction.payee]?.transfer_acct != null,
          payeeId: transaction.payee,
          payeeName: transaction.payee == null ? null : payees[transaction.payee]?.name ?? null,
        })),
      ),
    );
    setIsLoading(false);
  }

  useEffect(() => {
    void scan();
  }, [payees]);

  async function recordDecision(candidate: RecurringPaymentCandidate, decision: 'deferred' | 'rejected') {
    await send('finance/recurring/save-decision', {
      candidateKey: `${candidate.accountId}:${candidate.payeeId}:${candidate.cadence}`,
      decision,
    });
    setHiddenCandidates(current => new Set([...current, candidate.payeeId]));
  }

  async function approve(candidate: RecurringPaymentCandidate) {
    if (candidate.cadence === 'ambiguous' || candidate.hasReconciledHistory) return;

    const { data: currentTransactions } = await aqlQuery(
      q('transactions').select('*'),
    );
    const matchingTransactions = (currentTransactions as TransactionEntity[]).filter(
      transaction =>
        transaction.account === candidate.accountId &&
        transaction.payee === candidate.payeeId &&
        transaction.amount < 0 &&
        !transaction.is_parent &&
        !transaction.cleared,
    );
    if (matchingTransactions.length < candidate.occurrenceCount) return;

    const { data: schedules } = await aqlQuery(q('schedules').select('*'));
    const matchingSchedules = schedules.filter(
      schedule =>
        schedule._account === candidate.accountId &&
        schedule._payee === candidate.payeeId &&
        !schedule.completed,
    );
    if (matchingSchedules.length > 1) return;

    if (matchingSchedules.length === 1) {
      await send('schedule/update', {
        conditions: matchingSchedules[0]._conditions,
        schedule: { id: matchingSchedules[0].id, name: candidate.payeeName },
      });
    } else {
      await send('schedule/create', {
        conditions: createScheduleConditions(candidate, matchingTransactions[0]),
        schedule: { name: candidate.payeeName },
      });
    }
    await recordDecision(candidate, 'deferred');
    await scan();
  }

  return (
    <Modal name="recurring-review" containerProps={{ style: { width: 720 } }}>
      {({ state }) => (
        <>
          <ModalHeader title={t('Recurring payment review')} rightContent={<ModalCloseButton onPress={() => state.close()} />} />
          <View style={{ gap: 10, padding: 16 }}>
            <Text><Trans>Review detected recurring payments before creating a schedule.</Trans></Text>
            <Button onPress={() => void scan()}><Trans>Scan transactions</Trans></Button>
            {isLoading && <Text><Trans>Scanning transactions...</Trans></Text>}
            {candidates.filter(candidate => !hiddenCandidates.has(candidate.payeeId)).map(candidate => (
              <View key={`${candidate.accountId}:${candidate.payeeId}`} style={{ backgroundColor: theme.tableBackground, gap: 5, padding: 12 }}>
                <Text style={{ fontWeight: 600 }}>{candidate.payeeName}</Text>
                <Text>{candidate.type} · {candidate.cadence} · {candidate.occurrenceCount} occurrences</Text>
                <Text>{candidate.reasons.join(' · ')}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button isDisabled={candidate.cadence === 'ambiguous' || candidate.hasReconciledHistory} onPress={() => void approve(candidate)}><Trans>Approve</Trans></Button>
                  <Button onPress={() => void recordDecision(candidate, 'deferred')}><Trans>Defer</Trans></Button>
                  <Button onPress={() => void recordDecision(candidate, 'rejected')}><Trans>Reject</Trans></Button>
                </View>
              </View>
            ))}
          </View>
        </>
      )}
    </Modal>
  );
}

function createScheduleConditions(
  candidate: RecurringPaymentCandidate,
  transaction: TransactionEntity,
) {
  const frequency =
    candidate.cadence === 'annual'
      ? 'yearly'
      : candidate.cadence === 'quarterly'
        ? 'monthly'
        : candidate.cadence;
  const date = {
    endDate: transaction.date,
    endMode: 'never',
    endOccurrences: 1,
    frequency,
    interval: candidate.cadence === 'quarterly' ? 3 : 1,
    patterns: [],
    skipWeekend: false,
    start: transaction.date,
    weekendSolveMode: 'after',
  } satisfies RecurConfig;
  return [
    { field: 'account', op: 'is', value: candidate.accountId },
    { field: 'payee', op: 'is', value: candidate.payeeId },
    { field: 'amount', op: 'isapprox', value: candidate.medianAmount * -1 },
    { field: 'date', op: 'isapprox', value: date },
  ];
}
