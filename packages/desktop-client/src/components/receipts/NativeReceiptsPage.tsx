import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { amountToInteger, integerToAmount } from '@actual-app/core/shared/util';
import type {
  Receipt,
  ReceiptFieldConfidence,
  ReceiptLineItem,
  ReceiptMatchCandidate,
  ReceiptReviewedDraft,
} from '@actual-app/core/types/receipts';
import { format, isValid, parse, parseISO } from 'date-fns';

import { Page } from '#components/Page';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { createReceiptOcrClient } from '../../receipt-ocr/receiptOcr';
import type {
  ReceiptOcrClient,
  ReceiptOcrCorrection,
  ReceiptOcrDraft,
} from '../../receipt-ocr/types';

type RotationDegrees = 0 | 90 | 180 | 270;
type QueueStatus =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'processing'
  | 'queued'
  | 'saved';

type EditableLineItem = {
  amount: string;
  label: string;
  quantity: string;
};

type ReceiptForm = {
  currency: string;
  fieldConfidence: ReceiptFieldConfidence;
  lineItems: EditableLineItem[];
  merchant: string;
  ocrRevision: string | null;
  parserRevision: string | null;
  paymentHint: string;
  purchaseDate: string;
  purchaseTime: string;
  sourceHash: string | null;
  subtotal: string;
  tax: string;
  tip: string;
  total: string;
  transcript: string;
  warnings: readonly string[];
};

type ReceiptQueueItem = {
  corrections: readonly ReceiptOcrCorrection[];
  error: string | null;
  file: File | null;
  form: ReceiptForm | null;
  id: string;
  name: string;
  previewUrl: string | null;
  rawTranscript: string | null;
  receiptId: string | null;
  rotationDegrees: RotationDegrees;
  status: QueueStatus;
};

const acceptedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maximumQueueSize = 10;
const receiptMetadataFieldStyle = {
  flex: '1 1 180px',
  minHeight: 72,
  minWidth: 0,
};

