import type {
  ReceiptOcrBox,
  ReceiptOcrDraft as PersistableReceiptOcrDraft,
  ReceiptLineItem,
} from '@actual-app/core/types/receipts';

export type ReceiptOcrPoint = {
  x: number;
  y: number;
};

export type ReceiptOcrLine = {
  polygon: readonly ReceiptOcrPoint[];
  text: string;
  confidence: number;
};

export type ReceiptOcrCorrection = {
  corrected: string;
  lineIndex: number;
  original: string;
  reason: 'amount-digit' | 'known-label';
};

export type ReceiptOcrDraft = PersistableReceiptOcrDraft & {
  corrections: readonly ReceiptOcrCorrection[];
  lines: readonly ReceiptOcrLine[];
  rawTranscript: string;
  redactedTranscript: string;
  boxes: readonly ReceiptOcrBox[];
};

export type { ReceiptLineItem };

export type ExtractReceiptTextOptions = {
  budgetCurrency?: string | null;
  dateOrder?: 'day-first' | 'month-first';
  rotationDegrees?: 0 | 90 | 180 | 270;
  signal?: AbortSignal;
};

export type ReceiptOcrEngine = {
  predict(input: ImageBitmap): Promise<readonly PaddleOcrResult[]>;
  dispose(): void | Promise<void>;
};

export type PaddleOcrResult = Pick<OcrResult, 'items'>;

export type ReceiptOcrClient = {
  extractReceiptText(
    file: File,
    options?: ExtractReceiptTextOptions,
  ): Promise<ReceiptOcrDraft>;
  dispose(): Promise<void>;
};
import type { OcrResult } from '@paddleocr/paddleocr-js';
