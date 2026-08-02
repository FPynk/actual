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
import { useFormat } from '#hooks/useFormat';

type ReconciliationDecision = 'merge' | 'keep-both' | 'deferred';

export function ReconciliationReviewModal() {
  const { t } = useTranslation();
  const format = useFormat();
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
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t('Could not load duplicate suggestions.'),
      );
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
      await send('finance/reconciliation-decide', {
        candidateKey: candidate.candidateKey,
        fingerprint: candidate.fingerprint,
        decision,
      });
      await loadCandidates();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t('The duplicate decision could not be applied.'),
      );
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

          {error && <Text style={{ color: theme.errorText }}>{error}</Text>}
          {loading ? (
            <Text>
              <Trans>Finding possible duplicates...</Trans>
            </Text>
          ) : candidates.length === 0 ? (
            <Text>
              <Trans>No possible duplicates need review.</Trans>
            </Text>
          ) : (
            <View style={{ gap: 12, overflowY: 'auto' }}>
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
                      <Text style={{ fontWeight: 600 }}>
                        {format(candidate.amount, 'financial')}
                      </Text>
                      <Text>
                        {candidate.confidence} ({candidate.score})
                      </Text>
                    </SpaceBetween>
                    {candidate.transactions.map(transaction => (
                      <View key={transaction.id} style={{ gap: 2 }}>
                        <Text style={{ fontWeight: 600 }}>
                          {transaction.date} -{' '}
                          {transaction.payee ??
                            transaction.importedPayee ??
                            t('Unknown payee')}
                        </Text>
                        <Text>
                          {transaction.cleared ? t('Cleared') : t('Pending')}
                          {transaction.importedId
                            ? ` - ${t('Import ID')}: ${transaction.importedId}`
                            : ''}
                        </Text>
                        {transaction.notes && <Text>{transaction.notes}</Text>}
                      </View>
                    ))}
                    <Text>{candidate.reasons.join(' - ')}</Text>
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
