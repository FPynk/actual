import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import {
  getDefaultSelectedCategorizationCandidateIds,
  maximumCategorizationCandidates,
  requestCategorizationProposalsSequentially,
  toCategorizationGatewayCandidate,
} from '@actual-app/core/shared/finance-categorization';
import type {
  CategorizationIneligibilityReason,
  CategorizationProposal,
  PreparedCategorizationCandidate,
} from '@actual-app/core/shared/finance-categorization';
import type { QueryState } from '@actual-app/core/shared/query';
import { defaultFinanceCategorizationSettings } from '@actual-app/core/types/finance';
import type { FinanceCategorizationSettings } from '@actual-app/core/types/finance';
import { v4 as uuidv4 } from 'uuid';

import { Information } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { FormField, FormLabel } from '#components/forms';
import { LabeledCheckbox } from '#components/forms/LabeledCheckbox';
import {
  normalizeCategorizationCurrencyCode,
  prepareCategorizationScopeCandidates,
} from '#components/transactions/categorization';
import type {
  CategorizationQueryRow,
  CategorizationScope,
} from '#components/transactions/categorization';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useUndo } from '#hooks/useUndo';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { aqlQuery } from '#queries/aqlQuery';
type AutoCategorizeModalProps = Extract<
  ModalType,
  { name: 'auto-categorize' }
>['options'];

type ModalStage =
  | 'applied'
  | 'applying'
  | 'consent'
  | 'requesting'
  | 'review'
  | 'setup';

type ReviewRow = {
  candidate: PreparedCategorizationCandidate;
  proposal: CategorizationProposal;
};

const categorizationReviewPageSize = 100;

function parseCategorizationSettings(
  serializedSettings: string | undefined,
): FinanceCategorizationSettings {
  if (!serializedSettings) return defaultFinanceCategorizationSettings;
  try {
    const value: unknown = JSON.parse(serializedSettings);
    if (!value || typeof value !== 'object') {
      return defaultFinanceCategorizationSettings;
    }
    const settings = value as Partial<FinanceCategorizationSettings>;
    const parsedCategoryIds: unknown[] = Array.isArray(settings.categoryIds)
      ? settings.categoryIds
      : [];
    return {
      categoryGuidance:
        settings.categoryGuidance &&
        typeof settings.categoryGuidance === 'object' &&
        !Array.isArray(settings.categoryGuidance)
          ? settings.categoryGuidance
          : {},
      categoryIds: [
        ...new Set(
          parsedCategoryIds.filter(
            (categoryId): categoryId is string =>
              typeof categoryId === 'string',
          ),
        ),
      ],
      masterPrompt:
        typeof settings.masterPrompt === 'string' &&
        settings.masterPrompt.trim().length > 0
          ? settings.masterPrompt.trim()
          : defaultFinanceCategorizationSettings.masterPrompt,
      model:
        typeof settings.model === 'string' && settings.model.trim()
          ? settings.model.trim()
          : defaultFinanceCategorizationSettings.model,
    };
  } catch {
    return defaultFinanceCategorizationSettings;
  }
}

function countSkippedTransactions(
  skipped: Record<CategorizationIneligibilityReason, number>,
) {
  return Object.values(skipped).reduce((total, count) => total + count, 0);
}

