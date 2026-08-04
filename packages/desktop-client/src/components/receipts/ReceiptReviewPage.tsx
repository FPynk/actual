import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Page } from '#components/Page';
import { createReceiptOcrClient } from '../../receipt-ocr/receiptOcr';
import type {
  ReceiptOcrClient,
  ReceiptOcrDraft,
} from '../../receipt-ocr/types';

type RotationDegrees = 0 | 90 | 180 | 270;

const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export function ReceiptReviewPage() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ocrClientRef = useRef<ReceiptOcrClient | null>(null);
  const processingRequestRef = useRef(0);
  const processingAbortControllerRef = useRef<AbortController | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rotationDegrees, setRotationDegrees] = useState<RotationDegrees>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptDraft, setReceiptDraft] = useState<ReceiptOcrDraft | null>(
    null,
  );
  const [merchant, setMerchant] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');
  const [total, setTotal] = useState('');

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(
    () => () => {
      processingAbortControllerRef.current?.abort();
      const ocrClient = ocrClientRef.current;
      ocrClientRef.current = null;
      void ocrClient?.dispose();
    },
    [],
  );

  async function processReceipt(
    file: File,
    nextRotationDegrees: RotationDegrees,
  ) {
    processingAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    processingAbortControllerRef.current = abortController;
    const requestId = ++processingRequestRef.current;
    setIsProcessing(true);
    setError(null);
    let ocrClient: ReceiptOcrClient | null = null;

    try {
      ocrClient =
        ocrClientRef.current ??
        (ocrClientRef.current = createReceiptOcrClient());
      const draft = await ocrClient.extractReceiptText(file, {
        rotationDegrees: nextRotationDegrees,
        signal: abortController.signal,
      });
      if (requestId !== processingRequestRef.current) return;

      setReceiptDraft(draft);
      setMerchant(draft.merchant ?? '');
      setPurchaseDate(draft.date ?? '');
      setTotal(draft.total?.amount ?? '');
    } catch {
      if (
        !abortController.signal.aborted &&
        requestId === processingRequestRef.current
      ) {
        if (ocrClientRef.current === ocrClient) {
          ocrClientRef.current = null;
          void ocrClient?.dispose();
        }
        setReceiptDraft(null);
        setError(
          t(
            'The receipt could not be read. Rotate it or choose another image.',
          ),
        );
      }
    } finally {
      if (requestId === processingRequestRef.current) {
        processingAbortControllerRef.current = null;
        setIsProcessing(false);
      }
    }
  }

  function selectFile(file: File | undefined) {
    if (!file) return;

    if (!acceptedImageTypes.includes(file.type)) {
      setError(t('Choose a JPEG, PNG, or WebP image.'));
      return;
    }

    processingAbortControllerRef.current?.abort();
    const previousOcrClient = ocrClientRef.current;
    ocrClientRef.current = null;
    void previousOcrClient?.dispose();
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRotationDegrees(0);
    setReceiptDraft(null);
    setMerchant('');
    setPurchaseDate('');
    setTotal('');
    void processReceipt(file, 0);
  }

  function rotateReceipt(change: -90 | 90) {
    if (!selectedFile) return;
    const nextRotationDegrees = ((rotationDegrees + change + 360) %
      360) as RotationDegrees;
    setRotationDegrees(nextRotationDegrees);
    void processReceipt(selectedFile, nextRotationDegrees);
  }

  function clearReceipt() {
    processingAbortControllerRef.current?.abort();
    processingAbortControllerRef.current = null;
    const ocrClient = ocrClientRef.current;
    ocrClientRef.current = null;
    void ocrClient?.dispose();
    ++processingRequestRef.current;
    setSelectedFile(null);
    setPreviewUrl(null);
    setRotationDegrees(0);
    setReceiptDraft(null);
    setMerchant('');
    setPurchaseDate('');
    setTotal('');
    setError(null);
    setIsProcessing(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <Page header={t('Review receipt')}>
      <View
        style={{
          alignItems: 'flex-start',
          gap: 16,
          margin: '20px auto',
          maxWidth: 1000,
          width: '100%',
        }}
      >
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Your receipt image stays on this device. It is only used locally to
            extract text for this review. Reviewing does not save it or link it
            to a transaction.
          </Trans>
        </Text>

        <input
          ref={fileInputRef}
          aria-label={t('Upload receipt image')}
          accept="image/jpeg,image/png,image/webp"
          type="file"
          style={{ display: 'none' }}
          onChange={event => selectFile(event.currentTarget.files?.[0])}
        />

        {!selectedFile ? (
          <Button onPress={() => fileInputRef.current?.click()}>
            <Trans>Choose receipt image</Trans>
          </Button>
        ) : (
          <View style={{ alignItems: 'flex-start', gap: 12, width: '100%' }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button onPress={() => fileInputRef.current?.click()}>
                <Trans>Choose another image</Trans>
              </Button>
              <Button
                variant="bare"
                isDisabled={isProcessing}
                onPress={() => rotateReceipt(-90)}
              >
                <Trans>Rotate left</Trans>
              </Button>
              <Button
                variant="bare"
                isDisabled={isProcessing}
                onPress={() => rotateReceipt(90)}
              >
                <Trans>Rotate right</Trans>
              </Button>
              <Button variant="bare" onPress={clearReceipt}>
                <Trans>Cancel</Trans>
              </Button>
            </View>

            <Text style={{ color: theme.pageTextSubdued }}>
              {selectedFile.name}
            </Text>
          </View>
        )}

        {isProcessing && (
          <Text role="status">
            <Trans>Reading receipt locally…</Trans>
          </Text>
        )}
        {error && (
          <Text role="alert" style={{ color: theme.errorText }}>
            {error}
          </Text>
        )}

        {selectedFile && previewUrl && (
          <View
            style={{
              alignItems: 'flex-start',
              gap: 20,
              width: '100%',
              '@media (min-width: 800px)': {
                alignItems: 'stretch',
                flexDirection: 'row',
              },
            }}
          >
            <View style={{ alignItems: 'center', flex: 1, minWidth: 0 }}>
              <img
                alt={t('Receipt preview')}
                src={previewUrl}
                style={{
                  backgroundColor: theme.tableBackground,
                  border: `1px solid ${theme.tableBorder}`,
                  maxHeight: 580,
                  maxWidth: '100%',
                  objectFit: 'contain',
                  transform: `rotate(${rotationDegrees}deg)`,
                  transition: 'transform 150ms ease',
                }}
              />
            </View>

            <ReceiptDetails
              isProcessing={isProcessing}
              merchant={merchant}
              purchaseDate={purchaseDate}
              receiptDraft={receiptDraft}
              total={total}
              onMerchantChange={setMerchant}
              onPurchaseDateChange={setPurchaseDate}
              onTotalChange={setTotal}
            />
          </View>
        )}
      </View>
    </Page>
  );
}

function ReceiptDetails({
  isProcessing,
  merchant,
  purchaseDate,
  receiptDraft,
  total,
  onMerchantChange,
  onPurchaseDateChange,
  onTotalChange,
}: {
  isProcessing: boolean;
  merchant: string;
  purchaseDate: string;
  receiptDraft: ReceiptOcrDraft | null;
  total: string;
  onMerchantChange: (value: string) => void;
  onPurchaseDateChange: (value: string) => void;
  onTotalChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const lines = receiptDraft?.lines ?? [];

  return (
    <View style={{ alignItems: 'stretch', flex: 1, gap: 12, minWidth: 0 }}>
      <ReceiptField
        label={t('Merchant')}
        value={merchant}
        onChange={onMerchantChange}
      />
      <ReceiptField
        label={t('Date')}
        value={purchaseDate}
        onChange={onPurchaseDateChange}
      />
      <ReceiptField label={t('Total')} value={total} onChange={onTotalChange} />

      {receiptDraft?.total?.currency && (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>Currency: {{ currency: receiptDraft.total.currency }}</Trans>
        </Text>
      )}

      <label htmlFor="receipt-transcript">
        <Text style={{ fontWeight: 500 }}>
          <Trans>OCR transcript</Trans>
        </Text>
      </label>
      <textarea
        id="receipt-transcript"
        aria-label={t('OCR transcript')}
        defaultValue={receiptDraft?.transcript ?? ''}
        key={receiptDraft?.transcript ?? 'empty'}
        placeholder={
          isProcessing
            ? t('Text will appear after processing.')
            : t('No text found.')
        }
        style={{
          backgroundColor: theme.tableBackground,
          border: `1px solid ${theme.formInputBorder}`,
          borderRadius: 4,
          color: theme.tableText,
          minHeight: 240,
          overflowY: 'auto',
          padding: 8,
          resize: 'vertical',
          width: '100%',
        }}
      />

      {lines.length > 0 && (
        <View style={{ alignItems: 'stretch', gap: 6 }}>
          <Text style={{ fontWeight: 500 }}>
            <Trans>Raw OCR review</Trans>
          </Text>
          <View
            aria-label={t('Raw OCR lines')}
            style={{
              backgroundColor: theme.tableBackground,
              border: `1px solid ${theme.tableBorder}`,
              borderRadius: 4,
              maxHeight: 180,
              overflowY: 'auto',
              padding: 8,
            }}
          >
            {lines.map((line, index) => (
              <Text key={`${line.text}-${index}`}>
                {line.text}
                {line.confidence !== null && (
                  <span style={{ color: theme.pageTextSubdued }}>
                    {' '}
                    ({formatConfidence(line.confidence)})
                  </span>
                )}
              </Text>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function ReceiptField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `receipt-${label.toLowerCase()}`;
  return (
    <View style={{ alignItems: 'stretch', gap: 4 }}>
      <label htmlFor={id}>
        <Text style={{ fontWeight: 500 }}>{label}</Text>
      </label>
      <Input
        id={id}
        value={value}
        onChangeValue={onChange}
        style={{ width: '100%' }}
      />
    </View>
  );
}

function formatConfidence(confidence: number): string {
  const normalizedConfidence = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(normalizedConfidence)}%`;
}
