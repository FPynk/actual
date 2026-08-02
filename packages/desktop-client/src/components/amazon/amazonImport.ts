export type AmazonPurchase = {
  id: string;
  date: string | null;
  amount: number | null;
  currency: string | null;
  kind: 'order' | 'shipment' | 'refund';
  description: string;
};

export type AmazonTransaction = {
  id: string;
  amount: number;
  date: string;
  payee?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  category?: string | null;
  is_parent?: boolean;
};

export type AmazonMatch = {
  purchase: AmazonPurchase;
  transaction: AmazonTransaction | null;
  status: 'ready' | 'review' | 'ambiguous' | 'unmatched';
  reason: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function valueFor(record: JsonRecord, names: string[]) {
  const entry = Object.entries(record).find(([key]) =>
    names.includes(key.replace(/[ _-]/g, '').toLowerCase()),
  );
  return entry?.[1];
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : null;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 100);
  const raw = stringValue(value)?.replace(/,/g, '');
  if (!raw) return null;
  const match = raw.match(/-?\s*(?:[$£€]|USD\s*)?(\d+(?:\.\d{1,2})?)/i);
  return match ? Math.round(Number(match[1]) * 100) : null;
}

function parseDate(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function kindFor(text: string): AmazonPurchase['kind'] {
  if (/refund|returned|return received/i.test(text)) return 'refund';
  if (/shipped|on the way|delivered/i.test(text)) return 'shipment';
  return 'order';
}

function purchaseFromRecord(record: JsonRecord): AmazonPurchase | null {
  const id = stringValue(valueFor(record, ['orderid', 'amazonorderid', 'id']));
  if (!id) return null;
  const description = stringValue(valueFor(record, ['productname', 'title', 'description', 'item'])) ?? `Amazon order ${id}`;
  return {
    id,
    date: parseDate(valueFor(record, ['orderdate', 'date', 'purchasedate'])),
    amount: parseAmount(valueFor(record, ['ordertotal', 'total', 'amount', 'refundamount'])),
    currency: stringValue(valueFor(record, ['currency', 'currencycode'])),
    kind: kindFor(`${description} ${stringValue(valueFor(record, ['status'])) ?? ''}`),
    description,
  };
}

export function parseAmazonJson(contents: string): AmazonPurchase[] {
  const parsed: unknown = JSON.parse(contents);
  const root = asRecord(parsed);
  const records = Array.isArray(parsed)
    ? parsed
    : [root?.orders, root?.Orders, root?.data, root?.items].find(Array.isArray) ?? [];
  return records.map(asRecord).filter((record): record is JsonRecord => record !== null).map(purchaseFromRecord).filter((purchase): purchase is AmazonPurchase => purchase !== null);
}

function decodeQuotedPrintable(value: string) {
  return value.replace(/=\r?\n/g, '').replace(/=([A-F\d]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

function emailText(contents: string) {
  const boundary = contents.match(/boundary=["']?([^"';\s]+)/i)?.[1];
  const parts = boundary ? contents.split(new RegExp(`--${boundary}`)) : [contents];
  return parts.map(part => {
    const [, body = ''] = part.split(/\r?\n\r?\n/, 2);
    const decoded = /content-transfer-encoding:\s*base64/i.test(part) ? atob(body.replace(/\s/g, '')) : /content-transfer-encoding:\s*quoted-printable/i.test(part) ? decodeQuotedPrintable(body) : body;
    return /content-type:\s*text\/html/i.test(part) ? decodeHtml(decoded) : decoded;
  }).join(' ');
}

function labelledValue(text: string, labels: string[]) {
  const label = labels.map(value => value.replace(/ /g, '\\s*')).join('|');
  return text.match(new RegExp(`(?:${label})\\s*[:\\-]?\\s*([^\\n]{1,80})`, 'i'))?.[1]?.trim();
}

export function parseAmazonEmail(contents: string): AmazonPurchase[] {
  const subject = contents.match(/^subject:\s*(.*)$/im)?.[1] ?? '';
  const text = `${subject}\n${emailText(contents)}`;
  const ids = [...text.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)].map(match => match[0]);
  const date = parseDate(labelledValue(text, ['Order placed', 'Ordered on', 'Order date', 'Refund issued']) ?? contents.match(/^date:\s*(.*)$/im)?.[1]);
  const amount = parseAmount(labelledValue(text, ['Order Total', 'Total', 'Refund Total', 'Refund Amount', 'Amount Refunded']));
  const description = labelledValue(text, ['Product Name', 'Item', 'Item name']) ?? subject.replace(/^.*?:\s*/, '').trim() ?? 'Amazon purchase';
  return [...new Set(ids)].map(id => ({ id, date, amount, currency: /\bUSD\b|\$/i.test(text) ? 'USD' : null, kind: kindFor(text), description }));
}

export function matchAmazonPurchases(purchases: AmazonPurchase[], transactions: AmazonTransaction[]): AmazonMatch[] {
  const available = transactions.filter(transaction => !transaction.is_parent);
  return purchases.map(purchase => {
    if (purchase.amount === null || purchase.date === null) return { purchase, transaction: null, status: 'review', reason: 'Missing amount or date' };
    const candidates = available.filter(transaction => (purchase.kind === 'refund' ? transaction.amount > 0 : transaction.amount < 0) && Math.abs(transaction.amount) === purchase.amount).map(transaction => ({ transaction, days: Math.abs((new Date(transaction.date).valueOf() - new Date(purchase.date!).valueOf()) / 86400000), amazon: /amazon/i.test(`${transaction.imported_payee ?? ''} ${transaction.notes ?? ''}`) })).filter(candidate => candidate.days <= 14).sort((a, b) => Number(b.amazon) - Number(a.amazon) || a.days - b.days);
    const best = candidates[0];
    if (!best) return { purchase, transaction: null, status: 'unmatched', reason: 'No matching expense' };
    if (candidates.length > 1 && candidates[1].amazon === best.amazon && candidates[1].days - best.days < 2) return { purchase, transaction: null, status: 'ambiguous', reason: 'More than one equally likely expense' };
    if (best.amazon && best.days <= 7) return { purchase, transaction: best.transaction, status: 'ready', reason: 'Exact amount and nearby Amazon charge' };
    return { purchase, transaction: best.transaction, status: 'review', reason: 'Exact amount; confirm the suggested charge' };
  });
}

export function amazonNote(purchase: AmazonPurchase) {
  return `Amazon ${purchase.kind} ${purchase.id}: ${purchase.description}`;
}
