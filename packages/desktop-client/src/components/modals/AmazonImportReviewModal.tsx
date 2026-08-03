import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { getCurrency } from '@actual-app/core/shared/currencies';
import {
  buildAmazonPaymentSources,
  matchAmazonPayments,
  maximumAmazonImportFileSize,
  parseAmazonEmail,
  parseAmazonJson,
} from '@actual-app/core/shared/finance/amazon';
import type {
  AmazonMatch,
  AmazonMatchReason,
  AmazonOrder,
} from '@actual-app/core/shared/finance/amazon';
import { integerToAmount } from '@actual-app/core/shared/util';
import type { FinanceReviewDecisionRecord } from '@actual-app/core/types/finance';
import type { TFunction } from 'i18next';

import { Modal, ModalButtons, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useCategories } from '#hooks/useCategories';
import { useFormat } from '#hooks/useFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type Props = Extract<ModalType, { name: 'amazon-import-review' }>['options'];
type AmazonReviewDecision = 'deferred' | 'rejected' | 'applied';
type AmazonManualReviewDecision = Exclude<AmazonReviewDecision, 'applied'>;
type AmazonReviewDecisionRecord = FinanceReviewDecisionRecord &
  Readonly<{ decision: AmazonReviewDecision; feature: 'amazon' }>;
