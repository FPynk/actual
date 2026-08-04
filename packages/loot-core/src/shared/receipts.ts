import type {
  ReceiptFieldConfidence,
  ReceiptLineItem,
  ReceiptReviewedDraft,
} from '#types/receipts';
import { receiptLimits } from '#types/receipts';

const receiptDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const receiptTimePattern = /^\d{2}:\d{2}(?::\d{2})?$/;
const sourceHashPattern = /^[a-f0-9]{64}$/;
const currencyPattern = /^[A-Z]{3}$/;
const sensitiveNumberPattern = /(?<!\d)(?:\d[ -]?){8,23}\d(?!\d)/g;

export function normalizeReceiptText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function normalizeReceiptMerchant(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const merchant = normalizeReceiptText(value).toLocaleLowerCase();
  return merchant || null;
}

export function redactReceiptSensitiveNumbers(value: string): string {
  return value.replace(sensitiveNumberPattern, '[redacted]');
}

export function validateReceiptReviewedDraft(
  value: unknown,
): ReceiptReviewedDraft {
  if (!isRecord(value)) {
    throw new Error('Receipt must be an object.');
  }

  const merchant = validateOptionalText(value.merchant, receiptLimits.merchant);
  const paymentHint = validatePaymentHint(value.paymentHint);
  const transcript = validateTranscript(value.transcript);
  const warnings = validateWarnings(value.warnings);
  const lineItems = validateLineItems(value.lineItems);

  return {
    currency: validateCurrency(value.currency),
    fieldConfidence: validateFieldConfidence(value.fieldConfidence),
    lineItems,
    merchant:
      merchant === null ? null : redactReceiptSensitiveNumbers(merchant),
    ocrRevision: validateOptionalText(value.ocrRevision, receiptLimits.warning),
    parserRevision: validateOptionalText(
      value.parserRevision,
      receiptLimits.warning,
    ),
    paymentHint,
    purchaseDate: validateDate(value.purchaseDate),
    purchaseTime: validateTime(value.purchaseTime),
    sourceHash: validateSourceHash(value.sourceHash),
    subtotal: validateAmount(value.subtotal),
    tax: validateAmount(value.tax),
    tip: validateAmount(value.tip),
    total: validateAmount(value.total),
    transcript: redactReceiptSensitiveNumbers(transcript),
    warnings,
  };
}

export function canonicalizeReceiptReviewedFields(
  receipt: ReceiptReviewedDraft,
): string {
  return JSON.stringify({
    currency: receipt.currency,
    fieldConfidence: Object.fromEntries(
      Object.entries(receipt.fieldConfidence).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    lineItems: receipt.lineItems.map(item => ({
      amount: item.amount ?? null,
      label: item.label,
      quantity: item.quantity ?? null,
    })),
    merchant: normalizeReceiptMerchant(receipt.merchant),
    ocrRevision: receipt.ocrRevision,
    parserRevision: receipt.parserRevision,
    paymentHint: receipt.paymentHint,
    purchaseDate: receipt.purchaseDate,
    purchaseTime: receipt.purchaseTime,
    sourceHash: receipt.sourceHash,
    subtotal: receipt.subtotal,
    tax: receipt.tax,
    tip: receipt.tip,
    total: receipt.total,
    transcript: receipt.transcript,
    warnings: receipt.warnings,
  });
}

export async function fingerprintReceipt(
  receipt: ReceiptReviewedDraft,
): Promise<string> {
  const data = new TextEncoder().encode(
    canonicalizeReceiptReviewedFields(receipt),
  );
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function validateOptionalText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return validateText(value, limit);
}

function validateRequiredText(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    throw new Error('Receipt text must be a string.');
  }
  return validateText(value, limit);
}

function validateTranscript(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Receipt text must be a string.');
  }
  const transcript = value.normalize('NFKC').replace(/\r\n?/g, '\n');
  if (Array.from(transcript).length > receiptLimits.transcript) {
    throw new Error(
      `Receipt text exceeds its ${receiptLimits.transcript} character limit.`,
    );
  }
  return transcript;
}

