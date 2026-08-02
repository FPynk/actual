import React, { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
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
} from '@actual-app/core/shared/finance/amazon';
import { integerToAmount } from '@actual-app/core/shared/util';
import type { TFunction } from 'i18next';

import { Modal, ModalButtons, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';
import type { Modal as ModalType } from '#modals/modalsSlice';

type Props = Extract<ModalType, { name: 'amazon-import-review' }>['options'];

export function AmazonImportReviewModal({ transactions }: Props) {
  const { t } = useTranslation();
  const { currency: budgetCurrency } = useFormat();
  const [matches, setMatches] = useState<readonly AmazonMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const latestReadId = useRef(0);

  async function onFile(file: File | undefined) {
    const readId = ++latestReadId.current;
    setMatches([]);
    setError(null);
    setFileName(file?.name ?? null);
    setIsReading(false);
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
      setMatches(
        matchAmazonPayments(sources, transactions, budgetCurrency.code),
      );
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
                shipment, or refund .eml message. Actual processes it only in
                this window; it is never uploaded or saved, and Actual does not
                connect to your mailbox.
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
            {matches.map(match => (
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
              </View>
            ))}
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