type AmazonApplyOptions = Readonly<{
  applyNote: boolean;
  applySplit: boolean;
  categoryIdsByAllocationId: Readonly<Record<string, string | null>>;
}>;
export function AmazonImportReviewModal({ transactions, onApplied }: Props) {
  const { t } = useTranslation();
  const { currency: budgetCurrency } = useFormat();
  const dispatch = useDispatch();
  const { data: { list: categories } = { list: [] } } = useCategories();
  const [orders, setOrders] = useState<readonly AmazonOrder[]>([]);
  const [decisions, setDecisions] = useState<
    readonly AmazonReviewDecisionRecord[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [activeCandidateKey, setActiveCandidateKey] = useState<string | null>(
    null,
  );
  const [applyOptionsByCandidateKey, setApplyOptionsByCandidateKey] = useState<
    Readonly<Record<string, AmazonApplyOptions>>
  >({});
  const latestReadId = useRef(0);
  const latestReviewLoadId = useRef(0);
  const [pendingReplacementOrders, setPendingReplacementOrders] = useState<
    readonly AmazonOrder[] | null
  >(null);

  async function refreshPersistedReview() {
    const loadId = ++latestReviewLoadId.current;
    const [savedOrders, savedDecisions] = await Promise.all([
      send('finance/amazon/get-orders'),
      send('finance/amazon/get-decisions'),
    ]);
    if (loadId !== latestReviewLoadId.current) return;
    setOrders(savedOrders);
    setDecisions(savedDecisions);
  }

  useEffect(() => {
    void refreshPersistedReview().catch(() => {
      setError(t('Saved Amazon review data could not be loaded.'));
    });
  }, [t]);

  const matches = useMemo(() => {
    if (orders.length === 0) return [];
    return matchAmazonPayments(
      buildAmazonPaymentSources(orders),
      transactions,
      budgetCurrency.code,
    );
  }, [budgetCurrency.code, orders, transactions]);
  const decisionsByCandidateKey = useMemo(
    () =>
      new Map(
        decisions.map(decision => [decision.candidateKey, decision] as const),
      ),
    [decisions],
  );

  async function onFile(file: File | undefined) {
    const readId = ++latestReadId.current;
    ++latestReviewLoadId.current;
    setError(null);
    setFileName(file?.name ?? null);
    setIsReading(false);
    setPendingReplacementOrders(null);
    if (file === undefined) return;
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (extension !== '.json' && extension !== '.eml') {
      setError(t('Choose one Amazon .json export or downloaded .eml file.'));
      return;
    }
    if (file.size > maximumAmazonImportFileSize) {
      setError(t('The Amazon file must be 10 MB or smaller.'));
      return;
    }
    setIsReading(true);
    try {
      const contents = await file.text();
      if (readId !== latestReadId.current) return;
      const orders =
        extension === '.json'
          ? parseAmazonJson(contents)
          : parseAmazonEmail(contents);
      const sources = buildAmazonPaymentSources(orders);
      if (sources.length === 0) {
        setError(t('No Amazon charges or refunds were found in this file.'));
        return;
      }
      const result = await send('finance/amazon/save-orders', { orders });
      if (readId !== latestReadId.current) return;
      if (result.status === 'conflict') {
        setPendingReplacementOrders(orders);
        setError(
          t(
            'Saved Amazon data for this order differs. Confirm replacement to use this import.',
          ),
        );
        return;
      }
      setOrders(result.orders);
      const savedDecisions = await send('finance/amazon/get-decisions');
      if (readId !== latestReadId.current) return;
      setDecisions(savedDecisions);
    } catch {
      if (readId === latestReadId.current) {
        setError(
          t(
            'This file could not be read as a supported Amazon JSON export or downloaded .eml message.',
          ),
        );
      }
    } finally {
      if (readId === latestReadId.current) setIsReading(false);
    }
  }

  async function replaceSavedOrders() {
    if (pendingReplacementOrders === null) return;
    setError(null);
    setIsReading(true);
    try {
      const result = await send('finance/amazon/save-orders', {
        orders: pendingReplacementOrders,
        replaceExistingOrderIds: pendingReplacementOrders.map(
          order => order.orderId,
        ),
      });
      if (result.status !== 'saved') {
        setError(t('Saved Amazon data changed. Choose the file again.'));
        return;
      }
      setOrders(result.orders);
      setDecisions(await send('finance/amazon/get-decisions'));
      setPendingReplacementOrders(null);
    } catch {
      setError(t('The saved Amazon data could not be replaced.'));
    } finally {
      setIsReading(false);
    }
  }

  async function recordDecision(
    match: AmazonMatch,
    decision: AmazonManualReviewDecision,
  ) {
    setActiveCandidateKey(match.candidateKey);
    setError(null);
    try {
      await send('finance/amazon/save-decision', {
        candidateKey: match.candidateKey,
        decision,
      });
      await refreshPersistedReview();
    } catch {
      setError(t('The Amazon review decision could not be saved.'));
    } finally {
      setActiveCandidateKey(null);
    }
  }

  async function reopen(match: AmazonMatch) {
    setActiveCandidateKey(match.candidateKey);
    setError(null);
    try {
      await send('finance/amazon/reopen-decision', {
        candidateKey: match.candidateKey,
      });
      await refreshPersistedReview();
    } catch {
      setError(t('The Amazon review could not be reopened.'));
    } finally {
      setActiveCandidateKey(null);
    }
  }

  function getApplyOptions(match: AmazonMatch): AmazonApplyOptions {
    return (
      applyOptionsByCandidateKey[match.candidateKey] ??
      defaultApplyOptions(match)
    );
  }

  function updateApplyOptions(
    match: AmazonMatch,
    update: (current: AmazonApplyOptions) => AmazonApplyOptions,
  ) {
    setApplyOptionsByCandidateKey(current => ({
      ...current,
      [match.candidateKey]: update(
        current[match.candidateKey] ?? defaultApplyOptions(match),
      ),
    }));
  }

  function chooseAllocationCategory(
    match: AmazonMatch,
    allocation: AmazonMatch['source']['allocations'][number],
  ) {
    dispatch(
      pushModal({
        modal: {
          name: 'category-autocomplete',
          options: {
            title: t('Category for {{allocation}}', {
              allocation: allocation.label,
            }),
            showNoneOption: true,
            onSelect: categoryId => {
              updateApplyOptions(match, current => ({
                ...current,
                categoryIdsByAllocationId: {
                  ...current.categoryIdsByAllocationId,
                  [allocation.id]: categoryId,
                },
              }));
            },
          },
        },
      }),
    );
  }

  async function applyReviewedChanges(match: AmazonMatch) {
    if (match.transaction === null) return;
    const options = getApplyOptions(match);
    const hasCategorySelection = Object.values(
      options.categoryIdsByAllocationId,
    ).some(categoryId => categoryId !== null);
    if (!options.applyNote && !options.applySplit && !hasCategorySelection) {
      setError(t('Choose a note, category, or split before applying.'));
      return;
    }

    setActiveCandidateKey(match.candidateKey);
    setError(null);
    try {
      const result = await send('finance/amazon/apply', {
        candidateKey: match.candidateKey,
        evidenceFingerprint: match.evidenceFingerprint,
        transactionId: match.transaction.id,
        ...options,
      });
      if (result.status !== 'applied') {
        await refreshPersistedReview();
        setError(
          t(
            'This Amazon suggestion changed. Review the current transaction before applying it.',
          ),
        );
        return;
      }
      await onApplied();
      await refreshPersistedReview();
    } catch {
      setError(
        t('The reviewed Amazon changes could not be applied to Actual.'),
      );
    } finally {
      setActiveCandidateKey(null);
    }
  }

  return (
    <Modal
      name="amazon-import-review"
      containerProps={{
        style: { width: 760, maxWidth: '90vw', maxHeight: 720 },
      }}
    >
      {({ state }) => (
        <>
          <ModalHeader title={t('Review Amazon purchases')} />
          <View
            style={{
              gap: 12,
              padding: 16,
              overflow: 'auto',
              flexDirection: 'column',
            }}
          >
            <Text>
              <Trans>
                Select one Amazon order JSON export or downloaded order,
                shipment, or refund .eml message. Actual never uploads it or
                connects to your mailbox. It discards the original file and
                saves only compact normalized order, item, shipment, refund, and
                review-decision data in this budget so you can reopen it.
              </Trans>
            </Text>
            <input
              aria-label={t('Amazon file')}
              type="file"
              accept=".json,.eml,message/rfc822,application/json"
              disabled={isReading}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                void onFile(file);
              }}
            />
            {fileName !== null && (
              <Text
                style={{
                  color: theme.pageTextSubdued,
                  overflowWrap: 'anywhere',
                }}
              >
                {fileName}
              </Text>
            )}
            {isReading && (
              <Text>
                <Trans>Reading Amazon file…</Trans>
              </Text>
            )}
            {error !== null && (
              <Text role="alert" style={{ color: theme.errorText }}>
                {error}
              </Text>
            )}
            {pendingReplacementOrders !== null && (
              <Button
                isDisabled={isReading}
                onPress={() => void replaceSavedOrders()}
              >
                <Trans>Replace saved Amazon data</Trans>
              </Button>
            )}
            {matches.map(match => {
              const decision = decisionsByCandidateKey.get(match.candidateKey);
              return (
                <View
                  key={match.candidateKey}
                  style={{
                    padding: 12,
                    border: `1px solid ${theme.tableBorder}`,
                    borderRadius: 4,
                    gap: 6,
                    flexDirection: 'column',
                  }}
                >
                  <View
                    style={{
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                    }}
                  >
                    <Text style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                      {match.source.description}
                    </Text>
                    <FinancialText style={{ fontWeight: 600 }}>
                      {formatSourceAmount(
                        t,
                        match.source.amount,
                        match.source.currency,
                      )}
                    </FinancialText>
                  </View>
                  <Text>
                    {getStatusLabel(t, match.status)} ·{' '}
                    {t('Score: {{score}}', { score: match.score })}
                  </Text>
                  <Text style={{ color: theme.pageTextSubdued }}>
                    {match.source.date} · {match.source.currency} ·{' '}
                    {match.reasons
                      .map(reason => getReasonLabel(t, reason))
                      .join(' · ')}
                  </Text>
                  {match.transaction !== null && (
                    <Text style={{ overflowWrap: 'anywhere' }}>
                      {t('Suggested transaction: {{payee}} on {{date}}', {
                        payee:
                          match.transaction.payee_name ??
                          match.transaction.imported_payee ??
                          t('Unnamed transaction'),
                        date: match.transaction.date,
                      })}
                    </Text>
                  )}
                  {decision != null && (
                    <Text>
                      {t('Review status: {{status}}', {
                        status: getDecisionLabel(t, decision.decision),
                      })}
                    </Text>
                  )}
                  {decision?.decision === 'applied' && (
                    <Text role="status" style={{ color: theme.noticeText }}>
                      <Trans>
                        This review was applied. Undo restores the ledger;
                        Reopen review changes only the review status.
                      </Trans>
                    </Text>
                  )}
                  <View style={{ gap: 3, flexDirection: 'column' }}>
                    {match.source.allocations.map(value => (
                      <View
                        key={value.id}
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                        }}
                      >
                        <Text style={{ overflowWrap: 'anywhere' }}>
                          {value.label} · {getAllocationLabel(t, value.kind)}
                        </Text>
                        <FinancialText>
                          {formatSourceAmount(
                            t,
                            value.amount,
                            match.source.currency,
                          )}
                        </FinancialText>
                      </View>
                    ))}
                  </View>
                  {decision == null ? (
                    <AmazonApplyControls
                      match={match}
                      options={getApplyOptions(match)}
                      categories={categories}
                      isWorking={activeCandidateKey === match.candidateKey}
                      onChooseCategory={chooseAllocationCategory}
                      onOptionsChange={updateApplyOptions}
                      onApply={applyReviewedChanges}
                      onDefer={() => void recordDecision(match, 'deferred')}
                      onReject={() => void recordDecision(match, 'rejected')}
                    />
                  ) : (
                    <Button
                      isDisabled={activeCandidateKey === match.candidateKey}
                      onPress={() => void reopen(match)}
                    >
                      <Trans>Reopen review</Trans>
                    </Button>
                  )}
                </View>
              );
            })}
            <ModalButtons style={{ marginTop: 8 }}>
              <Button onPress={() => state.close()}>
                <Trans>Close</Trans>
              </Button>
            </ModalButtons>
          </View>
        </>
      )}
    </Modal>
  );
}

