import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { SpaceBetween } from '@actual-app/components/space-between';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { NativeReconciliationCandidate } from '@actual-app/core/types/finance';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useAccounts } from '#hooks/useAccounts';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';

type ReconciliationDecision = 'merge' | 'keep-both' | 'deferred';

function Confidence({
  confidence,
}: {
  confidence: NativeReconciliationCandidate['confidence'];
}) {
  switch (confidence) {
    case 'high':
      return <Trans>High confidence</Trans>;
    case 'medium':
      return <Trans>Medium confidence</Trans>;
    case 'low':
      return <Trans>Low confidence</Trans>;
    default:
      return unreachableLabel(confidence);
  }
}

function Reason({
  reason,
}: {
  reason: NativeReconciliationCandidate['reasons'][number];
}) {
  switch (reason) {
    case 'same-imported-id':
      return <Trans>Same imported transaction ID</Trans>;
    case 'both-imported':
      return <Trans>Both transactions came from imports</Trans>;
    case 'same-date':
      return <Trans>Same transaction date</Trans>;
    case 'nearby-date':
      return <Trans>Transaction dates are close</Trans>;
    case 'same-payee':
      return <Trans>Same normalized merchant</Trans>;
    case 'missing-payee':
      return <Trans>Merchant evidence is unavailable</Trans>;
    case 'different-payee':
      return <Trans>Merchant names differ</Trans>;
    case 'cleared-state-differs':
      return <Trans>Cleared states differ</Trans>;
    default:
      return unreachableLabel(reason);
  }
}

function unreachableLabel(value: never): never {
  throw new Error(`Unexpected reconciliation label: ${String(value)}`);
}

export function ReconciliationReviewModal() {
  const { t } = useTranslation();
  const format = useFormat();
  const { data: accounts = [] } = useAccounts();
  const { data: { list: categories } = { list: [] } } = useCategories();
  const [candidates, setCandidates] = useState<
    readonly NativeReconciliationCandidate[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [workingCandidateKey, setWorkingCandidateKey] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCandidates(await send('finance/reconciliation-list'));
    } catch {
      setError(t('Could not load duplicate suggestions.'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  async function decide(
    candidate: NativeReconciliationCandidate,
    decision: ReconciliationDecision,
  ) {
    setWorkingCandidateKey(candidate.candidateKey);
    setError(null);
    try {
      const result = await send('finance/reconciliation-decide', {
        candidateKey: candidate.candidateKey,
        fingerprint: candidate.fingerprint,
        decision,
      });
      if (result.status === 'stale') {
        setCandidates(await send('finance/reconciliation-list'));
        setError(
          t('This duplicate suggestion changed. Refresh and review it again.'),
        );
        return;
      }
      await loadCandidates();
    } catch {
      setError(t('The duplicate decision could not be applied.'));
    } finally {
      setWorkingCandidateKey(null);
    }
  }

  return (
    <Modal
      name="reconciliation-review"
      containerProps={{ style: { width: 820, maxHeight: 700 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Review possible duplicates')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <Paragraph>
            <Trans>
              Actual found transactions with the same account and amount. Check
              the evidence before merging; nothing changes until you choose an
              action.
            </Trans>
          </Paragraph>

          {error && (
            <Text role="alert" style={{ color: theme.errorText }}>
              {error}
            </Text>
          )}
          {loading ? (
            <Text role="status" aria-live="polite">
              <Trans>Finding possible duplicates…</Trans>
            </Text>
          ) : candidates.length === 0 ? (
            <Text>
              <Trans>No possible duplicates need review.</Trans>
            </Text>
          ) : (
            <View
              aria-busy={workingCandidateKey !== null}
              style={{ gap: 12, overflowY: 'auto' }}
            >
              {candidates.map(candidate => {
                const isWorking =
                  workingCandidateKey === candidate.candidateKey;
                return (
                  <View
                    key={candidate.candidateKey}
                    style={{
                      border: `1px solid ${theme.tableBorder}`,
                      borderRadius: 6,
                      padding: 12,
                      gap: 8,
                    }}
                  >
                    <SpaceBetween>
                      <FinancialText style={{ fontWeight: 600 }}>
                        {format(candidate.amount, 'financial')}
                      </FinancialText>
                      <Text>
                        <Confidence confidence={candidate.confidence} />{' '}
                        <Trans>Score: {{ score: candidate.score }}</Trans>
                      </Text>
                    </SpaceBetween>
                    <Text>
                      <Trans>
                        Account:{' '}
                        {{
                          account:
                            accounts.find(
                              account => account.id === candidate.accountId,
                            )?.name ?? candidate.accountId,
                        }}
                      </Trans>
                    </Text>
                    {candidate.transactions.map(transaction => (
                      <View key={transaction.id} style={{ gap: 2 }}>
                        <Text style={{ fontWeight: 600 }}>
                          {transaction.date} —{' '}
                          {transaction.payee ??
                            transaction.importedPayee ??
                            t('Unknown payee')}
                        </Text>
                        <Text>
                          {transaction.cleared ? t('Cleared') : t('Uncleared')}
                        </Text>
                        {transaction.importedId && (
                          <Text>
                            <Trans>
                              Import ID: {{ id: transaction.importedId }}
                            </Trans>
                          </Text>
                        )}
                        {transaction.categoryId && (
                          <Text>
                            <Trans>
                              Category:{' '}
                              {{
                                category:
                                  categories.find(
                                    category =>
                                      category.id === transaction.categoryId,
                                  )?.name ?? transaction.categoryId,
                              }}
                            </Trans>
                          </Text>
                        )}
                        {transaction.scheduleId && (
                          <Text>
                            <Trans>Linked to a schedule</Trans>
                          </Text>
                        )}
                        {transaction.notes && <Text>{transaction.notes}</Text>}
                      </View>
                    ))}
                    <View style={{ gap: 2 }}>
                      {candidate.reasons.map(reason => (
                        <Text key={reason}>
                          <Reason reason={reason} />
                        </Text>
                      ))}
                    </View>
                    <SpaceBetween style={{ justifyContent: 'flex-end' }}>
                      <Button
                        variant="bare"
                        isDisabled={isWorking}
                        onPress={() => void decide(candidate, 'deferred')}
                      >
                        <Trans>Defer</Trans>
                      </Button>
                      <Button
                        variant="bare"
                        isDisabled={isWorking}
                        onPress={() => void decide(candidate, 'keep-both')}
                      >
                        <Trans>Keep both</Trans>
                      </Button>
                      <Button
                        variant="primary"
                        isDisabled={isWorking}
                        onPress={() => void decide(candidate, 'merge')}
                      >
                        <Trans>Merge</Trans>
                      </Button>
                    </SpaceBetween>
                  </View>
                );
              })}
            </View>
          )}
        </>
      )}
    </Modal>
  );
}
