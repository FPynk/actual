export function formatMinorUnits(
  amountMinorUnits: number,
  currencyCode: string,
): string {
  if (!Number.isSafeInteger(amountMinorUnits)) {
    throw new TypeError('The minor-unit amount must be a safe integer.');
  }
  let fractionDigits: number;
  try {
    const resolvedFractionDigits = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).resolvedOptions().maximumFractionDigits;
    if (resolvedFractionDigits === undefined) {
      throw new RangeError('Currency fraction digits are unavailable.');
    }
    fractionDigits = resolvedFractionDigits;
  } catch {
    return `${amountMinorUnits} minor units (${currencyCode || 'unknown currency'})`;
  }
  const sign = amountMinorUnits < 0 ? '-' : '';
  const digits = Math.abs(amountMinorUnits)
    .toString()
    .padStart(fractionDigits + 1, '0');
  if (fractionDigits === 0) return `${sign}${digits} ${currencyCode}`;
  const integerDigits = digits.slice(0, -fractionDigits);
  const decimalDigits = digits.slice(-fractionDigits);
  return `${sign}${integerDigits}.${decimalDigits} ${currencyCode}`;
}
