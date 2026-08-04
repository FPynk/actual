import type {
  PaddleOcrResult,
  ReceiptLineItem,
  ReceiptOcrCorrection,
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
const localeAmountPattern =
  /(?<![A-Za-z0-9])(?:(USD|CAD|AUD|NZD|EUR|GBP|JPY)\s*|([$\u20ac\u00a3\u00a5])\s*)?(\d(?:[\d\s,.']*\d)?(?:[,.]\d{1,2})?)(?![A-Za-z0-9])/gi;
const compactDatePattern =
  /(?<!\d)(\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=$|[^\d]|\d{1,2}:)/g;
const maxTranscriptCodePoints = 32_000;
const maxLineItems = 200;
const maxWarnings = 32;
const maxMinorUnits = 1_000_000_000_000;

type ReceiptParserOptions = {
  budgetCurrency?: string | null;
  dateOrder?: 'day-first' | 'month-first';
};

type ParsedAmount = {
  amount: number;
  ambiguous: boolean;
  currency: string | null;
  source: string;
};

export function createReceiptOcrDraft(
  result: PaddleOcrResult,
  options: ReceiptParserOptions = {},
): ReceiptOcrDraft {
  const lines = sortReceiptOcrLines(result.items.map(toReceiptOcrLine));
  const warnings = new WarningCollector();
  const corrections: ReceiptOcrCorrection[] = [];
  const preparedLines = lines.map((line, lineIndex) => {
    const corrected = correctReceiptLabels(line.text);
    if (corrected !== line.text) {
      corrections.push({
        corrected,
        lineIndex,
        original: line.text,
        reason: 'known-label',
      });
    }
    const amountText = correctAmountDigits(corrected);
    if (amountText !== corrected) {
      corrections.push({
        corrected: amountText,
        lineIndex,
        original: corrected,
        reason: 'amount-digit',
      });
    }
    return { amountText, corrected, line, lineIndex };
  });
  const rawTranscript = truncateText(
    lines.map(line => line.text).join('\n'),
    maxTranscriptCodePoints,
    warnings,
    'transcript-truncated',
  );
  const merchant = findParsedMerchant(preparedLines);
  const date = findParsedDate(preparedLines, options.dateOrder, warnings);
  const total = findParsedTotal(
    preparedLines,
    options.budgetCurrency,
    warnings,
  );
  const subtotal = findLabeledAmount(
    preparedLines,
    /\bsubtotal\b/i,
    options.budgetCurrency,
  );
  const tax = findLabeledAmount(
    preparedLines,
    /\btax\b/i,
    options.budgetCurrency,
  );
  const tip = findLabeledAmount(
    preparedLines,
    /\b(?:tip|gratuity)\b/i,
    options.budgetCurrency,
  );
  const parsedItems = findParsedLineItems(preparedLines, warnings);
  const transcript = redactReceiptText(rawTranscript);
  const transcriptConfidence = average(lines.map(line => line.confidence));
  if (!merchant.value) warnings.add('missing-merchant');
  if (!date.purchaseDate) warnings.add('missing-date');
  if (!total) warnings.add('missing-total');
  if (total && total.confidence < 0.7) warnings.add('low-confidence-total');
  if (lines.length > 0 && transcriptConfidence < 0.7)
    warnings.add('low-confidence-ocr');
  return {
    boxes: lines.map(line => ({
      confidence: line.confidence,
      polygon: line.polygon.map(
        point => [point.x, point.y] as [number, number],
      ),
      text: line.text,
    })),
    corrections,
    currency: total?.currency ?? findAnyCurrency(preparedLines),
    fieldConfidence: compactConfidence({
      merchant: merchant.confidence,
      purchaseDate: date.confidence,
      purchaseTime: date.purchaseTime ? date.confidence : undefined,
      currency: total?.currency ? total.confidence : undefined,
      total: total?.confidence,
      subtotal: subtotal?.confidence,
      tax: tax?.confidence,
      tip: tip?.confidence,
      lineItems: parsedItems.length
        ? average(parsedItems.map(item => item.confidence))
        : undefined,
      transcript: lines.length ? transcriptConfidence : undefined,
    }),
    lineItems: parsedItems.map(({ confidence: _confidence, ...item }) => item),
    lines,
    merchant: merchant.value,
    normalizedMerchant: merchant.value?.toLocaleLowerCase() ?? null,
    ocrRevision: 'paddleocr-js',
    parserRevision: 'receipt-parser-v2',
    paymentHint: findPaymentHint(preparedLines.map(value => value.corrected)),
    purchaseDate: date.purchaseDate,
    purchaseTime: date.purchaseTime,
    rawTranscript,
    sourceHash: null,
    subtotal: subtotal?.amount ?? null,
    tax: tax?.amount ?? null,
    tip: tip?.amount ?? null,
    total: total?.amount ?? null,
    transcript,
    redactedTranscript: transcript,
    warnings: warnings.values(),
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

type PreparedLine = {
  amountText: string;
  corrected: string;
  line: ReceiptOcrLine;
  lineIndex: number;
};

function findParsedMerchant(lines: readonly PreparedLine[]): {
  confidence: number | undefined;
  value: string | null;
} {
  for (const value of lines.slice(0, 5)) {
    if (
      /[a-z]/i.test(value.corrected) &&
      !hasDate(value.corrected) &&
      findAmounts(value.amountText).length === 0 &&
      !excludedLineItemPattern.test(value.corrected)
    ) {
      return {
        confidence: value.line.confidence,
        value: truncateText(value.corrected, 256),
      };
    }
  }
  return { confidence: undefined, value: null };
}

function findParsedDate(
  lines: readonly PreparedLine[],
  dateOrder: ReceiptParserOptions['dateOrder'],
  warnings: WarningCollector,
): {
  confidence: number | undefined;
  purchaseDate: string | null;
  purchaseTime: string | null;
} {
  for (const value of lines) {
    for (const match of value.corrected.matchAll(compactDatePattern)) {
      const purchaseDate = parseDate(match[1] ?? '', dateOrder, warnings);
      if (!purchaseDate) continue;
      const textAfterDate = value.corrected.slice(
        (match.index ?? 0) + match[0].length,
      );
      return {
        confidence: value.line.confidence,
        purchaseDate,
        purchaseTime: parseTime(textAfterDate) ?? parseTime(value.corrected),
      };
    }
  }
  return { confidence: undefined, purchaseDate: null, purchaseTime: null };
}

function findParsedTotal(
  lines: readonly PreparedLine[],
  budgetCurrency: string | null | undefined,
  warnings: WarningCollector,
):
  | (ParsedAmount & { confidence: number; lineIndex: number; score: number })
  | null {
  const candidates: Array<
    ParsedAmount & { confidence: number; lineIndex: number; score: number }
  > = [];
  for (const value of lines) {
    if (
      /\b(?:subtotal|tax|tip|change|cash|savings?|discount|coupon|payment|tender)\b/i.test(
        value.corrected,
      )
    )
      continue;
    const labelScore = /\bgrand\s+total\b/i.test(value.corrected)
      ? 100
      : /\btotal\b/i.test(value.corrected)
        ? 90
        : /\b(?:amount|balance)\s+due\b/i.test(value.corrected)
          ? 85
          : 0;
    const amount = findAmounts(value.amountText).at(-1);
    if (!labelScore || !amount) continue;
    if (amount.ambiguous) {
      warnings.add('ambiguous-decimal');
      continue;
    }
    const currency = amount.currency ?? normalizeCurrency(budgetCurrency);
    if (!amount.currency && currency) warnings.add('assumed-currency');
    candidates.push({
      ...amount,
      currency,
      confidence: value.line.confidence,
      lineIndex: value.lineIndex,
      score:
        labelScore +
        Math.round(value.line.confidence * 10) +
        (currency ? 2 : 0),
    });
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score || right.lineIndex - left.lineIndex,
  );
  const selected =
    candidates[0] ?? findLargestPlausibleTotal(lines, budgetCurrency, warnings);
  if (
    selected &&
    candidates.some(
      candidate =>
        candidate !== selected &&
        candidate.amount !== selected.amount &&
        candidate.score >= selected.score - 10,
    )
  )
    warnings.add('conflicting-total-candidates');
  return selected;
}

function findLargestPlausibleTotal(
  lines: readonly PreparedLine[],
  budgetCurrency: string | null | undefined,
  warnings: WarningCollector,
):
  | (ParsedAmount & { confidence: number; lineIndex: number; score: number })
  | null {
  const candidates = lines.flatMap(value => {
    if (
      hasDate(value.corrected) ||
      /\b(?:subtotal|tax|tip|change|cash|savings?|discount|coupon|payment|tender)\b/i.test(
        value.corrected,
      )
    ) {
      return [];
    }
    return findAmounts(value.amountText).flatMap(amount => {
      const hasExplicitMoneyShape =
        /[.,]\d{1,2}(?!\d)/.test(amount.source) || amount.currency !== null;
      if (amount.ambiguous || !hasExplicitMoneyShape || amount.amount <= 0) {
        return [];
      }
      const currency = amount.currency ?? normalizeCurrency(budgetCurrency);
      if (!amount.currency && currency) warnings.add('assumed-currency');
      return [
        {
          ...amount,
          currency,
          confidence: Math.min(0.65, value.line.confidence * 0.7),
          lineIndex: value.lineIndex,
          score:
            Math.round(value.line.confidence * 10) +
            Math.round((value.lineIndex / Math.max(1, lines.length - 1)) * 5),
        },
      ];
    });
  });
  candidates.sort(
    (left, right) =>
      right.amount - left.amount ||
      right.score - left.score ||
      right.lineIndex - left.lineIndex,
  );
  const selected = candidates[0] ?? null;
  if (selected) {
    warnings.add('largest-amount-total-needs-review');
    if (
      candidates.some(
        candidate =>
          candidate !== selected && candidate.amount === selected.amount,
      )
    ) {
      warnings.add('conflicting-total-candidates');
    }
  }
  return selected;
}

function findLabeledAmount(
  lines: readonly PreparedLine[],
  label: RegExp,
  budgetCurrency: string | null | undefined,
): (ParsedAmount & { confidence: number }) | null {
  for (const value of [...lines].reverse()) {
    if (!label.test(value.corrected)) continue;
    const amount = findAmounts(value.amountText).at(-1);
    if (amount && !amount.ambiguous)
      return {
        ...amount,
        currency: amount.currency ?? normalizeCurrency(budgetCurrency),
        confidence: value.line.confidence,
      };
  }
  return null;
}

function findParsedLineItems(
  lines: readonly PreparedLine[],
  warnings: WarningCollector,
): Array<ReceiptLineItem & { confidence: number }> {
  const items: Array<ReceiptLineItem & { confidence: number }> = [];
  for (const value of lines) {
    if (items.length === maxLineItems) {
      warnings.add('line-items-truncated');
      break;
    }
    if (excludedLineItemPattern.test(value.corrected)) continue;
    const amount = findAmounts(value.amountText).at(-1);
    if (!amount || amount.ambiguous) continue;
    const label = value.corrected
      .slice(0, value.amountText.lastIndexOf(amount.source))
      .replace(/[-:.]+\s*$/, '')
      .trim();
    if (!label || !/[\p{L}]/u.test(label)) continue;
    items.push({
      amount: amount.amount,
      confidence: value.line.confidence,
      label: truncateText(label, 256),
    });
  }
  return items;
}

function findAmounts(text: string): ParsedAmount[] {
  return [...text.matchAll(localeAmountPattern)].flatMap(match => {
    const parsed = parseAmount(match[3] ?? '');
    return parsed
      ? [
          {
            ...parsed,
            currency: currencyFromToken(match[1] ?? match[2] ?? null),
            source: match[0],
          },
        ]
      : [];
  });
}

function parseAmount(
  value: string,
): Omit<ParsedAmount, 'currency' | 'source'> | null {
  const compact = value.replace(/[ '\u00a0]/g, '');
  if (!/^\d(?:[\d,.]*\d)?$/.test(compact)) return null;
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  const separatorIndex = Math.max(lastComma, lastDot);
  const fractionLength =
    separatorIndex < 0 ? 0 : compact.length - separatorIndex - 1;
  const ambiguous =
    (lastComma === -1 || lastDot === -1) && fractionLength === 3;
  const hasDecimal = fractionLength > 0 && fractionLength <= 2;
  const integer = (
    hasDecimal ? compact.slice(0, separatorIndex) : compact
  ).replace(/[,.]/g, '');
  const fraction = hasDecimal
    ? compact.slice(separatorIndex + 1).padEnd(2, '0')
    : '00';
  const amount = Number(integer) * 100 + Number(fraction);
  return Number.isSafeInteger(amount) && amount <= maxMinorUnits
    ? { amount, ambiguous }
    : null;
}

function parseDate(
  value: string,
  dateOrder: ReceiptParserOptions['dateOrder'],
  warnings: WarningCollector,
): string | null {
  const numbers = value.split(/[./-]/).map(Number);
  let year: number;
  let month: number;
  let day: number;
  if (/^\d{4}/.test(value)) [year, month, day] = numbers;
  else {
    const [first, second, rawYear] = numbers;
    year =
      rawYear < 100
        ? rawYear >= 70
          ? 1900 + rawYear
          : 2000 + rawYear
        : rawYear;
    if (first <= 12 && second <= 12) {
      warnings.add('ambiguous-date');
      [month, day] =
        dateOrder === 'day-first' ? [second, first] : [first, second];
    } else if (first > 12) [day, month] = [first, second];
    else [month, day] = [first, second];
  }
  if (
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    new Date(Date.UTC(year, month, 0)).getUTCDate() < day
  ) {
    warnings.add('invalid-date');
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function parseTime(value: string): string | null {
  const match = value.match(
    /(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/i,
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? undefined : Number(match[3]);
  if (
    hour > 23 ||
    minute > 59 ||
    (second !== undefined && second > 59) ||
    (hour === 0 && match[4])
  )
    return null;
  if (match[4]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (match[4]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}${second === undefined ? '' : `:${second.toString().padStart(2, '0')}`}`;
}

function correctReceiptLabels(value: string): string {
  return value
    .replace(/\bGRAND\s+T[O0]TAL\b/gi, 'GRAND TOTAL')
    .replace(/\bSUBT[O0]TAL\b/gi, 'SUBTOTAL')
    .replace(/\bT[O0]TAL\b/gi, 'TOTAL')
    .replace(/\bAM[O0]UNT\s+DUE\b/gi, 'AMOUNT DUE');
}

function correctAmountDigits(value: string): string {
  return value
    .replace(/(?<=\d)[OQ](?=[\d.,])/gi, '0')
    .replace(/(?<=[\d.,])[OQ](?=\d)/gi, '0');
}

function findPaymentHint(lines: readonly string[]): string | null {
  const match = lines
    .join('\n')
    .match(
      /\b(visa|mastercard|amex|american express|discover)\b(?:[^\d]{0,24}(\d{4}))?/i,
    );
  return match
    ? match[2]
      ? `${match[1]?.toUpperCase()} •••• ${match[2]}`
      : (match[1]?.toUpperCase() ?? null)
    : null;
}

function findAnyCurrency(lines: readonly PreparedLine[]): string | null {
  return (
    lines
      .flatMap(line => findAmounts(line.amountText))
      .find(amount => amount.currency)?.currency ?? null
  );
}

function currencyFromToken(value: string | null): string | null {
  if (!value) return null;
  if (/^[A-Z]{3}$/i.test(value)) return value.toUpperCase();
  return (
    (
      { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' } as Record<
        string,
        string | undefined
      >
    )[value] ?? null
  );
}

function normalizeCurrency(value: string | null | undefined): string | null {
  return value && /^[A-Z]{3}$/i.test(value) ? value.toUpperCase() : null;
}

function hasDate(value: string): boolean {
  compactDatePattern.lastIndex = 0;
  return compactDatePattern.test(value);
}

function compactConfidence(
  values: Record<string, number | undefined>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([field, confidence]) =>
      confidence === undefined ? [] : [[field, clampConfidence(confidence)]],
    ),
  );
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function average(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function truncateText(
  value: string,
  maximum: number,
  warnings?: WarningCollector,
  warning?: string,
): string {
  const points = Array.from(value.normalize('NFKC'));
  if (points.length <= maximum) return points.join('');
  warnings?.add(warning ?? 'text-truncated');
  return points.slice(0, maximum).join('');
}

class WarningCollector {
  #warnings = new Set<string>();
  add(warning: string): void {
    if (this.#warnings.size < maxWarnings)
      this.#warnings.add(truncateText(warning, 256));
  }
  values(): readonly string[] {
    return [...this.#warnings];
  }
}