function defaultApplyOptions(match: AmazonMatch): AmazonApplyOptions {
  return {
    applyNote: true,
    applySplit: match.source.allocations.length > 1,
    categoryIdsByAllocationId: Object.fromEntries(
      match.source.allocations.map(allocation => [allocation.id, null]),
    ),
  };
}

function AmazonApplyControls({
  match,
  options,
  categories,
  isWorking,
  onChooseCategory,
  onOptionsChange,
  onApply,
  onDefer,
  onReject,
}: {
  match: AmazonMatch;
  options: AmazonApplyOptions;
  categories: readonly { id: string; name: string }[];
  isWorking: boolean;
  onChooseCategory: (
    match: AmazonMatch,
    allocation: AmazonMatch['source']['allocations'][number],
  ) => void;
  onOptionsChange: (
    match: AmazonMatch,
    update: (current: AmazonApplyOptions) => AmazonApplyOptions,
  ) => void;
  onApply: (match: AmazonMatch) => void;
  onDefer: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const canApply =
    match.transaction !== null &&
    (match.status === 'ready' || match.status === 'review');
  const hasCategorySelection = Object.values(
    options.categoryIdsByAllocationId,
  ).some(categoryId => categoryId !== null);
  const hasChangesToApply =
    options.applyNote || options.applySplit || hasCategorySelection;

  if (!canApply) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Actual can only apply a confirmed one-to-one transaction match.
          </Trans>
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button isDisabled={isWorking} onPress={onDefer}>
            <Trans>Defer</Trans>
          </Button>
          <Button isDisabled={isWorking} onPress={onReject}>
            <Trans>Reject</Trans>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: 8, flexDirection: 'column' }}>
      <Text style={{ fontWeight: 600 }}>
        <Trans>Apply reviewed changes</Trans>
      </Text>
      <label>
        <input
          checked={options.applyNote}
          disabled={isWorking}
          type="checkbox"
          onChange={event =>
            onOptionsChange(match, current => ({
              ...current,
              applyNote: event.currentTarget.checked,
            }))
          }
        />{' '}
        <Trans>Add Amazon order details to this transaction note</Trans>
      </label>
      {match.source.allocations.map(allocation => {
        const categoryId = options.categoryIdsByAllocationId[allocation.id];
        const categoryName =
          categories.find(category => category.id === categoryId)?.name ??
          t('Uncategorized');
        return (
          <View
            key={allocation.id}
            style={{ alignItems: 'center', flexDirection: 'row', gap: 8 }}
          >
            <Text style={{ flex: 1, overflowWrap: 'anywhere' }}>
              {t('Category for {{allocation}}: {{category}}', {
                allocation: allocation.label,
                category: categoryName,
              })}
            </Text>
            <Button
              variant="bare"
              isDisabled={isWorking}
              onPress={() => onChooseCategory(match, allocation)}
            >
              <Trans>Choose category</Trans>
            </Button>
          </View>
        );
      })}
      {match.source.allocations.length > 1 && (
        <label>
          <input
            checked={options.applySplit}
            disabled={isWorking || hasCategorySelection}
            type="checkbox"
            onChange={event =>
              onOptionsChange(match, current => ({
                ...current,
                applySplit: event.currentTarget.checked,
              }))
            }
          />{' '}
          <Trans>
            Replace this transaction with the balanced allocations above
          </Trans>
        </label>
      )}
      {match.source.allocations.length > 1 && hasCategorySelection && (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Clear allocation categories before applying without a split.
          </Trans>
        </Text>
      )}
      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>
          Applied changes use Actual's normal Undo action in the account page.
        </Trans>
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button isDisabled={isWorking} onPress={onDefer}>
          <Trans>Defer</Trans>
        </Button>
        <Button isDisabled={isWorking} onPress={onReject}>
          <Trans>Reject</Trans>
        </Button>
        <Button
          variant="primary"
          isDisabled={isWorking || !hasChangesToApply}
          onPress={() => onApply(match)}
        >
          <Trans>Apply to transaction</Trans>
        </Button>
      </View>
    </View>
  );
}