export function AutoCategorizeModal({
  currentQuery,
  initialScope,
  selectedTransactionIds,
  onApplied,
  onCreateRule,
}: AutoCategorizeModalProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const { undo, showUndoNotification } = useUndo();
  const { data: categoryData } = useCategories();
  const [serializedSettings] = useSyncedPref('finance.openai-categorization');
  const settings = useMemo(
    () => parseCategorizationSettings(serializedSettings),
    [serializedSettings],
  );
  const categoriesById = useMemo(
    () =>
      new Map(
        (categoryData?.list ?? []).map(category => [category.id, category]),
      ),
    [categoryData?.list],
  );
  const selectableCategoryIds = useMemo(
    () =>
      new Set(
        (categoryData?.grouped ?? [])
          .filter(group => !group.hidden && !group.is_income)
          .flatMap(group => group.categories ?? [])
          .filter(category => !category.hidden && !category.is_income)
          .map(category => category.id),
      ),
    [categoryData?.grouped],
  );
  const allowedCategories = useMemo(
    () =>
      settings.categoryIds.flatMap(categoryId => {
        const category = categoriesById.get(categoryId);
        return category &&
          selectableCategoryIds.has(category.id) &&
          !category.hidden &&
          !category.is_income
          ? [category]
          : [];
      }),
    [categoriesById, selectableCategoryIds, settings.categoryIds],
  );
  const allowedCategoryIds = useMemo(
    () => new Set(allowedCategories.map(category => category.id)),
    [allowedCategories],
  );

  const [stage, setStage] = useState<ModalStage>('setup');
  const [scopeKind, setScopeKind] =
    useState<CategorizationScope['kind']>(initialScope);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [includeCategorized, setIncludeCategorized] = useState(false);
  const [acceptedDisclosure, setAcceptedDisclosure] = useState(false);
  const [preparedCandidates, setPreparedCandidates] = useState<
    PreparedCategorizationCandidate[]
  >([]);
  const [skippedCounts, setSkippedCounts] = useState<Record<
    CategorizationIneligibilityReason,
    number
  > | null>(null);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewPage, setReviewPage] = useState(0);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
    new Set(),
  );
  const [appliedTransactionIds, setAppliedTransactionIds] = useState<string[]>(
    [],
  );
  const [applySkippedCount, setApplySkippedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestAbortControllerRef.current?.abort();
    };
  }, []);

  const scopeOptions: Array<readonly [CategorizationScope['kind'], string]> = [
    ...(selectedTransactionIds.length > 0
      ? ([['selected', t('Selected transactions')]] as const)
      : []),
    ['current-filter', t('Current filtered view')],
    ['date-range', t('Inclusive date range')],
    ['all', t('All eligible expenses')],
  ];

  const buildScope = (): CategorizationScope => {
    switch (scopeKind) {
      case 'selected':
        return { kind: 'selected', transactionIds: selectedTransactionIds };
      case 'current-filter':
        return {
          kind: 'current-filter',
          query: JSON.parse(currentQuery) as QueryState,
        };
      case 'date-range':
        return { kind: 'date-range', startDate, endDate };
      case 'all':
        return { kind: 'all' };
      default:
        throw new Error('Unsupported categorization scope');
    }
  };

  const prepareScope = async () => {
    setError(null);
    if (allowedCategories.length === 0) {
      setError(
        t(
          'Choose at least one expense category in OpenAI categorization settings.',
        ),
      );
      return;
    }
    if (
      scopeKind === 'date-range' &&
      (!startDate || !endDate || startDate > endDate)
    ) {
      setError(t('Choose a valid inclusive date range.'));
      return;
    }

    try {
      const resolved = await prepareCategorizationScopeCandidates({
        scope: buildScope(),
        includeCategorized,
        currency: normalizeCategorizationCurrencyCode(format.currency.code),
        decimalPlaces: format.currency.decimalPlaces,
        createCandidateId: uuidv4,
        readPage: async query => {
          const { data } = await aqlQuery(query);
          return data as CategorizationQueryRow[];
        },
      });
      if (resolved.exceededMaximum) {
        setError(
          t(
            'This scope contains more than {{maximum}} eligible expenses. Choose a smaller scope.',
            { maximum: maximumCategorizationCandidates },
          ),
        );
        return;
      }
      if (resolved.candidates.length === 0) {
        setError(t('This scope contains no eligible expenses.'));
        return;
      }
      setPreparedCandidates(resolved.candidates);
      setSkippedCounts(resolved.skipped);
      setAcceptedDisclosure(false);
      setStage('consent');
    } catch {
      setError(t('Actual could not read the transactions in this scope.'));
    }
  };

  const requestProposals = async () => {
    if (!acceptedDisclosure) return;
    const controller = new AbortController();
    requestAbortControllerRef.current?.abort();
    requestAbortControllerRef.current = controller;
    setError(null);
    setAcceptedDisclosure(false);
    setStage('requesting');
    try {
      const result = await requestCategorizationProposalsSequentially({
        candidates: preparedCandidates,
        allowedCategoryIds,
        signal: controller.signal,
        requestBatch: async (batch, signal) => {
          if (signal?.aborted) throw new Error('categorization-aborted');
          const result = await send('finance-categorize', {
            model: settings.model,
            categorization_instruction: settings.masterPrompt,
            categories: allowedCategories.map(category => ({
              category_id: category.id,
              name: category.name,
              guidance: settings.categoryGuidance[category.id] || undefined,
            })),
            candidates: batch.map(toCategorizationGatewayCandidate),
          });
          if ('error' in result) throw new Error(result.error);
          return result.proposals.map(proposal => ({
            candidateId: proposal.candidate_id,
            categoryId: proposal.category_id,
            confidence: proposal.confidence,
            explanation: proposal.explanation,
          }));
        },
      });
      if (
        !isMountedRef.current ||
        requestAbortControllerRef.current !== controller
      ) {
        return;
      }
      const candidatesById = new Map(
        preparedCandidates.map(candidate => [candidate.candidateId, candidate]),
      );
      const nextReviewRows = result.proposals.map(proposal => ({
        candidate: candidatesById.get(proposal.candidateId)!,
        proposal,
      }));
      if (nextReviewRows.length === 0) {
        if (result.outcome === 'aborted') {
          setStage('consent');
          return;
        }
        setError(
          t(
            'OpenAI did not return valid suggestions. No transactions were changed.',
          ),
        );
        setStage('consent');
        return;
      }
      setReviewRows(nextReviewRows);
      setReviewPage(0);
      setSelectedCandidateIds(
        getDefaultSelectedCategorizationCandidateIds(result.proposals),
      );
      const unanalyzedCandidateCount =
        preparedCandidates.length - result.proposals.length;
      if (result.outcome === 'aborted') {
        setError(
          t(
            'Stopped after completed batches. {{count}} expenses were not analyzed. Review the suggestions already received or start a new preview; no transactions were changed.',
            { count: unanalyzedCandidateCount },
          ),
        );
      } else if (result.outcome === 'failed') {
        setError(
          t(
            'OpenAI stopped before every batch completed. {{count}} expenses were not analyzed. Review the suggestions already received or start a new preview; no transactions were changed.',
            { count: unanalyzedCandidateCount },
          ),
        );
      }
      setStage('review');
    } catch {
      if (!isMountedRef.current) return;
      setError(
        t(
          'OpenAI did not return valid suggestions. No transactions were changed.',
        ),
      );
      setStage('consent');
    } finally {
      if (requestAbortControllerRef.current === controller) {
        requestAbortControllerRef.current = null;
      }
    }
  };

  const stopRequestingProposals = () => {
    requestAbortControllerRef.current?.abort();
  };

  const applySelectedProposals = async () => {
    const selectedRows = reviewRows.filter(
      row =>
        selectedCandidateIds.has(row.candidate.candidateId) &&
        row.proposal.categoryId !== null,
    );
    if (selectedRows.length === 0) return;
    setError(null);
    setStage('applying');
    try {
      const result = await send('finance-categorization-apply', {
        includeCategorized,
        proposals: selectedRows.map(row => ({
          categoryId: row.proposal.categoryId!,
          fingerprint: row.candidate.fingerprint,
          transactionId: row.candidate.transactionId,
        })),
      });
      setAppliedTransactionIds(result.appliedTransactionIds);
      setApplySkippedCount(result.skipped.length);
      await onApplied();
      showUndoNotification({
        message: t('{{count}} transactions categorized', {
          count: result.appliedTransactionIds.length,
        }),
      });
      setStage('applied');
    } catch {
      setError(
        t(
          'Actual could not apply these suggestions. No unsafe rows were changed.',
        ),
      );
      setStage('review');
    }
  };

  const selectedProposalCount = selectedCandidateIds.size;
  const skippedTransactionCount = skippedCounts
    ? countSkippedTransactions(skippedCounts)
    : 0;
  const categoryOptions: Array<readonly [string, string]> = [
    ['', t('No category')],
    ...allowedCategories.map(category => [category.id, category.name] as const),
  ];
  const reviewPageCount = Math.ceil(
    reviewRows.length / categorizationReviewPageSize,
  );
  const visibleReviewRows = reviewRows.slice(
    reviewPage * categorizationReviewPageSize,
    (reviewPage + 1) * categorizationReviewPageSize,
  );

  return (
    <Modal
      name="auto-categorize"
      containerProps={{ style: { width: 900, maxWidth: '95vw' } }}
      onClose={stopRequestingProposals}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Auto-categorize expenses')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 16, maxHeight: '80vh' }}>
            {stage === 'setup' && (
              <>
                <FormField>
                  <FormLabel
                    title={t('Transactions to classify')}
                    htmlFor="categorization-scope"
                  />
                  <Select
                    id="categorization-scope"
                    value={scopeKind}
                    options={scopeOptions}
                    onChange={setScopeKind}
                    style={{ width: 280 }}
                  />
                </FormField>
                {scopeKind === 'date-range' && (
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <FormField>
                      <FormLabel
                        title={t('Start date')}
                        htmlFor="categorization-start-date"
                      />
                      <Input
                        id="categorization-start-date"
                        type="date"
                        value={startDate}
                        onChange={event =>
                          setStartDate(event.currentTarget.value)
                        }
                      />
                    </FormField>
                    <FormField>
                      <FormLabel
                        title={t('End date')}
                        htmlFor="categorization-end-date"
                      />
                      <Input
                        id="categorization-end-date"
                        type="date"
                        value={endDate}
                        onChange={event =>
                          setEndDate(event.currentTarget.value)
                        }
                      />
                    </FormField>
                  </View>
                )}
                <LabeledCheckbox
                  id="categorization-include-categorized"
                  checked={includeCategorized}
                  onChange={event =>
                    setIncludeCategorized(event.currentTarget.checked)
                  }
                >
                  <Trans>
                    Include already categorized expenses and allow replacing
                    their categories
                  </Trans>
                </LabeledCheckbox>
                <Information>
                  <Trans count={allowedCategories.length}>
                    OpenAI may choose from {{ count: allowedCategories.length }}
                    configured expense categories. Change the allow-list and
                    guidance in Settings.
                  </Trans>
                </Information>
                <ModalButtons>
                  <Button onPress={() => state.close()}>
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button variant="primary" onPress={() => void prepareScope()}>
                    <Trans>Review eligible expenses</Trans>
                  </Button>
                </ModalButtons>
              </>
            )}

            {stage === 'consent' && (
              <>
                <Text>
                  <Trans count={preparedCandidates.length}>
                    {{ count: preparedCandidates.length }} eligible expenses
                    will use{' '}
                    {{ requests: Math.ceil(preparedCandidates.length / 25) }}
                    sequential OpenAI requests.{' '}
                    {{ skipped: skippedTransactionCount }}
                    ineligible rows will be skipped.
                  </Trans>
                </Text>
                <Information>
                  <Trans>
                    Descriptions, payees, dates, amounts, currency, account
                    names, your selected category names and guidance, and your
                    custom instruction will be sent to OpenAI to generate
                    suggestions. No OpenAI API key, Actual transaction IDs,
                    notes, attachments, balances, budget name, or unselected
                    transactions are sent.
                  </Trans>
                </Information>
                <LabeledCheckbox
                  id="categorization-privacy-consent"
                  checked={acceptedDisclosure}
                  onChange={event =>
                    setAcceptedDisclosure(event.currentTarget.checked)
                  }
                >
                  <Trans>
                    I understand and want to generate suggestions for this run
                  </Trans>
                </LabeledCheckbox>
                <ModalButtons>
                  <Button onPress={() => setStage('setup')}>
                    <Trans>Back</Trans>
                  </Button>
                  <Button
                    variant="primary"
                    isDisabled={!acceptedDisclosure}
                    onPress={() => void requestProposals()}
                  >
                    <Trans>Generate suggestions</Trans>
                  </Button>
                </ModalButtons>
              </>
            )}

            {stage === 'requesting' && (
              <>
                <Information>
                  <Trans>
                    Requesting categorization suggestions sequentially. Nothing
                    is being changed yet.
                  </Trans>
                </Information>
                <ModalButtons>
                  <Button onPress={stopRequestingProposals}>
                    <Trans>Stop requesting</Trans>
                  </Button>
                </ModalButtons>
              </>
            )}

            {stage === 'applying' && (
              <Information>
                <Trans>
                  Revalidating and applying the selected categories in one
                  undoable operation.
                </Trans>
              </Information>
            )}

            {stage === 'review' && (
              <>
                <Text>
                  <Trans count={selectedProposalCount}>
                    {{ count: selectedProposalCount }} suggestions selected.
                    Only high-confidence suggestions are selected by default.
                  </Trans>
                </Text>
                <View
                  style={{
                    border: `1px solid ${theme.tableBorder}`,
                    borderRadius: 6,
                    maxHeight: '55vh',
                    overflowY: 'auto',
                  }}
                >
                  {visibleReviewRows.map(row => {
                    const isSelected = selectedCandidateIds.has(
                      row.candidate.candidateId,
                    );
                    const categorySelectId = `categorization-category-${row.candidate.candidateId}`;
                    return (
                      <View
                        key={row.candidate.candidateId}
                        style={{
                          borderBottom: `1px solid ${theme.tableBorder}`,
                          padding: 10,
                          gap: 6,
                        }}
                      >
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <LabeledCheckbox
                            id={`categorization-proposal-${row.candidate.candidateId}`}
                            checked={isSelected}
                            disabled={!row.proposal.categoryId}
                            onChange={event => {
                              setSelectedCandidateIds(previous => {
                                const next = new Set(previous);
                                if (event.currentTarget.checked) {
                                  next.add(row.candidate.candidateId);
                                } else {
                                  next.delete(row.candidate.candidateId);
                                }
                                return next;
                              });
                            }}
                          >
                            <Text style={{ fontWeight: 600 }}>
                              {row.candidate.description || row.candidate.payee}
                            </Text>
                          </LabeledCheckbox>
                          <View style={{ flex: 1 }} />
                          <FinancialText>
                            {format(row.candidate.amountInteger, 'financial')}
                          </FinancialText>
                          <Text style={{ color: theme.pageTextSubdued }}>
                            {row.candidate.date}
                          </Text>
                        </View>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <Text
                            style={{ color: theme.pageTextSubdued, width: 180 }}
                          >
                            {t('Current: {{category}}', {
                              category: row.candidate.currentCategoryId
                                ? categoriesById.get(
                                    row.candidate.currentCategoryId,
                                  )?.name || t('Unavailable category')
                                : t('Uncategorized'),
                            })}
                          </Text>
                          <FormLabel
                            title={t('Category')}
                            htmlFor={categorySelectId}
                            style={{ marginBottom: 0 }}
                          />
                          <Select
                            id={categorySelectId}
                            value={row.proposal.categoryId ?? ''}
                            options={categoryOptions}
                            onChange={categoryId => {
                              setReviewRows(previous =>
                                previous.map(previousRow =>
                                  previousRow.candidate.candidateId ===
                                  row.candidate.candidateId
                                    ? {
                                        ...previousRow,
                                        proposal: {
                                          ...previousRow.proposal,
                                          categoryId: categoryId || null,
                                        },
                                      }
                                    : previousRow,
                                ),
                              );
                              setSelectedCandidateIds(previous => {
                                const next = new Set(previous);
                                if (categoryId) {
                                  next.add(row.candidate.candidateId);
                                } else {
                                  next.delete(row.candidate.candidateId);
                                }
                                return next;
                              });
                            }}
                            style={{ width: 220 }}
                          />
                          <Text style={{ color: theme.pageTextSubdued }}>
                            {t('{{confidence}} confidence', {
                              confidence: row.proposal.confidence,
                            })}
                          </Text>
                        </View>
                        <Text style={{ color: theme.pageTextSubdued }}>
                          {row.proposal.explanation}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                {reviewPageCount > 1 && (
                  <View
                    style={{
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: 8,
                    }}
                  >
                    <Button
                      isDisabled={reviewPage === 0}
                      onPress={() => setReviewPage(page => page - 1)}
                    >
                      <Trans>Previous</Trans>
                    </Button>
                    <Text>
                      {t('Page {{page}} of {{pageCount}}', {
                        page: reviewPage + 1,
                        pageCount: reviewPageCount,
                      })}
                    </Text>
                    <Button
                      isDisabled={reviewPage + 1 >= reviewPageCount}
                      onPress={() => setReviewPage(page => page + 1)}
                    >
                      <Trans>Next</Trans>
                    </Button>
                  </View>
                )}
                <ModalButtons>
                  <Button onPress={() => state.close()}>
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button
                    variant="primary"
                    isDisabled={selectedProposalCount === 0}
                    onPress={() => void applySelectedProposals()}
                  >
                    <Trans count={selectedProposalCount}>
                      Apply {{ count: selectedProposalCount }} categories
                    </Trans>
                  </Button>
                </ModalButtons>
              </>
            )}

            {stage === 'applied' && (
              <>
                <Information>
                  <Trans count={appliedTransactionIds.length}>
                    {{ count: appliedTransactionIds.length }} transactions were
                    categorized in one undoable operation.
                    {{ skipped: applySkippedCount }} stale or ineligible rows
                    were skipped.
                  </Trans>
                </Information>
                {appliedTransactionIds.length > 0 && (
                  <View style={{ gap: 8 }}>
                    <Text style={{ fontWeight: 600 }}>
                      <Trans>Optional merchant and category rules</Trans>
                    </Text>
                    <Text style={{ color: theme.pageTextSubdued }}>
                      <Trans>
                        Open Actual's Rule Editor to normalize the imported
                        merchant and reuse its category. No rule is created
                        unless you review and save it.
                      </Trans>
                    </Text>
                    {appliedTransactionIds.slice(0, 20).map(transactionId => {
                      const row = reviewRows.find(
                        item => item.candidate.transactionId === transactionId,
                      );
                      return (
                        <Button
                          key={transactionId}
                          onPress={() => {
                            state.close();
                            onCreateRule([transactionId], true);
                          }}
                          style={{ alignSelf: 'flex-start' }}
                        >
                          {t('Create merchant rule for {{description}}', {
                            description:
                              row?.candidate.description ||
                              row?.candidate.payee ||
                              t('transaction'),
                          })}
                        </Button>
                      );
                    })}
                  </View>
                )}
                <ModalButtons>
                  <Button
                    onPress={() => {
                      undo();
                      state.close();
                    }}
                    isDisabled={appliedTransactionIds.length === 0}
                  >
                    <Trans>Undo batch</Trans>
                  </Button>
                  <Button variant="primary" onPress={() => state.close()}>
                    <Trans>Done</Trans>
                  </Button>
                </ModalButtons>
              </>
            )}

            {error && <Text style={{ color: theme.errorText }}>{error}</Text>}
          </View>
        </>
      )}
    </Modal>
  );
}
