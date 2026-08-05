import type {
  PaddleOcrResult,
  ReceiptOcrCorrection,
  ReceiptOcrDraft,
  ReceiptOcrLine,
  ReceiptOcrPoint,
} from './types';

const excludedLineItemPattern =
  /\b(?:subtotal|total|tax|change|cash|visa|mastercard|debit|credit|balance)\b/i;
const localeAmountPattern =
  /(?<![A-Za-z0-9])(?:(USD|CAD|AUD|NZD|EUR|GBP|JPY)\s*|([$\u20ac\u00a3\u00a5])\s*)?(\d(?:[\d\s,.']*\d)?(?:[,.]\d{1,2})?)(?![A-Za-z0-9])/gi;
const compactDatePattern =
  /(?<!\d)(\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?=$|[^\d]|\d{1,2}:)/g;
const maxTranscriptCodePoints = 32_000;
const maxWarnings = 32;
const maxMinorUnits = 1_000_000_000_000;
const totalLabelPattern =
  /\b(?:grand\s+total|total|amount\s+due|balance\s+due|balance)\b/gi;
const nonPurchaseTotalContextPattern =
  /\b(?:loyalty|points?|rewards?|fuel|savings?|coupons?|items?)\b/i;
const minimumTotalConfidence = 0.7;

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
  const transcript = redactReceiptText(rawTranscript);
  const transcriptConfidence = average(lines.map(line => line.confidence));
  if (!merchant.value) warnings.add('missing-merchant');
  if (!date.purchaseDate) warnings.add('missing-date');
  if (!total) warnings.add('missing-total');
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
    currency: total?.currency ?? null,
    fieldConfidence: compactConfidence({
      merchant: merchant.confidence,
      purchaseDate: date.confidence,
      currency: total?.currency ? total.confidence : undefined,
      total: total?.confidence,
      transcript: lines.length ? transcriptConfidence : undefined,
    }),
    lineItems: [],
    lines,
    merchant: merchant.value,
    normalizedMerchant: merchant.value?.toLocaleLowerCase() ?? null,
    ocrRevision: 'paddleocr-js',
    parserRevision: 'receipt-parser-v3',
    paymentHint: findPaymentHint(preparedLines.map(value => value.corrected)),
    purchaseDate: date.purchaseDate,
    purchaseTime: null,
    rawTranscript,
    sourceHash: null,
    subtotal: null,
    tax: null,
    tip: null,
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
} {
  for (const value of lines) {
    for (const match of value.corrected.matchAll(compactDatePattern)) {
      const purchaseDate = parseDate(match[1] ?? '', dateOrder, warnings);
      if (!purchaseDate) continue;
      return {
        confidence: value.line.confidence,
        purchaseDate,
      };
    }
  }
  return { confidence: undefined, purchaseDate: null };
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
  for (const [lineIndex, value] of lines.entries()) {
    const totalCandidate = findTotalCandidate(
      value,
      lines[lineIndex + 1],
      budgetCurrency,
      warnings,
    );
    if (totalCandidate) candidates.push(totalCandidate);
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score || right.lineIndex - left.lineIndex,
  );
  const selected = candidates[0] ?? null;
  if (!selected) return null;
  if (
    candidates.some(
      candidate =>
        candidate !== selected &&
        candidate.amount !== selected.amount &&
        candidate.score === selected.score,
    )
  ) {
    warnings.add('ambiguous-total');
    return null;
  }
  return selected;
}

function findTotalCandidate(
  value: PreparedLine,
  nextLine: PreparedLine | undefined,
  budgetCurrency: string | null | undefined,
  warnings: WarningCollector,
):
  | (ParsedAmount & { confidence: number; lineIndex: number; score: number })
  | null {
  if (hasExcludedTotalContext(value.corrected)) return null;
  totalLabelPattern.lastIndex = 0;
  const label = totalLabelPattern.exec(value.corrected);
  if (!label) return null;
  const nearbyAmounts = findMoneyShapedAmounts(value.amountText).filter(
    amount => {
      const distance = Math.max(
        label.index - (amount.start + amount.source.length),
        amount.start - (label.index + label[0].length),
        0,
      );
      return distance <= 16;
    },
  );
  const followingLineAmounts =
    nearbyAmounts.length === 0 &&
    nextLine &&
    !hasExcludedTotalContext(nextLine.corrected)
      ? findMoneyShapedAmounts(nextLine.amountText)
      : [];
  const candidateAmounts = nearbyAmounts.length
    ? nearbyAmounts
    : followingLineAmounts;
  if (candidateAmounts.length !== 1) {
    if (candidateAmounts.length > 1) warnings.add('ambiguous-total');
    return null;
  }
  const confidence = Math.min(
    value.line.confidence,
    nearbyAmounts.length > 0
      ? value.line.confidence
      : (nextLine?.line.confidence ?? value.line.confidence),
  );
  if (confidence < minimumTotalConfidence) {
    warnings.add('low-confidence-total');
    return null;
  }
  const amount = candidateAmounts[0];
  const currency = amount.currency ?? normalizeCurrency(budgetCurrency);
  if (!amount.currency && currency) warnings.add('assumed-currency');
  return {
    ...amount,
    currency,
    confidence,
    lineIndex: value.lineIndex,
    score: totalLabelScore(label[0]),
  };
}

function hasExcludedTotalContext(value: string): boolean {
  return (
    nonPurchaseTotalContextPattern.test(value) ||
    /\b(?:subtotal|tax|tip|change|cash|discount|payment|tender)\b/i.test(value)
  );
}

function findMoneyShapedAmounts(
  text: string,
): Array<ParsedAmount & { start: number }> {
  return [...text.matchAll(localeAmountPattern)].flatMap(match => {
    const amount = parseAmount(match[3] ?? '');
    const source = match[0];
    if (
      !amount ||
      amount.ambiguous ||
      amount.amount <= 0 ||
      (currencyFromToken(match[1] ?? match[2] ?? null) === null &&
        !/[.,]\d{2}(?!\d)/.test(source))
    ) {
      return [];
    }
    return [
      {
        ...amount,
        currency: currencyFromToken(match[1] ?? match[2] ?? null),
        source,
        start: match.index ?? 0,
      },
    ];
  });
}

function totalLabelScore(label: string): number {
  if (/^grand\s+total$/i.test(label)) return 3;
  if (/^(?:amount|balance)\s+due$/i.test(label)) return 2;
  return 1;
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