function formatSourceAmount(
  t: TFunction,
  amount: number,
  currencyCode: string,
): string {
  const currency = getCurrency(currencyCode);
  if (currency.code !== currencyCode) {
    return t('{{amount}} {{currency}} minor units', {
      amount: new Intl.NumberFormat().format(amount),
      currency: currencyCode,
    });
  }
  const decimalPlaces = currency.decimalPlaces;
  const formattedAmount = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(integerToAmount(amount, decimalPlaces));
  return `${formattedAmount} ${currencyCode}`;
}

function getStatusLabel(t: TFunction, status: AmazonMatch['status']): string {
  if (status === 'ready') return t('Ready for review');
  if (status === 'review') return t('Manual confirmation required');
  if (status === 'ambiguous') return t('Ambiguous match');
  if (status === 'unsupported') return t('Currency mismatch');
  return t('No matching transaction');
}

function getDecisionLabel(
  t: TFunction,
  decision: AmazonReviewDecision,
): string {
  if (decision === 'deferred') return t('Deferred');
  if (decision === 'rejected') return t('Rejected');
  return t('Applied');
}

function getReasonLabel(t: TFunction, reason: AmazonMatchReason): string {
  switch (reason) {
    case 'exact-amount':
      return t('Exact amount');
    case 'nearby-date':
      return t('Nearby date');
    case 'amazon-merchant':
      return t('Amazon merchant');
    case 'merchant-not-confirmed':
      return t('Merchant needs confirmation');
    case 'multiple-targets':
      return t('Multiple possible transactions');
    case 'target-reused':
      return t('Transaction matches more than one Amazon payment');
    case 'unsupported-currency':
      return t('Source currency does not match this budget');
    case 'no-target':
      return t('No exact nearby transaction');
    default:
      return reason;
  }
}

function getAllocationLabel(
  t: TFunction,
  kind: AmazonMatch['source']['allocations'][number]['kind'],
): string {
  if (kind === 'merchandise') return t('Item');
  if (kind === 'tax') return t('Tax');
  if (kind === 'shipping') return t('Shipping');
  if (kind === 'discount') return t('Discount');
  if (kind === 'gift-card') return t('Gift card');
  if (kind === 'refund') return t('Refund');
  return t('Adjustment');
}
