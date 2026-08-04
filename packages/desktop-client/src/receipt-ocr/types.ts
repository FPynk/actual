export type ReceiptOcrPoint = {
  x: number;
  y: number;
};

export type ReceiptOcrLine = {
  polygon: readonly ReceiptOcrPoint[];
  text: string;
  confidence: number;
};

export type ReceiptAmount = {
  amount: string;
  currency: string | null;
};

export type ReceiptLineItem = {
  description: string;
  total: ReceiptAmount | null;
};

export type ReceiptOcrDraft = {
  merchant: string | null;
  date: string | null;
  total: ReceiptAmount | null;
  lineItems: readonly ReceiptLineItem[];
  lines: readonly ReceiptOcrLine[];
  transcript: string;
  redactedTranscript: string;
};

export type ExtractReceiptTextOptions = {
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
