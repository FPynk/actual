import type {
  PaddleOcrResult,
  ReceiptAmount,
  ReceiptLineItem,
  ReceiptOcrDraft,
  ReceiptOcrLine,
  ReceiptOcrPoint,
} from './types';

const amountPattern =
  /(?<![A-Za-z0-9.,])([$€£])?\s*((?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2})(?=$|[^A-Za-z0-9.,])/;
const datePattern =
  /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/;
const excludedLineItemPattern =
  /\b(?:subtotal|total|tax|change|cash|visa|mastercard|debit|credit|balance)\b/i;

export function createReceiptOcrDraft(
  result: PaddleOcrResult,
): ReceiptOcrDraft {
  const lines = sortReceiptOcrLines(result.items.map(toReceiptOcrLine));
  const transcript = lines.map(line => line.text).join('\n');
  return {
    merchant: findMerchant(lines),
    date: findDate(lines),
    total: findTotal(lines),
    lineItems: findLineItems(lines),
    lines,
    transcript,
    redactedTranscript: redactReceiptText(transcript),
  };
}

export function redactReceiptText(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[redacted email]')
    .replace(
      /\b(?:\+?\d{1,2}[ -]?)?(?:\(?\d{3}\)?[ -]?)\d{3}[ -]?\d{4}\b/g,
      '[redacted phone]',
    )
    .replace(/\b(?:\d[ -]?){11,18}\d\b/g, value => {
      const digits = value.replace(/\D/g, '');
      return `•••• ${digits.slice(-4)}`;
    });
}

function toReceiptOcrLine(
  item: PaddleOcrResult['items'][number],
): ReceiptOcrLine {
  return {
    polygon: item.poly.map(([x, y]) => ({ x, y }) satisfies ReceiptOcrPoint),
    text: item.text.trim(),
    confidence: item.score,
  };
}

function sortReceiptOcrLines(lines: ReceiptOcrLine[]): ReceiptOcrLine[] {
  return lines
    .map((line, index) => ({
      line,
      index,
      y: average(line.polygon.map(point => point.y)),
      x: average(line.polygon.map(point => point.x)),
    }))
    .sort(
      (left, right) =>
        left.y - right.y || left.x - right.x || left.index - right.index,
    )
    .map(({ line }) => line)
    .filter(line => line.text.length > 0);
}

function findMerchant(lines: readonly ReceiptOcrLine[]): string | null {
  return (
    lines
      .slice(0, 5)
      .map(line => line.text)
      .find(
        text =>
          !datePattern.test(text) &&
          !amountPattern.test(text) &&
          /[a-z]/i.test(text),
      ) ?? null
  );
}

function findDate(lines: readonly ReceiptOcrLine[]): string | null {
  return (
    lines
      .map(line => line.text.match(datePattern)?.[0] ?? null)
      .find(Boolean) ?? null
  );
}

function findTotal(lines: readonly ReceiptOcrLine[]): ReceiptAmount | null {
  const total = [...lines]
    .reverse()
    .filter(
      line =>
        /\b(?:grand\s+)?total\b/i.test(line.text) &&
        !/subtotal/i.test(line.text),
    )
    .map(line => findAmount(line.text))
    .find(Boolean);
  return (
    total ??
    [...lines]
      .reverse()
      .map(line => findAmount(line.text))
      .find(Boolean) ??
    null
  );
}

function findLineItems(lines: readonly ReceiptOcrLine[]): ReceiptLineItem[] {
  return lines.flatMap(line => {
    const total = findAmount(line.text);
    if (!total || excludedLineItemPattern.test(line.text)) return [];
    const description = line.text
      .replace(amountPattern, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return description ? [{ description, total }] : [];
  });
}

function findAmount(text: string): ReceiptAmount | null {
  const match = text.match(amountPattern);
  return match
    ? { currency: match[1] ?? null, amount: match[2].replaceAll(',', '') }
    : null;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