function validateText(value: unknown, limit: number): string {
  if (typeof value !== 'string') {
    throw new Error('Receipt text must be a string.');
  }
  const normalized = normalizeReceiptText(value);
  if (Array.from(normalized).length > limit) {
    throw new Error(`Receipt text exceeds its ${limit} character limit.`);
  }
  return normalized;
}

function validatePaymentHint(value: unknown): string | null {
  const paymentHint = validateOptionalText(value, receiptLimits.paymentHint);
  if (paymentHint === null) {
    return null;
  }

  return paymentHint.replace(sensitiveNumberPattern, number => {
    const lastFour = number.replace(/\D/g, '').slice(-4);
    return lastFour ? `•••• ${lastFour}` : '[redacted]';
  });
}

function validateCurrency(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error('Receipt currency must be a string.');
  }
  const currency = value.trim().toUpperCase();
  if (!currencyPattern.test(currency)) {
    throw new Error('Receipt currency must be a three-letter ISO code.');
  }
  return currency;
}

function validateDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidReceiptDate(value)) {
    throw new Error('Receipt date must use YYYY-MM-DD.');
  }
  return value;
}

function validateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidReceiptTime(value)) {
    throw new Error('Receipt time must use HH:MM or HH:MM:SS.');
  }
  return value;
}

function isValidReceiptDate(value: string): boolean {
  if (!receiptDatePattern.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidReceiptTime(value: string): boolean {
  if (!receiptTimePattern.test(value)) {
    return false;
  }
  const [hour, minute, second = 0] = value.split(':').map(Number);
  return hour < 24 && minute < 60 && second < 60;
}

function validateSourceHash(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !sourceHashPattern.test(value)) {
    throw new Error('Receipt source hash must be a SHA-256 digest.');
  }
  return value;
}

function validateAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > receiptLimits.amountMinorUnits
  ) {
    throw new Error(
      'Receipt amount must be a bounded integer number of minor units.',
    );
  }
  return value;
}

function validateFieldConfidence(value: unknown): ReceiptFieldConfidence {
  if (!isRecord(value)) {
    throw new Error('Receipt field confidence must be an object.');
  }
  const confidence: ReceiptFieldConfidence = {};
  for (const [field, score] of Object.entries(value)) {
    if (
      !isReceiptField(field) ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new Error('Receipt field confidence is invalid.');
    }
    confidence[field] = score;
  }
  return confidence;
}

function validateWarnings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > receiptLimits.warnings) {
    throw new Error('Receipt warnings are invalid.');
  }
  return value.map(warning =>
    redactReceiptSensitiveNumbers(
      validateRequiredText(warning, receiptLimits.warning),
    ),
  );
}

function validateLineItems(value: unknown): readonly ReceiptLineItem[] {
  if (!Array.isArray(value) || value.length > receiptLimits.lineItems) {
    throw new Error('Receipt line items are invalid.');
  }

  return value.map(item => {
    if (!isRecord(item)) {
      throw new Error('Receipt line item is invalid.');
    }
    const quantity = validateOptionalQuantity(item.quantity);
    const amount = validateAmount(item.amount);
    return {
      label: redactReceiptSensitiveNumbers(
        validateRequiredText(item.label, receiptLimits.lineItemLabel),
      ),
      ...(amount === null ? {} : { amount }),
      ...(quantity === undefined ? {} : { quantity }),
    };
  });
}

function validateOptionalQuantity(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > receiptLimits.amountMinorUnits
  ) {
    throw new Error('Receipt line item quantity is invalid.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReceiptField(value: string): value is keyof ReceiptFieldConfidence {
  return [
    'merchant',
    'purchaseDate',
    'purchaseTime',
    'currency',
    'total',
    'subtotal',
    'tax',
    'tip',
    'paymentHint',
    'lineItems',
    'transcript',
  ].includes(value);
}