export function NativeReceiptsPage() {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const [searchParams] = useSearchParams();
  const [budgetId] = useMetadataPref('id');
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const formatSettings = useFormat();
  const decimalPlaces = formatSettings.currency.decimalPlaces;
  const transactionIdFromRoute = searchParams.get('transactionId');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ocrClientRef = useRef<ReceiptOcrClient | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const queueRef = useRef<ReceiptQueueItem[]>([]);
  const [queue, setQueue] = useState<ReceiptQueueItem[]>([]);
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(
    null,
  );
  const [savedReceiptForm, setSavedReceiptForm] = useState<ReceiptForm | null>(
    null,
  );
  const [matchCandidates, setMatchCandidates] = useState<
    readonly ReceiptMatchCandidate[]
  >([]);
  const [selectedTransactionId, setSelectedTransactionId] = useState<
    string | null
  >(null);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingMatches, setIsLoadingMatches] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDeleteReceiptId, setConfirmDeleteReceiptId] = useState<
    string | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  queueRef.current = queue;

  const selectedQueueItem = queue.find(item => item.id === selectedQueueId);
  const selectedReceipt = receipts.find(
    receipt => receipt.id === selectedReceiptId,
  );
  const selectedForm = selectedQueueItem?.form ?? savedReceiptForm;
  const completedCount = queue.filter(item =>
    ['completed', 'saved'].includes(item.status),
  ).length;

  useEffect(() => {
    let isCurrent = true;
    void send('receipts/list')
      .then(result => {
        if (!isCurrent) return;
        setReceipts(currentReceipts =>
          currentReceipts.length === 0
            ? result
            : result.reduce(upsertReceipt, currentReceipts),
        );
        const linkedReceipt = transactionIdFromRoute
          ? result.find(
              receipt => receipt.transactionId === transactionIdFromRoute,
            )
          : undefined;
        if (linkedReceipt) selectSavedReceipt(linkedReceipt);
      })
      .catch(() => {
        if (isCurrent) setError(t('Actual could not load saved receipts.'));
      });
    return () => {
      isCurrent = false;
    };
    // The selected budget is the lifecycle boundary for receipt data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgetId, transactionIdFromRoute, t]);

  useEffect(() => {
    if (activeJobIdRef.current) return;
    const nextItem = queue.find(item => item.status === 'queued');
    if (nextItem) void processQueueItem(nextItem);
    // processQueueItem deliberately owns the single-worker scheduler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  useEffect(
    () => () => {
      activeAbortControllerRef.current?.abort();
      for (const item of queueRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      const ocrClient = ocrClientRef.current;
      ocrClientRef.current = null;
      void ocrClient?.dispose();
    },
    [],
  );

  async function processQueueItem(item: ReceiptQueueItem) {
    if (!item.file || activeJobIdRef.current) return;
    activeJobIdRef.current = item.id;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    updateQueueItem(item.id, { error: null, status: 'processing' });

    let ocrClient: ReceiptOcrClient | null = null;
    try {
      ocrClient =
        ocrClientRef.current ??
        (ocrClientRef.current = createReceiptOcrClient());
      const draft = await ocrClient.extractReceiptText(item.file, {
        budgetCurrency: formatSettings.currency.code,
        dateOrder: dateFormat.toLocaleLowerCase().startsWith('dd')
          ? 'day-first'
          : 'month-first',
        rotationDegrees: item.rotationDegrees,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      updateQueueItem(item.id, {
        corrections: draft.corrections,
        form: draftToReceiptForm(draft, dateFormat, decimalPlaces),
        rawTranscript: draft.rawTranscript,
        status: 'completed',
      });
    } catch {
      if (!abortController.signal.aborted) {
        if (ocrClientRef.current === ocrClient) {
          ocrClientRef.current = null;
          void ocrClient?.dispose();
        }
        updateQueueItem(item.id, {
          error: t('The receipt could not be read. Rotate it or retry.'),
          status: 'failed',
        });
      }
    } finally {
      if (activeJobIdRef.current === item.id) {
        activeJobIdRef.current = null;
        activeAbortControllerRef.current = null;
        setQueue(currentQueue => [...currentQueue]);
      }
    }
  }

  function addFiles(files: readonly File[]) {
    const acceptedFiles: ReceiptQueueItem[] = [];
    let rejectedCount = 0;
    const availableSlots = Math.max(0, maximumQueueSize - queue.length);
    for (const file of files.slice(0, availableSlots)) {
      if (!acceptedImageTypes.has(file.type)) {
        rejectedCount++;
        continue;
      }
      const id = `${Date.now()}-${crypto.randomUUID()}`;
      acceptedFiles.push({
        corrections: [],
        error: null,
        file,
        form: null,
        id,
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        rawTranscript: null,
        receiptId: null,
        rotationDegrees: 0,
        status: 'queued',
      });
    }
    const skippedForQueueLimit = Math.max(0, files.length - availableSlots);
    if (rejectedCount > 0 || skippedForQueueLimit > 0) {
      setError(
        skippedForQueueLimit > 0
          ? t('Only {{count}} receipt images can be queued at once.', {
              count: maximumQueueSize,
            })
          : t(
              '{{count}} file(s) were skipped. Choose JPEG, PNG, or WebP images.',
              {
                count: rejectedCount,
              },
            ),
      );
    } else {
      setError(null);
    }
    if (acceptedFiles.length > 0) {
      setQueue(currentQueue => [...currentQueue, ...acceptedFiles]);
      setSelectedQueueId(acceptedFiles[0].id);
      setSelectedReceiptId(null);
      setSavedReceiptForm(null);
      setMessage(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function updateQueueItem(id: string, changes: Partial<ReceiptQueueItem>) {
    setQueue(currentQueue =>
      currentQueue.map(item =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    );
  }

  function updateSelectedForm(nextForm: ReceiptForm) {
    if (selectedQueueItem) {
      updateQueueItem(selectedQueueItem.id, { form: nextForm });
    } else {
      setSavedReceiptForm(nextForm);
    }
  }

  function cancelQueueItem(item: ReceiptQueueItem) {
    if (item.status === 'processing' && activeJobIdRef.current === item.id) {
      activeAbortControllerRef.current?.abort();
      const ocrClient = ocrClientRef.current;
      ocrClientRef.current = null;
      void ocrClient?.dispose();
    }
    updateQueueItem(item.id, { status: 'cancelled' });
  }

  function retryQueueItem(item: ReceiptQueueItem) {
    updateQueueItem(item.id, { error: null, status: 'queued' });
  }

  function continueQueueItemManually(item: ReceiptQueueItem) {
    updateQueueItem(item.id, {
      error: null,
      form: createEmptyReceiptForm(formatSettings.currency.code),
      rawTranscript: null,
      status: 'completed',
    });
  }

  function rotateQueueItem(item: ReceiptQueueItem, change: -90 | 90) {
    if (!item.file) return;
    if (item.status === 'processing') cancelQueueItem(item);
    const rotationDegrees = ((item.rotationDegrees + change + 360) %
      360) as RotationDegrees;
    updateQueueItem(item.id, {
      corrections: [],
      error: null,
      form: null,
      rawTranscript: null,
      rotationDegrees,
      status: 'queued',
    });
  }

  function removeQueueItem(item: ReceiptQueueItem) {
    if (item.status === 'processing') cancelQueueItem(item);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setQueue(currentQueue =>
      currentQueue.filter(current => current.id !== item.id),
    );
    if (selectedQueueId === item.id) setSelectedQueueId(null);
  }

  function selectSavedReceipt(receipt: Receipt) {
    setSelectedReceiptId(receipt.id);
    setSelectedQueueId(null);
    setSavedReceiptForm(
      reviewedDraftToReceiptForm(receipt, dateFormat, decimalPlaces),
    );
    setConfirmDeleteReceiptId(null);
    setError(null);
    setMessage(null);
    void loadMatchCandidates(receipt);
  }

  async function loadMatchCandidates(receipt: Receipt) {
    if (!budgetId) return;
    setIsLoadingMatches(true);
    setMatchCandidates([]);
    setSelectedTransactionId(null);
    try {
      const result = await send('receipts/match-candidates', {
        expectedBudgetId: budgetId,
        id: receipt.id,
      });
      if ('status' in result) {
        setError(
          t('Receipt matching is stale. Reload the receipt and try again.'),
        );
        return;
      }
      setMatchCandidates(result.candidates);
      const routeCandidate = transactionIdFromRoute
        ? result.candidates.find(
            candidate => candidate.transactionId === transactionIdFromRoute,
          )
        : undefined;
      setSelectedTransactionId(
        routeCandidate?.transactionId ?? result.preselectedTransactionId,
      );
    } catch {
      setError(
        t('Actual could not find transaction matches for this receipt.'),
      );
    } finally {
      setIsLoadingMatches(false);
    }
  }

  async function saveSelectedReceipt() {
    if (!budgetId || !selectedForm) return;
    setError(null);
    setMessage(null);
    setIsSaving(true);
    try {
      const reviewedDraft = receiptFormToReviewedDraft(
        selectedForm,
        dateFormat,
        decimalPlaces,
      );
      const result = await send('receipts/save-reviewed', {
        expectedBudgetId: budgetId,
        expectedFingerprint: selectedReceipt?.fingerprint,
        receipt: reviewedDraft,
        receiptId: selectedReceipt?.id,
      });
      if (result.status === 'stale') {
        setError(t('This receipt changed. Reload it before saving again.'));
        return;
      }
      const savedReceipt = result.receipt;
      setReceipts(currentReceipts =>
        upsertReceipt(currentReceipts, savedReceipt),
      );
      setSavedReceiptForm(
        reviewedDraftToReceiptForm(savedReceipt, dateFormat, decimalPlaces),
      );
      setSelectedReceiptId(savedReceipt.id);
      if (selectedQueueItem) {
        if (selectedQueueItem.previewUrl) {
          URL.revokeObjectURL(selectedQueueItem.previewUrl);
        }
        updateQueueItem(selectedQueueItem.id, {
          file: null,
          previewUrl: null,
          rawTranscript: null,
          receiptId: savedReceipt.id,
          status: 'saved',
        });
        setSelectedQueueId(null);
      }
      setMessage(
        result.status === 'duplicate'
          ? t('This image was already saved. The existing receipt is open.')
          : t('Receipt text saved locally.'),
      );
      await loadMatchCandidates(savedReceipt);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('Actual could not save this receipt.'),
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function attachSelectedReceipt() {
    if (!budgetId || !selectedReceipt || !selectedTransactionId) return;
    const candidate = matchCandidates.find(
      current => current.transactionId === selectedTransactionId,
    );
    if (!candidate) return;
    setError(null);
    setMessage(null);
    try {
      const request = {
        candidateFingerprint: candidate.candidateFingerprint,
        expectedBudgetId: budgetId,
        expectedReceiptFingerprint: selectedReceipt.fingerprint,
        expectedTransactionId: selectedReceipt.transactionId,
        id: selectedReceipt.id,
        transactionId: candidate.transactionId,
      };
      const result = selectedReceipt.transactionId
        ? await send('receipts/reassign', request)
        : await send('receipts/link', request);
      if (result.status === 'stale') {
        setError(
          t('The receipt or transaction changed. Review the matches again.'),
        );
        await loadMatchCandidates(selectedReceipt);
        return;
      }
      if (result.status === 'conflict') {
        setError(
          t('That transaction already has a receipt. Nothing was changed.'),
        );
        return;
      }
      setReceipts(currentReceipts =>
        upsertReceipt(currentReceipts, result.receipt),
      );
      setSelectedReceiptId(result.receipt.id);
      setMessage(
        result.status === 'reassigned'
          ? t('Receipt reassigned.')
          : t('Receipt attached.'),
      );
    } catch {
      setError(t('Actual could not attach this receipt.'));
    }
  }

  async function unlinkSelectedReceipt() {
    if (!budgetId || !selectedReceipt?.transactionId) return;
    setError(null);
    try {
      const result = await send('receipts/unlink', {
        expectedBudgetId: budgetId,
        expectedReceiptFingerprint: selectedReceipt.fingerprint,
        expectedTransactionId: selectedReceipt.transactionId,
        id: selectedReceipt.id,
      });
      if (result.status === 'stale') {
        setError(t('This receipt changed. Reload it before unlinking.'));
        return;
      }
      if (!('receipt' in result)) {
        setError(t('Actual could not unlink this receipt.'));
        return;
      }
      setReceipts(currentReceipts =>
        upsertReceipt(currentReceipts, result.receipt),
      );
      setSelectedReceiptId(result.receipt.id);
      setMessage(t('Receipt unlinked.'));
      await loadMatchCandidates(result.receipt);
    } catch {
      setError(t('Actual could not unlink this receipt.'));
    }
  }

  async function deleteSelectedReceipt() {
    if (!budgetId || !selectedReceipt) return;
    if (confirmDeleteReceiptId !== selectedReceipt.id) {
      setConfirmDeleteReceiptId(selectedReceipt.id);
      return;
    }
    setError(null);
    try {
      const result = await send('receipts/delete', {
        expectedBudgetId: budgetId,
        expectedFingerprint: selectedReceipt.fingerprint,
        id: selectedReceipt.id,
      });
      if (result.status === 'stale') {
        setError(t('This receipt changed. Reload it before deleting.'));
        return;
      }
      setReceipts(currentReceipts =>
        currentReceipts.filter(receipt => receipt.id !== selectedReceipt.id),
      );
      setSelectedReceiptId(null);
      setSavedReceiptForm(null);
      setMatchCandidates([]);
      setConfirmDeleteReceiptId(null);
      setMessage(t('Receipt deleted.'));
    } catch {
      setError(t('Actual could not delete this receipt.'));
    }
  }

  const visibleCandidates = useMemo(() => {
    const search = candidateSearch.trim().toLocaleLowerCase();
    if (!search) return matchCandidates;
    return matchCandidates.filter(candidate =>
      [
        candidate.payee,
        candidate.date,
        candidate.transactionId,
        String(integerToAmount(Math.abs(candidate.amount), decimalPlaces)),
      ].some(value => value?.toLocaleLowerCase().includes(search)),
    );
  }, [candidateSearch, decimalPlaces, matchCandidates]);

  return (
    <Page header={t('Receipts')}>
      <View
        data-testid="native-receipts-page"
        style={{
          alignItems: 'stretch',
          flexShrink: 0,
          gap: 16,
          margin: '20px auto',
          maxWidth: 1180,
          minHeight: '100%',
          padding: '0 16px 32px',
          width: '100%',
        }}
      >
        <Text style={{ color: theme.pageTextSubdued, lineHeight: 1.5 }}>
          <Trans>
            Receipt images are read locally and discarded after review. Only the
            text and fields you approve are saved in this budget. Images are
            never sent to an OCR service.
          </Trans>
        </Text>

        <input
          ref={fileInputRef}
          aria-label={t('Upload receipt images')}
          accept="image/jpeg,image/png,image/webp"
          multiple
          type="file"
          style={{ display: 'none' }}
          onChange={event =>
            addFiles(Array.from(event.currentTarget.files ?? []))
          }
        />
        <View
          data-testid="receipt-upload-dropzone"
          role="region"
          aria-label={t('Receipt image drop area')}
          style={{
            alignItems: 'center',
            backgroundColor: isDragging
              ? theme.tableRowBackgroundHover
              : theme.tableBackground,
            border: `2px dashed ${theme.tableBorder}`,
            borderRadius: 6,
            gap: 6,
            minHeight: 88,
            padding: 12,
            '&:focus-visible': {
              outline: `3px solid ${theme.noticeText}`,
              outlineOffset: 3,
            },
          }}
          onDragEnter={event => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={event => event.preventDefault()}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            setIsDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <Button onPress={() => fileInputRef.current?.click()}>
            <Trans>Choose receipt images</Trans>
          </Button>
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>or drag JPEG, PNG, or WebP images here</Trans>
          </Text>
        </View>

        {queue.length > 0 && (
          <View
            role="region"
            aria-labelledby="receipt-queue-heading"
            style={{ alignItems: 'stretch', flexShrink: 0, gap: 8 }}
          >
            <Text
              id="receipt-queue-heading"
              role="status"
              aria-live="polite"
              style={{ fontWeight: 600 }}
            >
              {t('Receipt queue: {{completed}} of {{total}} completed', {
                completed: completedCount,
                total: queue.length,
              })}
            </Text>
            <View
              aria-label={t('Receipt processing queue')}
              style={{
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 6,
                maxHeight: 300,
                overflowY: 'auto',
              }}
            >
              {!isNarrowWidth && (
                <View
                  aria-hidden="true"
                  style={{
                    alignItems: 'center',
                    color: theme.pageTextSubdued,
                    flexDirection: 'row',
                    fontSize: 12,
                    fontWeight: 600,
                    gap: 8,
                    minHeight: 28,
                    padding: '8px 12px',
                    pointerEvents: 'none',
                  }}
                >
                  <Text style={{ flex: 1, minWidth: 0 }}>
                    <Trans>File name</Trans>
                  </Text>
                  <Text style={{ width: 110 }}>
                    <Trans>Status</Trans>
                  </Text>
                  <Text style={{ minWidth: 60 }}>
                    <Trans>Actions</Trans>
                  </Text>
                </View>
              )}
              {queue.map(item => (
                <View
                  data-testid="receipt-queue-row"
                  key={item.id}
                  style={{
                    alignItems: isNarrowWidth ? 'stretch' : 'center',
                    backgroundColor:
                      selectedQueueId === item.id
                        ? theme.tableRowBackgroundHover
                        : undefined,
                    borderBottom: `1px solid ${theme.tableBorder}`,
                    flexDirection: isNarrowWidth ? 'column' : 'row',
                    flexShrink: 0,
                    gap: 8,
                    minHeight: 44,
                    padding: '6px 12px',
                  }}
                >
                  <View
                    style={{
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <Button
                      variant="bare"
                      aria-pressed={selectedQueueId === item.id}
                      onPress={() => {
                        setSelectedQueueId(item.id);
                        setSelectedReceiptId(null);
                        setSavedReceiptForm(null);
                      }}
                      style={{
                        justifyContent: 'flex-start',
                        minHeight: 44,
                        minWidth: 0,
                        width: '100%',
                      }}
                    >
                      <Text
                        style={{
                          overflow: 'hidden',
                          textAlign: 'left',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.name}
                      </Text>
                    </Button>
                  </View>
                  <Text
                    aria-live="polite"
                    style={{
                      color: theme.pageTextSubdued,
                      width: isNarrowWidth ? undefined : 110,
                    }}
                  >
                    {queueStatusLabel(item.status, t)}
                  </Text>
                  <View
                    style={{
                      alignItems: 'center',
                      display: 'flex',
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      gap: 4,
                      justifyContent: isNarrowWidth ? 'flex-start' : 'flex-end',
                    }}
                  >
                    {item.status === 'processing' && (
                      <Button
                        variant="bare"
                        aria-label={t('Cancel processing {{name}}', {
                          name: item.name,
                        })}
                        style={{ minHeight: 44 }}
                        onPress={() => cancelQueueItem(item)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                    )}
                    {['cancelled', 'failed'].includes(item.status) && (
                      <Button
                        variant="bare"
                        aria-label={t('Retry processing {{name}}', {
                          name: item.name,
                        })}
                        style={{ minHeight: 44 }}
                        onPress={() => retryQueueItem(item)}
                      >
                        <Trans>Retry</Trans>
                      </Button>
                    )}
                    {item.status !== 'processing' && (
                      <Button
                        variant="bare"
                        aria-label={t(
                          'Remove {{name}} from the receipt queue',
                          {
                            name: item.name,
                          },
                        )}
                        style={{ minHeight: 44 }}
                        onPress={() => removeQueueItem(item)}
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {receipts.length > 0 && (
          <View style={{ alignItems: 'stretch', gap: 8 }}>
            <Text style={{ fontWeight: 600 }}>
              <Trans>Saved receipts</Trans>
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {receipts.map(receipt => (
                <Button
                  key={receipt.id}
                  variant={
                    selectedReceiptId === receipt.id ? 'primary' : 'normal'
                  }
                  onPress={() => selectSavedReceipt(receipt)}
                >
                  {receipt.merchant || t('Unidentified receipt')} ·{' '}
                  {receipt.purchaseDate || t('No date')}
                  {receipt.transactionId ? ` · ${t('Attached')}` : ''}
                </Button>
              ))}
            </View>
          </View>
        )}

        {message && (
          <View
            role="status"
            aria-live="polite"
            style={{
              backgroundColor: theme.noticeBackground,
              borderRadius: 6,
              color: theme.noticeText,
              padding: '10px 12px',
            }}
          >
            {message}
          </View>
        )}
        {error && (
          <Text
            role="alert"
            aria-live="assertive"
            style={{ color: theme.errorText }}
          >
            {error}
          </Text>
        )}

        {selectedQueueItem && (
          <QueueImageReview
            item={selectedQueueItem}
            onCancel={() => cancelQueueItem(selectedQueueItem)}
            onContinueManually={() =>
              continueQueueItemManually(selectedQueueItem)
            }
            onRotate={change => rotateQueueItem(selectedQueueItem, change)}
          />
        )}

        {selectedForm && (
          <ReceiptDetailsEditor
            corrections={selectedQueueItem?.corrections ?? []}
            datePlaceholder={dateFormat.toUpperCase()}
            decimalPlaces={decimalPlaces}
            form={selectedForm}
            isProcessing={selectedQueueItem?.status === 'processing'}
            rawTranscript={selectedQueueItem?.rawTranscript ?? null}
            onChange={updateSelectedForm}
          />
        )}

        {selectedForm &&
          (!selectedQueueItem || selectedQueueItem.status === 'completed') && (
            <View style={{ alignItems: 'stretch', flexShrink: 0, gap: 8 }}>
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>
                  Saving stores the reviewed structured receipt fields and OCR
                  transcript in this budget.
                </Trans>
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Button
                  variant="primary"
                  isDisabled={isSaving || !budgetId}
                  onPress={() => void saveSelectedReceipt()}
                >
                  <Trans>Save receipt</Trans>
                </Button>
                {selectedReceipt?.transactionId && (
                  <Button onPress={() => void unlinkSelectedReceipt()}>
                    <Trans>Unlink from transaction</Trans>
                  </Button>
                )}
                {selectedReceipt && (
                  <Button
                    variant="bare"
                    onPress={() => void deleteSelectedReceipt()}
                    style={{ color: theme.errorText }}
                  >
                    {confirmDeleteReceiptId === selectedReceipt.id
                      ? t('Confirm delete receipt')
                      : t('Delete receipt')}
                  </Button>
                )}
              </View>
            </View>
          )}

        {selectedReceipt && (
          <ReceiptMatchReview
            candidates={visibleCandidates}
            candidateSearch={candidateSearch}
            decimalPlaces={decimalPlaces}
            isLoading={isLoadingMatches}
            linkedTransactionId={selectedReceipt.transactionId}
            selectedTransactionId={selectedTransactionId}
            onAttach={() => void attachSelectedReceipt()}
            onCandidateSearchChange={setCandidateSearch}
            onSelectTransaction={setSelectedTransactionId}
          />
        )}
      </View>
    </Page>
  );
}

function QueueImageReview({
  item,
  onCancel,
  onContinueManually,
  onRotate,
}: {
  item: ReceiptQueueItem;
  onCancel: () => void;
  onContinueManually: () => void;
  onRotate: (change: -90 | 90) => void;
}) {
  const { t } = useTranslation();
  return (
    <View
      data-testid="receipt-preview-card"
      role="region"
      aria-labelledby="receipt-preview-heading"
      style={{
        alignItems: 'stretch',
        backgroundColor: theme.tableBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        flexShrink: 0,
        gap: 12,
        padding: 12,
      }}
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 8,
          justifyContent: 'space-between',
        }}
      >
        <Text id="receipt-preview-heading" style={{ fontWeight: 600 }}>
          {item.name}
        </Text>
        <Text aria-live="polite" style={{ color: theme.pageTextSubdued }}>
          {queueStatusLabel(item.status, t)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          variant="bare"
          aria-label={t('Rotate receipt left 90 degrees')}
          isDisabled={item.status === 'processing'}
          style={{ minHeight: 44 }}
          onPress={() => onRotate(-90)}
        >
          <Trans>Rotate left and rerun</Trans>
        </Button>
        <Button
          variant="bare"
          aria-label={t('Rotate receipt right 90 degrees')}
          isDisabled={item.status === 'processing'}
          style={{ minHeight: 44 }}
          onPress={() => onRotate(90)}
        >
          <Trans>Rotate right and rerun</Trans>
        </Button>
        {item.status === 'processing' && (
          <Button variant="bare" style={{ minHeight: 44 }} onPress={onCancel}>
            <Trans>Cancel current receipt</Trans>
          </Button>
        )}
        {['cancelled', 'failed'].includes(item.status) && (
          <Button
            variant="bare"
            style={{ minHeight: 44 }}
            onPress={onContinueManually}
          >
            <Trans>Enter receipt text manually</Trans>
          </Button>
        )}
      </View>
      {item.previewUrl && (
        <img
          alt={t('Receipt preview')}
          src={item.previewUrl}
          style={{
            alignSelf: 'center',
            backgroundColor: theme.tableBackground,
            border: `1px solid ${theme.tableBorder}`,
            maxHeight: 520,
            maxWidth: '100%',
            objectFit: 'contain',
            transform: `rotate(${item.rotationDegrees}deg)`,
            transition: 'transform 150ms ease',
          }}
        />
      )}
      {item.status === 'processing' && (
        <Text role="status">
          <Trans>Reading receipt locally…</Trans>
        </Text>
      )}
      {item.error && (
        <Text role="alert" style={{ color: theme.errorText }}>
          {item.error}
        </Text>
      )}
    </View>
  );
}

function ReceiptDetailsEditor({
  corrections,
  datePlaceholder,
  decimalPlaces,
  form,
  isProcessing,
  rawTranscript,
  onChange,
}: {
  corrections: readonly ReceiptOcrCorrection[];
  datePlaceholder: string;
  decimalPlaces: number;
  form: ReceiptForm;
  isProcessing: boolean;
  rawTranscript: string | null;
  onChange: (form: ReceiptForm) => void;
}) {
  const { t } = useTranslation();
  const { isNarrowWidth } = useResponsive();
  const update = <Field extends keyof ReceiptForm>(
    field: Field,
    value: ReceiptForm[Field],
  ) => onChange({ ...form, [field]: value });

  return (
    <View style={{ alignItems: 'stretch', flexShrink: 0, gap: 12 }}>
      <Text style={{ fontWeight: 600 }}>
        <Trans>Review extracted receipt text</Trans>
      </Text>
      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>
          Check every field before saving. OCR can misread totals, dates, and
          merchant names.
        </Trans>
      </Text>
      <View
        data-testid="receipt-metadata-fields"
        role="group"
        aria-labelledby="receipt-metadata-heading"
        style={{ alignItems: 'stretch', gap: 8 }}
      >
        <Text id="receipt-metadata-heading" style={{ fontWeight: 600 }}>
          <Trans>Receipt details and payment</Trans>
        </Text>
        <View
          style={{
            alignItems: 'stretch',
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(form.fieldConfidence, 'merchant', false, t)}
            label={t('Merchant')}
            value={form.merchant}
            onChange={value => update('merchant', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'purchaseDate',
              false,
              t,
            )}
            label={t('Date')}
            placeholder={datePlaceholder}
            value={form.purchaseDate}
            onChange={value => update('purchaseDate', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'purchaseTime',
              isInvalidReceiptField('purchaseTime', form.purchaseTime),
              t,
            )}
            isInvalid={isInvalidReceiptField('purchaseTime', form.purchaseTime)}
            label={t('Time')}
            placeholder="HH:MM"
            value={form.purchaseTime}
            onChange={value => update('purchaseTime', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'total',
              isInvalidReceiptField('total', form.total),
              t,
            )}
            label={t('Total')}
            inputMode="decimal"
            isInvalid={isInvalidReceiptField('total', form.total)}
            value={form.total}
            onChange={value => update('total', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'currency',
              isInvalidReceiptField('currency', form.currency),
              t,
            )}
            label={t('Currency')}
            isInvalid={isInvalidReceiptField('currency', form.currency)}
            placeholder="USD"
            value={form.currency}
            onChange={value => update('currency', value.toUpperCase())}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'subtotal',
              isInvalidReceiptField('subtotal', form.subtotal),
              t,
            )}
            label={t('Subtotal')}
            inputMode="decimal"
            isInvalid={isInvalidReceiptField('subtotal', form.subtotal)}
            value={form.subtotal}
            onChange={value => update('subtotal', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'tax',
              isInvalidReceiptField('tax', form.tax),
              t,
            )}
            label={t('Tax')}
            inputMode="decimal"
            isInvalid={isInvalidReceiptField('tax', form.tax)}
            value={form.tax}
            onChange={value => update('tax', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'tip',
              isInvalidReceiptField('tip', form.tip),
              t,
            )}
            label={t('Tip')}
            inputMode="decimal"
            isInvalid={isInvalidReceiptField('tip', form.tip)}
            value={form.tip}
            onChange={value => update('tip', value)}
          />
          <ReceiptField
            containerStyle={receiptMetadataFieldStyle}
            hint={receiptFieldHint(
              form.fieldConfidence,
              'paymentHint',
              false,
              t,
            )}
            label={t('Payment hint')}
            value={form.paymentHint}
            onChange={value => update('paymentHint', value)}
          />
        </View>
      </View>

      {form.warnings.length > 0 && (
        <View
          role="alert"
          style={{
            backgroundColor: theme.noticeBackground,
            borderRadius: 4,
            gap: 4,
            padding: 10,
          }}
        >
          <Text style={{ fontWeight: 600 }}>
            <Trans>Check these OCR results</Trans>
          </Text>
          {form.warnings.map((warning, index) => (
            <Text key={`${warning}-${index}`}>{warning}</Text>
          ))}
        </View>
      )}

      {corrections.length > 0 && (
        <View style={{ gap: 4 }}>
          <Text style={{ fontWeight: 600 }}>
            <Trans>Automatic spelling corrections</Trans>
          </Text>
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>
              Only close, high-confidence receipt-word corrections are applied.
              Original OCR text remains visible here for review.
            </Trans>
          </Text>
          {corrections.map((correction, index) => (
            <Text key={`${correction.lineIndex}-${index}`}>
              {correction.original} → {correction.corrected}
            </Text>
          ))}
        </View>
      )}

      {rawTranscript !== null &&
        (corrections.length > 0 || rawTranscript !== form.transcript) && (
          <details>
            <summary>{t('View original OCR text')}</summary>
            <textarea
              aria-label={t('Original OCR text')}
              readOnly
              value={rawTranscript}
              style={{
                backgroundColor: theme.tableBackground,
                border: `1px solid ${theme.formInputBorder}`,
                borderRadius: 4,
                color: theme.tableText,
                marginTop: 8,
                minHeight: 150,
                overflowY: 'auto',
                padding: 8,
                resize: 'vertical',
                width: '100%',
              }}
            />
          </details>
        )}

      <View style={{ alignItems: 'stretch', gap: 8 }}>
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <Text style={{ flex: 1, fontWeight: 600 }}>
            <Trans>Line items</Trans>
          </Text>
          <Button
            variant="bare"
            style={{ minHeight: 44 }}
            onPress={() =>
              update('lineItems', [
                ...form.lineItems,
                { amount: '', label: '', quantity: '' },
              ])
            }
          >
            <Trans>Add line item</Trans>
          </Button>
        </View>
        {form.lineItems.length === 0 && (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>No line items were detected.</Trans>
          </Text>
        )}
        {form.lineItems.length > 0 && !isNarrowWidth && (
          <View
            data-testid="receipt-line-item-header"
            aria-hidden="true"
            style={{
              alignItems: 'center',
              color: theme.pageTextSubdued,
              flexDirection: 'row',
              fontSize: 12,
              fontWeight: 600,
              gap: 8,
              minHeight: 20,
              pointerEvents: 'none',
            }}
          >
            <Text style={{ flex: '1 1 180px', minWidth: 0 }}>
              <Trans>Description</Trans>
            </Text>
            <Text style={{ minWidth: 80, width: 100 }}>
              <Trans>Quantity</Trans>
            </Text>
            <Text style={{ minWidth: 96, width: 120 }}>
              <Trans>Amount</Trans>
            </Text>
            <Text style={{ minWidth: 60 }}>
              <Trans>Actions</Trans>
            </Text>
          </View>
        )}
        {form.lineItems.map((lineItem, index) => (
          <View
            key={index}
            style={{
              alignItems: 'stretch',
              flexDirection: isNarrowWidth ? 'column' : 'row',
              flexShrink: 0,
              flexWrap: isNarrowWidth ? undefined : 'wrap',
              gap: 8,
              minHeight: isNarrowWidth ? 180 : 60,
              padding: '8px 0',
            }}
          >
            <ReceiptField
              containerStyle={{
                flex: isNarrowWidth ? undefined : '1 1 180px',
                minWidth: 0,
              }}
              id={`receipt-line-item-${index}-label`}
              label={t('Description {{number}}', { number: index + 1 })}
              isLabelVisuallyHidden={!isNarrowWidth}
              value={lineItem.label}
              onChange={value =>
                update(
                  'lineItems',
                  replaceLineItem(form.lineItems, index, {
                    ...lineItem,
                    label: value,
                  }),
                )
              }
            />
            <ReceiptField
              containerStyle={{
                flex: isNarrowWidth ? undefined : '0 1 100px',
                minWidth: isNarrowWidth ? 0 : 80,
              }}
              id={`receipt-line-item-${index}-quantity`}
              label={t('Quantity')}
              inputMode="decimal"
              isLabelVisuallyHidden={!isNarrowWidth}
              value={lineItem.quantity}
              onChange={value =>
                update(
                  'lineItems',
                  replaceLineItem(form.lineItems, index, {
                    ...lineItem,
                    quantity: value,
                  }),
                )
              }
            />
            <ReceiptField
              containerStyle={{
                flex: isNarrowWidth ? undefined : '0 1 120px',
                minWidth: isNarrowWidth ? 0 : 96,
              }}
              id={`receipt-line-item-${index}-amount`}
              label={t('Amount')}
              inputMode="decimal"
              isLabelVisuallyHidden={!isNarrowWidth}
              value={lineItem.amount}
              onChange={value =>
                update(
                  'lineItems',
                  replaceLineItem(form.lineItems, index, {
                    ...lineItem,
                    amount: value,
                  }),
                )
              }
            />
            <Button
              variant="bare"
              aria-label={t('Remove line item {{number}}', {
                number: index + 1,
              })}
              style={{
                alignSelf: isNarrowWidth ? 'stretch' : 'flex-end',
                minHeight: 44,
              }}
              onPress={() =>
                update(
                  'lineItems',
                  form.lineItems.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              <Trans>Remove</Trans>
            </Button>
          </View>
        ))}
      </View>

      <label htmlFor="receipt-transcript">
        <Text style={{ fontWeight: 600 }}>
          <Trans>OCR transcript</Trans>
        </Text>
      </label>
      <textarea
        id="receipt-transcript"
        aria-label={t('OCR transcript')}
        value={form.transcript}
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
          minHeight: 260,
          overflowY: 'auto',
          padding: 8,
          resize: 'vertical',
          width: '100%',
        }}
        onChange={event => update('transcript', event.currentTarget.value)}
      />
      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>
          Editing this transcript does not update the structured receipt fields
          above.
        </Trans>
      </Text>
      <Text style={{ color: theme.pageTextSubdued }}>
        {t('Amounts use {{count}} decimal places.', { count: decimalPlaces })}
      </Text>
    </View>
  );
}

function ReceiptMatchReview({
  candidates,
  candidateSearch,
  decimalPlaces,
  isLoading,
  linkedTransactionId,
  selectedTransactionId,
  onAttach,
  onCandidateSearchChange,
  onSelectTransaction,
}: {
  candidates: readonly ReceiptMatchCandidate[];
  candidateSearch: string;
  decimalPlaces: number;
  isLoading: boolean;
  linkedTransactionId: string | null;
  selectedTransactionId: string | null;
  onAttach: () => void;
  onCandidateSearchChange: (value: string) => void;
  onSelectTransaction: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={{ alignItems: 'stretch', gap: 10 }}>
      <Text style={{ fontWeight: 600 }}>
        <Trans>Match to a transaction</Trans>
      </Text>
      {linkedTransactionId && (
        <Text>
          {t('Currently attached to transaction {{transactionId}}.', {
            transactionId: linkedTransactionId,
          })}
        </Text>
      )}
      <Input
        aria-label={t('Search receipt match candidates')}
        placeholder={t('Search by payee, date, amount, or transaction ID')}
        value={candidateSearch}
        onChangeValue={onCandidateSearchChange}
      />
      {isLoading ? (
        <Text role="status">
          <Trans>Finding transaction matches…</Trans>
        </Text>
      ) : candidates.length === 0 ? (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            No eligible nearby transaction matches were found. Check the date
            and total, or save this receipt and match it later.
          </Trans>
        </Text>
      ) : (
        <View
          aria-label={t('Transaction match candidates')}
          style={{
            border: `1px solid ${theme.tableBorder}`,
            borderRadius: 6,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {candidates.map(candidate => (
            <label
              key={candidate.transactionId}
              style={{
                alignItems: 'flex-start',
                borderBottom: `1px solid ${theme.tableBorder}`,
                cursor: 'pointer',
                display: 'flex',
                gap: 10,
                padding: 10,
              }}
            >
              <input
                checked={selectedTransactionId === candidate.transactionId}
                name="receipt-transaction-match"
                type="radio"
                onChange={() => onSelectTransaction(candidate.transactionId)}
              />
              <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                <Text style={{ fontWeight: 600 }}>
                  {candidate.payee || t('Unknown payee')} ·{' '}
                  {integerToAmount(Math.abs(candidate.amount), decimalPlaces)}
                </Text>
                <Text style={{ color: theme.pageTextSubdued }}>
                  {candidate.date} ·{' '}
                  {t('Match score {{score}}', { score: candidate.score })}
                </Text>
                <Text style={{ color: theme.pageTextSubdued }}>
                  {candidate.reasons
                    .map(reason => matchReasonLabel(reason, t))
                    .join(', ')}
                </Text>
              </View>
            </label>
          ))}
        </View>
      )}
      <Button
        variant="primary"
        isDisabled={!selectedTransactionId || isLoading}
        onPress={onAttach}
      >
        {linkedTransactionId ? t('Reassign receipt') : t('Attach receipt')}
      </Button>
    </View>
  );
}

function ReceiptField({
  containerStyle,
  hint,
  id,
  inputMode,
  isInvalid = false,
  label,
  isLabelVisuallyHidden = false,
  placeholder,
  value,
  onChange,
}: {
  containerStyle?: React.CSSProperties;
  hint?: string;
  id?: string;
  inputMode?: 'decimal';
  isInvalid?: boolean;
  label: string;
  isLabelVisuallyHidden?: boolean;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId =
    id ?? `receipt-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <View style={{ alignItems: 'stretch', gap: 4, ...containerStyle }}>
      <label htmlFor={inputId}>
        <Text
          style={{
            fontWeight: 500,
            ...(isLabelVisuallyHidden && {
              height: 1,
              margin: -1,
              overflow: 'hidden',
              padding: 0,
              position: 'absolute',
              width: 1,
            }),
          }}
        >
          {label}
        </Text>
      </label>
      <Input
        aria-describedby={hintId}
        aria-invalid={isInvalid || undefined}
        id={inputId}
        inputMode={inputMode}
        placeholder={placeholder}
        value={value}
        onChangeValue={onChange}
        style={{
          borderColor: isInvalid ? theme.errorText : undefined,
          minHeight: 44,
          textAlign: inputMode === 'decimal' ? 'right' : undefined,
          width: '100%',
        }}
      />
      {hint && (
        <Text
          id={hintId}
          style={{
            color: isInvalid ? theme.errorText : theme.noticeText,
            fontSize: 12,
          }}
        >
          {hint}
        </Text>
      )}
    </View>
  );
}

function receiptFieldHint(
  fieldConfidence: ReceiptFieldConfidence,
  field: keyof ReceiptFieldConfidence,
  isInvalid: boolean,
  t: (value: string) => string,
): string | undefined {
  if (isInvalid) return t('Enter a valid value before saving.');
  if ((fieldConfidence[field] ?? 1) < 0.8) {
    return t('Low confidence from OCR. Please verify this value.');
  }
  return undefined;
}

function isInvalidReceiptField(field: string, value: string): boolean {
  const trimmedValue = value.trim();
  if (!trimmedValue) return false;
  if (field === 'currency') return !/^[A-Za-z]{3}$/.test(trimmedValue);
  if (field === 'purchaseTime') {
    return !/^\d{2}:\d{2}(?::\d{2})?$/.test(trimmedValue);
  }
  if (['total', 'subtotal', 'tax', 'tip'].includes(field)) {
    const amount = Number(trimmedValue.replace(',', '.'));
    return !Number.isFinite(amount) || amount < 0;
  }
  return false;
}

function createEmptyReceiptForm(currency: string): ReceiptForm {
  return {
    currency,
    fieldConfidence: {},
    lineItems: [],
    merchant: '',
    ocrRevision: null,
    parserRevision: null,
    paymentHint: '',
    purchaseDate: '',
    purchaseTime: '',
    sourceHash: null,
    subtotal: '',
    tax: '',
    tip: '',
    total: '',
    transcript: '',
    warnings: [],
  };
}

function draftToReceiptForm(
  draft: ReceiptOcrDraft,
  dateFormat: string,
  decimalPlaces: number,
): ReceiptForm {
  return reviewedDraftToReceiptForm(
    {
      currency: draft.currency,
      fieldConfidence: draft.fieldConfidence,
      lineItems: draft.lineItems,
      merchant: draft.merchant,
      ocrRevision: draft.ocrRevision,
      parserRevision: draft.parserRevision,
      paymentHint: draft.paymentHint,
      purchaseDate: draft.purchaseDate,
      purchaseTime: draft.purchaseTime,
      sourceHash: draft.sourceHash,
      subtotal: draft.subtotal,
      tax: draft.tax,
      tip: draft.tip,
      total: draft.total,
      transcript: draft.redactedTranscript,
      warnings: draft.warnings,
    },
    dateFormat,
    decimalPlaces,
  );
}

function reviewedDraftToReceiptForm(
  draft: ReceiptReviewedDraft,
  dateFormat: string,
  decimalPlaces: number,
): ReceiptForm {
  return {
    currency: draft.currency ?? '',
    fieldConfidence: draft.fieldConfidence,
    lineItems: draft.lineItems.map(item => ({
      amount: minorUnitsToInput(item.amount, decimalPlaces),
      label: item.label,
      quantity: item.quantity === undefined ? '' : String(item.quantity),
    })),
    merchant: draft.merchant ?? '',
    ocrRevision: draft.ocrRevision,
    parserRevision: draft.parserRevision,
    paymentHint: draft.paymentHint ?? '',
    purchaseDate: receiptDateToInput(draft.purchaseDate, dateFormat),
    purchaseTime: draft.purchaseTime ?? '',
    sourceHash: draft.sourceHash,
    subtotal: minorUnitsToInput(draft.subtotal, decimalPlaces),
    tax: minorUnitsToInput(draft.tax, decimalPlaces),
    tip: minorUnitsToInput(draft.tip, decimalPlaces),
    total: minorUnitsToInput(draft.total, decimalPlaces),
    transcript: draft.transcript,
    warnings: draft.warnings,
  };
}

function receiptFormToReviewedDraft(
  form: ReceiptForm,
  dateFormat: string,
  decimalPlaces: number,
): ReceiptReviewedDraft {
  const purchaseDate = inputToReceiptDate(form.purchaseDate, dateFormat);
  const currency = form.currency.trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Currency must be a three-letter code such as USD.');
  }
  if (
    form.purchaseTime &&
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(form.purchaseTime)
  ) {
    throw new Error('Time must use HH:MM or HH:MM:SS.');
  }
  return {
    currency: currency || null,
    fieldConfidence: form.fieldConfidence,
    lineItems: form.lineItems.flatMap((item): ReceiptLineItem[] => {
      const label = item.label.trim();
      if (!label) return [];
      const quantity = item.quantity.trim() ? Number(item.quantity) : undefined;
      if (
        quantity !== undefined &&
        (!Number.isFinite(quantity) || quantity < 0)
      ) {
        throw new Error('Line-item quantities must be positive numbers.');
      }
      const amount = inputToMinorUnits(item.amount, decimalPlaces);
      return [{ amount: amount ?? undefined, label, quantity }];
    }),
    merchant: form.merchant.trim() || null,
    ocrRevision: form.ocrRevision,
    parserRevision: form.parserRevision,
    paymentHint: form.paymentHint.trim() || null,
    purchaseDate,
    purchaseTime: form.purchaseTime.trim() || null,
    sourceHash: form.sourceHash,
    subtotal: inputToMinorUnits(form.subtotal, decimalPlaces),
    tax: inputToMinorUnits(form.tax, decimalPlaces),
    tip: inputToMinorUnits(form.tip, decimalPlaces),
    total: inputToMinorUnits(form.total, decimalPlaces),
    transcript: form.transcript,
    warnings: form.warnings,
  };
}

function receiptDateToInput(value: string | null, dateFormat: string): string {
  if (!value) return '';
  const date = parseISO(value);
  return isValid(date) ? format(date, dateFormat) : value;
}

function inputToReceiptDate(value: string, dateFormat: string): string | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)
    ? parseISO(trimmedValue)
    : parse(trimmedValue, dateFormat, new Date());
  if (!isValid(parsedDate)) {
    throw new Error(`Date must use ${dateFormat.toUpperCase()}.`);
  }
  return format(parsedDate, 'yyyy-MM-dd');
}

function minorUnitsToInput(
  value: number | null | undefined,
  decimalPlaces: number,
): string {
  return value === null || value === undefined
    ? ''
    : integerToAmount(value, decimalPlaces).toFixed(decimalPlaces);
}

function inputToMinorUnits(
  value: string,
  decimalPlaces: number,
): number | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  const amount = Number(trimmedValue.replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Receipt amounts must be positive numbers.');
  }
  return amountToInteger(amount, decimalPlaces);
}

function replaceLineItem(
  lineItems: EditableLineItem[],
  index: number,
  nextItem: EditableLineItem,
): EditableLineItem[] {
  return lineItems.map((item, itemIndex) =>
    itemIndex === index ? nextItem : item,
  );
}

function upsertReceipt(receipts: Receipt[], receipt: Receipt): Receipt[] {
  const existingIndex = receipts.findIndex(
    current => current.id === receipt.id,
  );
  if (existingIndex === -1) return [receipt, ...receipts];
  return receipts.map(current =>
    current.id === receipt.id ? receipt : current,
  );
}

function queueStatusLabel(
  status: QueueStatus,
  t: (value: string) => string,
): string {
  switch (status) {
    case 'cancelled':
      return t('Cancelled');
    case 'completed':
      return t('Completed');
    case 'failed':
      return t('Failed');
    case 'processing':
      return t('Processing');
    case 'queued':
      return t('Queued');
    case 'saved':
      return t('Saved');
  }
}

function matchReasonLabel(
  reason: ReceiptMatchCandidate['reasons'][number],
  t: (value: string) => string,
): string {
  return t(reason.replaceAll('-', ' '));
}
