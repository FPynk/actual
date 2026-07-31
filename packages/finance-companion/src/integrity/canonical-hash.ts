import { createHash } from 'node:crypto';

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

type CanonicalJsonObject = Readonly<{
  [key: string]: CanonicalJsonValue;
}>;

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: CanonicalJsonValue): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Canonical JSON requires safe integers.');
    }
    return JSON.stringify(value);
  }
  if (isCanonicalJsonArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function isCanonicalJsonArray(
  value: CanonicalJsonValue,
): value is readonly CanonicalJsonValue[] {
  return Array.isArray(value);
}

export function calculateBudgetKeyHash(
  actualServerUrl: string,
  actualBudgetId: string,
): string {
  const url = new URL(actualServerUrl);
  const defaultPort =
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443');
  const normalizedOrigin = `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${
    url.port && !defaultPort ? `:${url.port}` : ''
  }`;
  return sha256(
    Buffer.from(
      `finance-companion/budget-binding/v1\0${normalizedOrigin}\0${actualBudgetId}`,
      'utf8',
    ),
  );
}
