import { createHash, randomUUID } from 'node:crypto';

import { openCompanionDatabase } from '#database/connection';
import { canonicalJson, sha256 } from '#integrity/canonical-hash';

const MAXIMUM_EXPORT_BYTES = 10 * 1024 * 1024;
const MAXIMUM_EXPORT_RECORDS = 100_000;
const MAXIMUM_SAFE_MINOR_UNITS = 9_007_199_254_740_991;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type AmazonExportParser = Readonly<{
  name: string;
  version: number;
  parse: (bytes: Buffer) => readonly AmazonExportRecord[];
}>;

export type AmazonExportRecord =
  | AmazonOrderRecord
  | AmazonShipmentRecord
  | AmazonItemRecord
  | AmazonRefundRecord;

type BaseRecord = Readonly<{
  sectionName: string;
  recordNumber: number;
  /** Adapter-authored, privacy-safe provenance. Export parsers omit this. */
  sourceRowKey?: string;
}>;
export type AmazonOrderRecord = BaseRecord &
  Readonly<{
    kind: 'order';
    marketplace: string;
    externalOrderId: string;
    orderDate: string;
    currencyCode: string;
    itemSubtotal: number;
    taxTotal: number;
    shippingTotal: number;
    discountTotal: number;
    giftCardTotal: number;
    refundTotal: number;
    orderTotal: number;
  }>;
export type AmazonShipmentRecord = BaseRecord &
  Readonly<{
    kind: 'shipment';
    marketplace: string;
    externalOrderId: string;
    externalShipmentId: string | null;
    shipmentDate: string | null;
    shipmentTotal: number | null;
    orderedItemSignatures: readonly string[];
  }>;
export type AmazonItemRecord = BaseRecord &
  Readonly<{
    kind: 'item';
    marketplace: string;
    externalOrderId: string;
    shipmentKey: string | null;
    externalItemId: string | null;
    asin: string | null;
    sku: string | null;
    seller: string | null;
    title: string;
    quantity: number;
    unitAmount: number;
    taxAmount: number;
    shippingAmount: number;
    discountAmount: number;
    refundAmount: number;
    currencyCode: string;
  }>;
export type AmazonRefundRecord = BaseRecord &
  Readonly<{
    kind: 'refund';
    marketplace: string;
    externalOrderId: string;
    itemKey: string | null;
    externalRefundId: string | null;
    refundDate: string;
    amount: number;
    currencyCode: string;
    reason: string | null;
  }>;

export type ParseAmazonExportRequest = Readonly<{
  sourceNamespaceId: string;
  parser: AmazonExportParser;
  /** Caller-owned, uncompressed bytes; parsing is memory-only and only this hash is retained. */
  bytes: Buffer;
}>;

export type AmazonImportReceipt = Readonly<{
  id: string;
  contentSha256: string;
  parserName: string;
  parserVersion: number;
  status: 'parsing' | 'parsed' | 'applied' | 'failed' | 'discarded';
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errorCode:
    | 'parser_failed'
    | 'currency_mismatch'
    | 'normalization_failed'
    | AmazonConflictReason
    | null;
}>;
export type AmazonConflictReason =
  | 'conflicting_observation'
  | 'ambiguous_identity';
export type AmazonImportResultKind =
  | 'completed'
  | 'completed-with-conflicts'
  | 'failed';
export type ParseAmazonExportResult = Readonly<{
  receipt: AmazonImportReceipt;
  replayed: boolean;
  result: AmazonImportResultKind;
  conflictReason: AmazonConflictReason | null;
}>;
export type AmazonExportFailureInjector = Readonly<{
  afterReceiptPersisted?: () => void;
  duringNormalization?: () => void;
  afterNormalizationCommitted?: () => void;
}>;

export class AmazonExportInterruptedError extends Error {
  constructor() {
    super('The Amazon export processing was interrupted.');
  }
}

type ReceiptRow = Readonly<{
  id: string;
  content_sha256: string;
  parser_name: string;
  parser_version: number;
  status: AmazonImportReceipt['status'];
  row_count: number;
  accepted_count: number;
  rejected_count: number;
  error_code: AmazonImportReceipt['errorCode'];
}>;
type CanonicalOrder = Readonly<{ id: string; currency_code: string }>;
type InBatchCanonicalAliases = Readonly<{
  shipmentIdsBySourceKey: Map<string, string>;
  itemIdsBySourceKey: Map<string, string>;
}>;
type NormalizedBaseRecord = Readonly<{
  sectionName: string;
  recordNumber: number;
  canonicalKey: string;
  sourceRowKey: string;
}>;
type NormalizedAmazonOrderRecord = AmazonOrderRecord & NormalizedBaseRecord;
type NormalizedAmazonShipmentRecord = AmazonShipmentRecord &
  NormalizedBaseRecord;
type NormalizedAmazonItemRecord = AmazonItemRecord & NormalizedBaseRecord;
type NormalizedAmazonRefundRecord = AmazonRefundRecord & NormalizedBaseRecord;
type NormalizedAmazonExportRecord =
  | NormalizedAmazonOrderRecord
  | NormalizedAmazonShipmentRecord
  | NormalizedAmazonItemRecord
  | NormalizedAmazonRefundRecord;
type RecordResult =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'conflict'; reason: AmazonConflictReason }>;

export function createJsonAmazonExportParser(version = 1): AmazonExportParser {
  return { name: 'amazon-export-json', version, parse: parseJsonAmazonExport };
}

/** The supported v1 export is a JSON object with orders, shipments, items, and refunds arrays. */
function parseJsonAmazonExport(bytes: Buffer): readonly AmazonExportRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid Amazon export JSON.');
  }
  if (!isObject(value)) throw new Error('Invalid Amazon export JSON.');
  const records: AmazonExportRecord[] = [];
  for (const [sectionName, kind] of [
    ['orders', 'order'],
    ['shipments', 'shipment'],
    ['items', 'item'],
    ['refunds', 'refunds'],
  ] as const) {
    const section = value[sectionName];
    if (section === undefined) continue;
    if (!Array.isArray(section)) {
      throw new Error('Invalid Amazon export section.');
    }
    section.forEach((row, index) =>
      records.push(
        parseJsonRecord(
          kind === 'refunds' ? 'refund' : kind,
          sectionName,
          index + 1,
          row,
        ),
      ),
    );
  }
  return records;
}

function parseJsonRecord(
  kind: AmazonExportRecord['kind'],
  sectionName: string,
  recordNumber: number,
  value: unknown,
): AmazonExportRecord {
  if (!isObject(value)) throw new Error('Invalid Amazon export record.');
  const parent = {
    sectionName,
    recordNumber,
    marketplace: requiredString(value, 'marketplace'),
    externalOrderId: requiredString(value, 'externalOrderId'),
  };
  if (kind === 'order') {
    return {
      ...parent,
      kind,
      orderDate: requiredString(value, 'orderDate'),
      currencyCode: requiredString(value, 'currencyCode'),
      itemSubtotal: money(value, 'itemSubtotal'),
      taxTotal: money(value, 'taxTotal'),
      shippingTotal: money(value, 'shippingTotal'),
      discountTotal: money(value, 'discountTotal'),
      giftCardTotal: money(value, 'giftCardTotal'),
      refundTotal: money(value, 'refundTotal'),
      orderTotal: money(value, 'orderTotal'),
    };
  }
  if (kind === 'shipment') {
    return {
      ...parent,
      kind,
      externalShipmentId: optionalString(value, 'externalShipmentId'),
      shipmentDate: optionalString(value, 'shipmentDate'),
      shipmentTotal: optionalMoney(value, 'shipmentTotal'),
      orderedItemSignatures: stringArray(value, 'orderedItemSignatures'),
    };
  }
  if (kind === 'item') {
    return {
      ...parent,
      kind,
      shipmentKey: optionalString(value, 'shipmentKey'),
      externalItemId: optionalString(value, 'externalItemId'),
      asin: optionalString(value, 'asin'),
      sku: optionalString(value, 'sku'),
      seller: optionalString(value, 'seller'),
      title: requiredString(value, 'title'),
      quantity: positiveInteger(value, 'quantity'),
      unitAmount: money(value, 'unitAmount'),
      taxAmount: money(value, 'taxAmount'),
      shippingAmount: money(value, 'shippingAmount'),
      discountAmount: money(value, 'discountAmount'),
      refundAmount: money(value, 'refundAmount'),
      currencyCode: requiredString(value, 'currencyCode'),
    };
  }
  return {
    ...parent,
    kind,
    itemKey: optionalString(value, 'itemKey'),
    externalRefundId: optionalString(value, 'externalRefundId'),
    refundDate: requiredString(value, 'refundDate'),
    amount: money(value, 'amount'),
    currencyCode: requiredString(value, 'currencyCode'),
    reason: optionalString(value, 'reason'),
  };
}

export function createSqliteAmazonExportRepository(
  databasePath: string,
  now = () => new Date(),
  failureInjector: AmazonExportFailureInjector = {},
) {
  return {
    parseAmazonExport: (
      request: ParseAmazonExportRequest,
    ): ParseAmazonExportResult =>
      parseAmazonExport(databasePath, request, now, failureInjector),
    parseAmazonEmail: (
      request: ParseAmazonExportRequest,
    ): ParseAmazonExportResult =>
      parseAmazonExport(databasePath, request, now, failureInjector),
  };
}

function parseAmazonExport(
  databasePath: string,
  request: ParseAmazonExportRequest,
  now: () => Date,
  failureInjector: AmazonExportFailureInjector,
): ParseAmazonExportResult {
  validateRequest(request);
  const contentSha256 = sha256(request.bytes);
  const receipt = withDatabase(databasePath, database =>
    database
      .transaction(() => {
        const existing = findReceipt(database, request, contentSha256);
        if (existing !== undefined) {
          if (existing.status === 'discarded') {
            database
              .prepare(
                "UPDATE import_batches SET status = 'parsing', completed_at = NULL, row_count = 0, accepted_count = 0, rejected_count = 0, error_code = NULL WHERE id = ? AND status = 'discarded'",
              )
              .run(existing.id);
            const reopened = findReceiptById(database, existing.id);
            if (reopened === undefined) {
              throw new Error('Discarded Amazon receipt was not reopened.');
            }
            return reopened;
          }
          return existing;
        }
        const id = randomUUID();
        const at = now().toISOString();
        database
          .prepare(
            "INSERT INTO import_batches (id, source_namespace_id, actual_account_id, source_kind, content_sha256, parser_name, parser_version, source_display_name, started_at, completed_at, status, row_count, accepted_count, rejected_count, error_code) VALUES (?, ?, NULL, 'amazon', ?, ?, ?, NULL, ?, NULL, 'parsing', 0, 0, 0, NULL)",
          )
          .run(
            id,
            request.sourceNamespaceId,
            contentSha256,
            request.parser.name,
            request.parser.version,
            at,
          );
        const created = findReceiptById(database, id);
        if (created === undefined) {
          throw new Error('Amazon import receipt was not created.');
        }
        return created;
      })
      .immediate(),
  );
  if (receipt.status !== 'parsing') {
    return toParseResult(toReceipt(receipt), true);
  }
  failureInjector.afterReceiptPersisted?.();
  let records: readonly NormalizedAmazonExportRecord[];
  try {
    records = normalizeParsedRecords(
      parseRecords(request.parser, request.bytes),
    );
  } catch (error) {
    if (error instanceof AmazonExportInterruptedError) throw error;
    return {
      receipt: markFailed(databasePath, receipt.id, 'parser_failed', now),
      replayed: false,
      result: 'failed',
      conflictReason: null,
    };
  }
  try {
    const parsed = normalize(
      databasePath,
      request,
      receipt.id,
      records,
      now,
      failureInjector,
    );
    failureInjector.afterNormalizationCommitted?.();
    return toParseResult(parsed, false);
  } catch (error) {
    if (error instanceof AmazonExportInterruptedError) throw error;
    return {
      receipt: markFailed(
        databasePath,
        receipt.id,
        'normalization_failed',
        now,
      ),
      replayed: false,
      result: 'failed',
      conflictReason: null,
    };
  }
}

function normalize(
  databasePath: string,
  request: ParseAmazonExportRequest,
  receiptId: string,
  records: readonly NormalizedAmazonExportRecord[],
  now: () => Date,
  failureInjector: AmazonExportFailureInjector,
): AmazonImportReceipt {
  return withDatabase(databasePath, database =>
    database
      .transaction(() => {
        const current = findReceiptById(database, receiptId);
        if (current === undefined) {
          throw new Error('Amazon import receipt is missing.');
        }
        if (current.status !== 'parsing') return toReceipt(current);
        const orderKeys = new Map<string, CanonicalOrder>();
        const aliases: InBatchCanonicalAliases = {
          shipmentIdsBySourceKey: new Map(),
          itemIdsBySourceKey: new Map(),
        };
        let accepted = 0;
        let rejected = 0;
        let conflictReason: AmazonConflictReason | null = null;
        for (const record of records) {
          failureInjector.duringNormalization?.();
          const outcome = upsertRecord(
            database,
            request.sourceNamespaceId,
            receiptId,
            record,
            orderKeys,
            aliases,
            now().toISOString(),
          );
          if (outcome.kind === 'accepted') {
            accepted += 1;
          } else {
            rejected += 1;
            if (
              conflictReason === null ||
              outcome.reason === 'ambiguous_identity'
            ) {
              conflictReason = outcome.reason;
            }
          }
        }
        const completedAt = now().toISOString();
        database
          .prepare(
            "UPDATE import_batches SET status = 'parsed', row_count = ?, accepted_count = ?, rejected_count = ?, completed_at = ?, error_code = ? WHERE id = ? AND status = 'parsing'",
          )
          .run(
            records.length,
            accepted,
            rejected,
            completedAt,
            conflictReason,
            receiptId,
          );
        const parsed = findReceiptById(database, receiptId);
        if (parsed === undefined) {
          throw new Error('Amazon import receipt disappeared.');
        }
        return toReceipt(parsed);
      })
      .immediate(),
  );
}

function upsertRecord(
  database: ReturnType<typeof openCompanionDatabase>,
  namespaceId: string,
  receiptId: string,
  record: NormalizedAmazonExportRecord,
  orders: Map<string, CanonicalOrder>,
  aliases: InBatchCanonicalAliases,
  observedAt: string,
): RecordResult {
  const order = findOrder(
    database,
    namespaceId,
    record.marketplace,
    record.externalOrderId,
    orders,
  );
  if (record.kind === 'order') {
    if (order !== undefined) {
      const row = database
        .prepare(
          'SELECT currency_code, order_date, item_subtotal, tax_total, shipping_total, discount_total, gift_card_total, refund_total, order_total FROM amazon_orders WHERE id = ?',
        )
        .get(order.id) as Record<string, unknown>;
      if (!sameOrder(row, record)) {
        return conflictingObservation();
      }
      updateLastObserved(database, 'amazon_orders', order.id, observedAt);
      insertObservation(
        database,
        receiptId,
        record,
        'amazon_order_id',
        order.id,
        observedAt,
      );
      return acceptedRecord();
    }
    const id = randomUUID();
    database
      .prepare(
        'INSERT INTO amazon_orders (id, source_namespace_id, marketplace, external_order_id, order_date, currency_code, item_subtotal, tax_total, shipping_total, discount_total, gift_card_total, refund_total, order_total, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        namespaceId,
        normalizedMarketplace(record.marketplace),
        normalizedIdentifier(record.externalOrderId),
        record.orderDate,
        record.currencyCode,
        record.itemSubtotal,
        record.taxTotal,
        record.shippingTotal,
        record.discountTotal,
        record.giftCardTotal,
        record.refundTotal,
        record.orderTotal,
        observedAt,
        observedAt,
      );
    const created = { id, currency_code: record.currencyCode };
    orders.set(
      orderLookupKey(record.marketplace, record.externalOrderId),
      created,
    );
    insertObservation(
      database,
      receiptId,
      record,
      'amazon_order_id',
      id,
      observedAt,
    );
    return acceptedRecord();
  }
  if (
    order === undefined ||
    (record.kind !== 'shipment' && order.currency_code !== record.currencyCode)
  ) {
    return conflictingObservation();
  }
  if (record.kind === 'shipment') {
    return upsertShipment(
      database,
      receiptId,
      order.id,
      record,
      aliases,
      observedAt,
    );
  }
  if (record.kind === 'item') {
    return upsertItem(
      database,
      receiptId,
      order.id,
      record,
      aliases,
      observedAt,
    );
  }
  return upsertRefund(
    database,
    receiptId,
    order.id,
    record,
    aliases,
    observedAt,
  );
}

function upsertShipment(
  database: ReturnType<typeof openCompanionDatabase>,
  receiptId: string,
  orderId: string,
  record: NormalizedAmazonShipmentRecord,
  aliases: InBatchCanonicalAliases,
  observedAt: string,
): RecordResult {
  const key = record.canonicalKey;
  const existing = database
    .prepare(
      'SELECT id, external_shipment_id, shipment_date, shipment_total FROM amazon_shipments WHERE amazon_order_id = ? AND source_shipment_key = ?',
    )
    .get(orderId, key) as
    | Readonly<{
        id: string;
        external_shipment_id: string | null;
        shipment_date: string | null;
        shipment_total: number | null;
      }>
    | undefined;
  if (
    existing !== undefined &&
    (existing.external_shipment_id !==
      normalizedNullable(record.externalShipmentId) ||
      existing.shipment_date !== record.shipmentDate ||
      existing.shipment_total !== record.shipmentTotal ||
      !hasCompatibleObservation(
        database,
        'amazon_shipment_id',
        existing.id,
        record,
      ))
  ) {
    return conflictingObservation();
  }
  if (existing === undefined && record.externalShipmentId === null) {
    const compatible = findCompatibleExternalShipment(
      database,
      orderId,
      record,
    );
    if (compatible.kind === 'ambiguous') {
      return { kind: 'conflict', reason: 'ambiguous_identity' };
    }
    if (compatible.kind === 'resolved') {
      insertObservation(
        database,
        receiptId,
        record,
        'amazon_shipment_id',
        compatible.id,
        observedAt,
      );
      aliases.shipmentIdsBySourceKey.set(record.canonicalKey, compatible.id);
      return acceptedRecord();
    }
  }
  const id = existing?.id ?? randomUUID();
  if (existing === undefined) {
    database
      .prepare(
        'INSERT INTO amazon_shipments (id, amazon_order_id, source_shipment_key, external_shipment_id, shipment_date, shipment_total) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        orderId,
        key,
        normalizedNullable(record.externalShipmentId),
        record.shipmentDate,
        record.shipmentTotal,
      );
  }
  insertObservation(
    database,
    receiptId,
    record,
    'amazon_shipment_id',
    id,
    observedAt,
  );
  aliases.shipmentIdsBySourceKey.set(record.canonicalKey, id);
  return acceptedRecord();
}

function upsertItem(
  database: ReturnType<typeof openCompanionDatabase>,
  receiptId: string,
  orderId: string,
  record: NormalizedAmazonItemRecord,
  aliases: InBatchCanonicalAliases,
  observedAt: string,
): RecordResult {
  const key = record.canonicalKey;
  const shipmentId =
    record.shipmentKey === null
      ? null
      : findShipmentId(database, orderId, record.shipmentKey, aliases);
  if (record.shipmentKey !== null && shipmentId === undefined) {
    return conflictingObservation();
  }
  const existing = database
    .prepare(
      'SELECT id, amazon_shipment_id, external_item_id, title, quantity, unit_amount, tax_amount, shipping_amount, discount_amount, refund_amount FROM amazon_items WHERE amazon_order_id = ? AND source_item_key = ?',
    )
    .get(orderId, key) as Record<string, unknown> | undefined;
  if (
    existing !== undefined &&
    (!sameItem(existing, record, shipmentId ?? null) ||
      !hasCompatibleObservation(
        database,
        'amazon_item_id',
        String(existing.id),
        record,
      ))
  ) {
    return conflictingObservation();
  }
  if (existing === undefined && record.externalItemId === null) {
    const compatible = findCompatibleExternalItem(
      database,
      orderId,
      shipmentId ?? null,
      record,
    );
    if (compatible.kind === 'ambiguous') {
      return { kind: 'conflict', reason: 'ambiguous_identity' };
    }
    if (compatible.kind === 'resolved') {
      insertObservation(
        database,
        receiptId,
        record,
        'amazon_item_id',
        compatible.id,
        observedAt,
      );
      aliases.itemIdsBySourceKey.set(record.canonicalKey, compatible.id);
      return acceptedRecord();
    }
  }
  const id = typeof existing?.id === 'string' ? existing.id : randomUUID();
  if (existing === undefined) {
    database
      .prepare(
        'INSERT INTO amazon_items (id, amazon_order_id, amazon_shipment_id, source_item_key, external_item_id, title, quantity, unit_amount, tax_amount, shipping_amount, discount_amount, refund_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        orderId,
        shipmentId ?? null,
        key,
        normalizedNullable(record.externalItemId),
        normalizedTitle(record.title),
        record.quantity,
        record.unitAmount,
        record.taxAmount,
        record.shippingAmount,
        record.discountAmount,
        record.refundAmount,
      );
  }
  insertObservation(
    database,
    receiptId,
    record,
    'amazon_item_id',
    id,
    observedAt,
  );
  aliases.itemIdsBySourceKey.set(record.canonicalKey, id);
  return acceptedRecord();
}

function upsertRefund(
  database: ReturnType<typeof openCompanionDatabase>,
  receiptId: string,
  orderId: string,
  record: NormalizedAmazonRefundRecord,
  aliases: InBatchCanonicalAliases,
  observedAt: string,
): RecordResult {
  const key = record.canonicalKey;
  const itemId =
    record.itemKey === null
      ? null
      : findItemId(database, orderId, record.itemKey, aliases);
  if (record.itemKey !== null && itemId === undefined) {
    return conflictingObservation();
  }
  const existing = database
    .prepare(
      'SELECT id, amazon_item_id, external_refund_id, refund_date, amount FROM amazon_refunds WHERE amazon_order_id = ? AND source_refund_key = ?',
    )
    .get(orderId, key) as Record<string, unknown> | undefined;
  if (
    existing !== undefined &&
    (existing.amazon_item_id !== itemId ||
      existing.external_refund_id !==
        normalizedNullable(record.externalRefundId) ||
      existing.refund_date !== record.refundDate ||
      existing.amount !== record.amount ||
      !hasCompatibleObservation(
        database,
        'amazon_refund_id',
        String(existing.id),
        record,
      ))
  ) {
    return conflictingObservation();
  }
  if (existing === undefined && record.externalRefundId === null) {
    const compatible = findCompatibleExternalRefund(
      database,
      orderId,
      itemId ?? null,
      record,
    );
    if (compatible.kind === 'ambiguous') {
      return { kind: 'conflict', reason: 'ambiguous_identity' };
    }
    if (compatible.kind === 'resolved') {
      insertObservation(
        database,
        receiptId,
        record,
        'amazon_refund_id',
        compatible.id,
        observedAt,
      );
      return acceptedRecord();
    }
  }
  const id = typeof existing?.id === 'string' ? existing.id : randomUUID();
  if (existing === undefined) {
    database
      .prepare(
        'INSERT INTO amazon_refunds (id, amazon_order_id, amazon_item_id, source_refund_key, external_refund_id, refund_date, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        orderId,
        itemId,
        key,
        normalizedNullable(record.externalRefundId),
        record.refundDate,
        record.amount,
      );
  }
  insertObservation(
    database,
    receiptId,
    record,
    'amazon_refund_id',
    id,
    observedAt,
  );
  return acceptedRecord();
}

function insertObservation(
  database: ReturnType<typeof openCompanionDatabase>,
  receiptId: string,
  record: NormalizedAmazonExportRecord,
  foreignKey:
    | 'amazon_order_id'
    | 'amazon_shipment_id'
    | 'amazon_item_id'
    | 'amazon_refund_id',
  entityId: string,
  observedAt: string,
): void {
  database
    .prepare(
      `INSERT INTO amazon_source_observations (id, import_batch_id, source_row_key, ${foreignKey}, source_payload_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      receiptId,
      record.sourceRowKey,
      entityId,
      sourcePayloadHash(record),
      observedAt,
    );
}

function recordPayload(
  record: NormalizedAmazonExportRecord,
): Parameters<typeof canonicalJson>[0] {
  const {
    sectionName: _sectionName,
    recordNumber: _recordNumber,
    sourceRowKey: _sourceRowKey,
    ...payload
  } = record;
  return payload;
}

function acceptedRecord(): RecordResult {
  return { kind: 'accepted' };
}

function conflictingObservation(): RecordResult {
  return { kind: 'conflict', reason: 'conflicting_observation' };
}

type CompatibleResolution =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'resolved'; id: string }>
  | Readonly<{ kind: 'ambiguous' }>;

function findCompatibleExternalShipment(
  database: ReturnType<typeof openCompanionDatabase>,
  orderId: string,
  record: NormalizedAmazonShipmentRecord,
): CompatibleResolution {
  const candidates = database
    .prepare(
      'SELECT id, source_shipment_key, external_shipment_id FROM amazon_shipments WHERE amazon_order_id = ? AND external_shipment_id IS NOT NULL',
    )
    .all(orderId) as readonly Readonly<{
    id: string;
    source_shipment_key: string;
    external_shipment_id: string;
  }>[];
  return resolveCompatibleCandidates(
    database,
    'amazon_shipment_id',
    candidates.map(candidate => ({
      id: candidate.id,
      expectedHash: sourcePayloadHash({
        ...record,
        externalShipmentId: candidate.external_shipment_id,
        canonicalKey: candidate.source_shipment_key,
      }),
    })),
  );
}

function findCompatibleExternalItem(
  database: ReturnType<typeof openCompanionDatabase>,
  orderId: string,
  shipmentId: string | null,
  record: NormalizedAmazonItemRecord,
): CompatibleResolution {
  const canonicalShipmentKey =
    shipmentId === null
      ? null
      : (
          database
            .prepare(
              'SELECT source_shipment_key FROM amazon_shipments WHERE id = ?',
            )
            .get(shipmentId) as
            | Readonly<{ source_shipment_key: string }>
            | undefined
        )?.source_shipment_key;
  if (shipmentId !== null && canonicalShipmentKey === undefined) {
    throw new Error('Amazon item parent shipment is missing.');
  }
  const candidates = database
    .prepare(
      'SELECT id, source_item_key, external_item_id FROM amazon_items WHERE amazon_order_id = ? AND amazon_shipment_id IS ? AND external_item_id IS NOT NULL',
    )
    .all(orderId, shipmentId) as readonly Readonly<{
    id: string;
    source_item_key: string;
    external_item_id: string;
  }>[];
  return resolveCompatibleCandidates(
    database,
    'amazon_item_id',
    candidates.map(candidate => ({
      id: candidate.id,
      expectedHash: sourcePayloadHash({
        ...record,
        shipmentKey: canonicalShipmentKey ?? null,
        externalItemId: candidate.external_item_id,
        canonicalKey: candidate.source_item_key,
      }),
    })),
  );
}

function findCompatibleExternalRefund(
  database: ReturnType<typeof openCompanionDatabase>,
  orderId: string,
  itemId: string | null,
  record: NormalizedAmazonRefundRecord,
): CompatibleResolution {
  const canonicalItemKey =
    itemId === null
      ? null
      : (
          database
            .prepare('SELECT source_item_key FROM amazon_items WHERE id = ?')
            .get(itemId) as Readonly<{ source_item_key: string }> | undefined
        )?.source_item_key;
  if (itemId !== null && canonicalItemKey === undefined) {
    throw new Error('Amazon refund parent item is missing.');
  }
  const candidates = database
    .prepare(
      'SELECT id, source_refund_key, external_refund_id FROM amazon_refunds WHERE amazon_order_id = ? AND amazon_item_id IS ? AND external_refund_id IS NOT NULL',
    )
    .all(orderId, itemId) as readonly Readonly<{
    id: string;
    source_refund_key: string;
    external_refund_id: string;
  }>[];
  return resolveCompatibleCandidates(
    database,
    'amazon_refund_id',
    candidates.map(candidate => ({
      id: candidate.id,
      expectedHash: sourcePayloadHash({
        ...record,
        itemKey: canonicalItemKey ?? null,
        externalRefundId: candidate.external_refund_id,
        canonicalKey: candidate.source_refund_key,
      }),
    })),
  );
}

function resolveCompatibleCandidates(
  database: ReturnType<typeof openCompanionDatabase>,
  foreignKey: 'amazon_shipment_id' | 'amazon_item_id' | 'amazon_refund_id',
  candidates: readonly Readonly<{ id: string; expectedHash: string }>[],
): CompatibleResolution {
  const compatible = candidates.filter(candidate =>
    database
      .prepare(
        `SELECT 1 FROM amazon_source_observations WHERE ${foreignKey} = ? AND source_payload_hash = ? LIMIT 1`,
      )
      .get(candidate.id, candidate.expectedHash),
  );
  if (compatible.length === 0) {
    return { kind: 'none' };
  }
  if (compatible.length > 1) {
    return { kind: 'ambiguous' };
  }
  const resolved = compatible[0];
  if (resolved === undefined) {
    throw new Error('Compatible Amazon identity resolution was inconsistent.');
  }
  return { kind: 'resolved', id: resolved.id };
}

function sourcePayloadHash(record: NormalizedAmazonExportRecord): string {
  return sha256(Buffer.from(canonicalJson(recordPayload(record)), 'utf8'));
}

function hasCompatibleObservation(
  database: ReturnType<typeof openCompanionDatabase>,
  foreignKey: 'amazon_shipment_id' | 'amazon_item_id' | 'amazon_refund_id',
  entityId: string,
  record: NormalizedAmazonExportRecord,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM amazon_source_observations WHERE ${foreignKey} = ? AND source_payload_hash = ? LIMIT 1`,
      )
      .get(entityId, sourcePayloadHash(record)),
  );
}
function findOrder(
  database: ReturnType<typeof openCompanionDatabase>,
  namespaceId: string,
  marketplace: string,
  externalOrderId: string,
  cache: Map<string, CanonicalOrder>,
): CanonicalOrder | undefined {
  const key = orderLookupKey(marketplace, externalOrderId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const row = database
    .prepare(
      'SELECT id, currency_code FROM amazon_orders WHERE source_namespace_id = ? AND marketplace = ? AND external_order_id = ?',
    )
    .get(
      namespaceId,
      normalizedMarketplace(marketplace),
      normalizedIdentifier(externalOrderId),
    ) as CanonicalOrder | undefined;
  if (row !== undefined) cache.set(key, row);
  return row;
}
function findShipmentId(
  database: ReturnType<typeof openCompanionDatabase>,
  orderId: string,
  sourceShipmentKey: string,
  aliases: InBatchCanonicalAliases,
): string | undefined {
  const aliased = aliases.shipmentIdsBySourceKey.get(sourceShipmentKey);
  if (aliased !== undefined) {
    return aliased;
  }
  return (
    database
      .prepare(
        'SELECT id FROM amazon_shipments WHERE amazon_order_id = ? AND source_shipment_key = ?',
      )
      .get(orderId, sourceShipmentKey) as Readonly<{ id: string }> | undefined
  )?.id;
}
function findItemId(
  database: ReturnType<typeof openCompanionDatabase>,
  orderId: string,
  sourceItemKey: string,
  aliases: InBatchCanonicalAliases,
): string | undefined {
  const aliased = aliases.itemIdsBySourceKey.get(sourceItemKey);
  if (aliased !== undefined) {
    return aliased;
  }
  return (
    database
      .prepare(
        'SELECT id FROM amazon_items WHERE amazon_order_id = ? AND source_item_key = ?',
      )
      .get(orderId, sourceItemKey) as Readonly<{ id: string }> | undefined
  )?.id;
}
function updateLastObserved(
  database: ReturnType<typeof openCompanionDatabase>,
  table: string,
  id: string,
  observedAt: string,
) {
  database
    .prepare(
      `UPDATE ${table} SET last_observed_at = CASE WHEN last_observed_at < ? THEN ? ELSE last_observed_at END WHERE id = ?`,
    )
    .run(observedAt, observedAt, id);
}
function sameOrder(row: Record<string, unknown>, record: AmazonOrderRecord) {
  return (
    row.currency_code === record.currencyCode &&
    row.order_date === record.orderDate &&
    row.item_subtotal === record.itemSubtotal &&
    row.tax_total === record.taxTotal &&
    row.shipping_total === record.shippingTotal &&
    row.discount_total === record.discountTotal &&
    row.gift_card_total === record.giftCardTotal &&
    row.refund_total === record.refundTotal &&
    row.order_total === record.orderTotal
  );
}
function sameItem(
  row: Record<string, unknown>,
  record: AmazonItemRecord,
  shipmentId: string | null,
) {
  return (
    row.amazon_shipment_id === shipmentId &&
    row.external_item_id === normalizedNullable(record.externalItemId) &&
    row.title === normalizedTitle(record.title) &&
    row.quantity === record.quantity &&
    row.unit_amount === record.unitAmount &&
    row.tax_amount === record.taxAmount &&
    row.shipping_amount === record.shippingAmount &&
    row.discount_amount === record.discountAmount &&
    row.refund_amount === record.refundAmount
  );
}
function fallbackShipmentKey(record: AmazonShipmentRecord, occurrence: number) {
  return `shipment-fallback/${sha256Parts([sourceOrderKey(record.marketplace, record.externalOrderId), record.shipmentDate ?? '', record.shipmentTotal ?? '', ...record.orderedItemSignatures])}/${occurrence}`;
}
function fallbackItemKey(record: AmazonItemRecord, occurrence: number) {
  if (
    record.asin === null &&
    record.sku === null &&
    record.seller === null &&
    normalizedTitle(record.title).length === 0
  ) {
    throw new Error('Fallback item identity is incomplete.');
  }
  return `item-fallback/${sha256Parts([sourceOrderKey(record.marketplace, record.externalOrderId), record.shipmentKey ?? '', record.asin ?? record.sku ?? '', record.seller ?? '', record.title, record.quantity, record.unitAmount, record.taxAmount, record.shippingAmount, record.discountAmount, record.currencyCode])}/${occurrence}`;
}
function fallbackRefundKey(record: AmazonRefundRecord, occurrence: number) {
  return `refund-fallback/${sha256Parts([sourceOrderKey(record.marketplace, record.externalOrderId), record.itemKey ?? '', record.refundDate, record.amount, record.currencyCode, record.reason ?? ''])}/${occurrence}`;
}
export function sha256Parts(parts: readonly (string | number)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
function normalizedIdentifier(value: string) {
  const normalized = value
    .normalize('NFC')
    .replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
  if (normalized.length === 0) throw new Error('Amazon identifier is empty.');
  return normalized;
}
function normalizedNullable(value: string | null) {
  return value === null ? null : normalizedIdentifier(value);
}
function normalizedTitle(value: string) {
  return normalizedIdentifier(value).replace(/[\t\n\v\f\r ]+/g, ' ');
}
function normalizedMarketplace(value: string) {
  const normalized = normalizedIdentifier(value).toLowerCase();
  if (!/^[\x20-\x7e]+$/.test(normalized)) {
    throw new Error('Amazon marketplace is invalid.');
  }
  return normalized;
}
function orderLookupKey(marketplace: string, orderId: string) {
  return `${normalizedMarketplace(marketplace)}\0${normalizedIdentifier(orderId)}`;
}
function sourceOrderKey(marketplace: string, orderId: string) {
  return `order/${normalizedMarketplace(marketplace)}/${normalizedIdentifier(orderId)}`;
}
function parseRecords(
  parser: AmazonExportParser,
  bytes: Buffer,
): readonly unknown[] {
  const records: unknown = parser.parse(bytes);
  if (!Array.isArray(records) || records.length > MAXIMUM_EXPORT_RECORDS) {
    throw new Error('Amazon parser output is invalid.');
  }
  return records;
}

function normalizeParsedRecords(
  parsedRecords: readonly unknown[],
): readonly NormalizedAmazonExportRecord[] {
  const records = parsedRecords.map(normalizeAmazonRecordDto);
  const positions = new Set<string>();
  for (const record of records) {
    const position = `${record.sectionName}\0${record.recordNumber}`;
    if (positions.has(position)) {
      throw new Error('Amazon parser has duplicate source positions.');
    }
    positions.add(position);
  }
  const occurrences = new Map<AmazonExportRecord, number>();
  const groups = new Map<string, AmazonExportRecord[]>();
  for (const record of records) {
    if (
      (record.kind === 'shipment' && record.externalShipmentId !== null) ||
      (record.kind === 'item' && record.externalItemId !== null) ||
      (record.kind === 'refund' && record.externalRefundId !== null) ||
      record.kind === 'order'
    ) {
      continue;
    }
    const fingerprint = `${record.sectionName}\0${fallbackFingerprint(record)}`;
    const group = groups.get(fingerprint);
    if (group === undefined) groups.set(fingerprint, [record]);
    else group.push(record);
  }
  for (const group of groups.values()) {
    group
      .sort((left, right) => left.recordNumber - right.recordNumber)
      .forEach((record, index) => occurrences.set(record, index + 1));
  }
  return records
    .map(record => addCanonicalKey(record, occurrences.get(record)))
    .sort(
      (left, right) =>
        recordKindRank(left.kind) - recordKindRank(right.kind) ||
        left.sectionName.localeCompare(right.sectionName) ||
        left.recordNumber - right.recordNumber,
    );
}

function addCanonicalKey(
  record: AmazonExportRecord,
  fallbackOccurrence: number | undefined,
): NormalizedAmazonExportRecord {
  if (record.kind === 'order') {
    return {
      ...record,
      sourceRowKey: requiredNormalizedSourceRowKey(record),
      canonicalKey: sourceOrderKey(record.marketplace, record.externalOrderId),
    };
  }
  if (record.kind === 'shipment') {
    return {
      ...record,
      sourceRowKey: requiredNormalizedSourceRowKey(record),
      canonicalKey:
        record.externalShipmentId === null
          ? fallbackShipmentKey(record, requiredOccurrence(fallbackOccurrence))
          : `shipment/${record.externalShipmentId}`,
    };
  }
  if (record.kind === 'item') {
    return {
      ...record,
      sourceRowKey: requiredNormalizedSourceRowKey(record),
      canonicalKey:
        record.externalItemId === null
          ? fallbackItemKey(record, requiredOccurrence(fallbackOccurrence))
          : `item/${record.externalItemId}`,
    };
  }
  return {
    ...record,
    sourceRowKey: requiredNormalizedSourceRowKey(record),
    canonicalKey:
      record.externalRefundId === null
        ? fallbackRefundKey(record, requiredOccurrence(fallbackOccurrence))
        : `refund/${record.externalRefundId}`,
  };
}

function requiredNormalizedSourceRowKey(record: AmazonExportRecord): string {
  if (record.sourceRowKey === undefined) {
    throw new Error('Amazon source position was not normalized.');
  }
  return record.sourceRowKey;
}

function requiredOccurrence(occurrence: number | undefined): number {
  if (occurrence === undefined) {
    throw new Error('Amazon fallback occurrence was not assigned.');
  }
  return occurrence;
}

function recordKindRank(kind: AmazonExportRecord['kind']): number {
  if (kind === 'order') return 0;
  if (kind === 'shipment') return 1;
  if (kind === 'item') return 2;
  return 3;
}

export function normalizeAmazonRecordDto(value: unknown): AmazonExportRecord {
  if (!isObject(value)) {
    throw new Error('Amazon parser output is invalid.');
  }
  const kind = requiredEnum(value, 'kind', [
    'order',
    'shipment',
    'item',
    'refund',
  ] as const);
  const base = {
    sectionName: requiredSectionName(value, 'sectionName'),
    recordNumber: requiredPositiveSafeInteger(value, 'recordNumber'),
    sourceRowKey: '',
    marketplace: normalizedMarketplace(requiredString(value, 'marketplace')),
    externalOrderId: normalizedIdentifier(
      requiredString(value, 'externalOrderId'),
    ),
  };
  base.sourceRowKey = normalizedSourceRowKey(
    value,
    kind,
    base.sectionName,
    base.recordNumber,
  );
  if (kind === 'order') {
    return {
      ...base,
      kind,
      orderDate: requiredDate(value, 'orderDate'),
      currencyCode: requiredCurrency(value, 'currencyCode'),
      itemSubtotal: requiredMoney(value, 'itemSubtotal'),
      taxTotal: requiredMoney(value, 'taxTotal'),
      shippingTotal: requiredMoney(value, 'shippingTotal'),
      discountTotal: requiredMoney(value, 'discountTotal'),
      giftCardTotal: requiredMoney(value, 'giftCardTotal'),
      refundTotal: requiredMoney(value, 'refundTotal'),
      orderTotal: requiredMoney(value, 'orderTotal'),
    };
  }
  if (kind === 'shipment') {
    const externalShipmentId = normalizedOptionalIdentifier(
      requiredNullableString(value, 'externalShipmentId'),
    );
    const orderedItemSignatures = requiredStringArray(
      value,
      'orderedItemSignatures',
    ).map(normalizedIdentifier);
    if (externalShipmentId === null && orderedItemSignatures.length === 0) {
      throw new Error('Amazon fallback shipment identity is incomplete.');
    }
    return {
      ...base,
      kind,
      externalShipmentId,
      shipmentDate: requiredNullableDate(value, 'shipmentDate'),
      shipmentTotal: requiredNullableMoney(value, 'shipmentTotal'),
      orderedItemSignatures: [...orderedItemSignatures].sort(),
    };
  }
  if (kind === 'item') {
    const title = normalizedTitle(requiredString(value, 'title'));
    const asin = normalizedOptionalIdentifier(
      requiredNullableString(value, 'asin'),
    );
    const sku = normalizedOptionalIdentifier(
      requiredNullableString(value, 'sku'),
    );
    const seller = normalizedOptionalIdentifier(
      requiredNullableString(value, 'seller'),
    );
    if (
      asin === null &&
      sku === null &&
      seller === null &&
      title.length === 0
    ) {
      throw new Error('Amazon fallback item identity is incomplete.');
    }
    return {
      ...base,
      kind,
      shipmentKey: normalizedOptionalSourceKey(
        requiredNullableString(value, 'shipmentKey'),
        'shipment',
      ),
      externalItemId: normalizedOptionalIdentifier(
        requiredNullableString(value, 'externalItemId'),
      ),
      asin,
      sku,
      seller,
      title,
      quantity: requiredPositiveSafeInteger(value, 'quantity'),
      unitAmount: requiredMoney(value, 'unitAmount'),
      taxAmount: requiredMoney(value, 'taxAmount'),
      shippingAmount: requiredMoney(value, 'shippingAmount'),
      discountAmount: requiredMoney(value, 'discountAmount'),
      refundAmount: requiredMoney(value, 'refundAmount'),
      currencyCode: requiredCurrency(value, 'currencyCode'),
    };
  }
  return {
    ...base,
    kind,
    itemKey: normalizedOptionalSourceKey(
      requiredNullableString(value, 'itemKey'),
      'item',
    ),
    externalRefundId: normalizedOptionalIdentifier(
      requiredNullableString(value, 'externalRefundId'),
    ),
    refundDate: requiredDate(value, 'refundDate'),
    amount: requiredMoney(value, 'amount'),
    currencyCode: requiredCurrency(value, 'currencyCode'),
    reason: normalizedOptionalText(requiredNullableString(value, 'reason')),
  };
}
function fallbackFingerprint(
  record: Exclude<AmazonExportRecord, AmazonOrderRecord>,
): string {
  if (record.kind === 'shipment') {
    return sha256Parts([
      sourceOrderKey(record.marketplace, record.externalOrderId),
      record.shipmentDate ?? '',
      record.shipmentTotal ?? '',
      ...record.orderedItemSignatures.map(normalizedIdentifier).sort(),
    ]);
  }
  if (record.kind === 'item') {
    return sha256Parts([
      sourceOrderKey(record.marketplace, record.externalOrderId),
      record.shipmentKey ?? '',
      record.asin ?? record.sku ?? '',
      record.seller ?? '',
      normalizedTitle(record.title),
      record.quantity,
      record.unitAmount,
      record.taxAmount,
      record.shippingAmount,
      record.discountAmount,
      record.currencyCode,
    ]);
  }
  return sha256Parts([
    sourceOrderKey(record.marketplace, record.externalOrderId),
    record.itemKey ?? '',
    record.refundDate,
    record.amount,
    record.currencyCode,
    record.reason === null ? '' : normalizedTitle(record.reason),
  ]);
}
function validateRequest(request: ParseAmazonExportRequest) {
  if (
    !Buffer.isBuffer(request.bytes) ||
    request.bytes.length > MAXIMUM_EXPORT_BYTES ||
    request.sourceNamespaceId.length === 0 ||
    request.parser.name.length === 0 ||
    !Number.isSafeInteger(request.parser.version) ||
    request.parser.version < 1
  ) {
    throw new Error('Amazon import request is invalid.');
  }
}
function findReceipt(
  database: ReturnType<typeof openCompanionDatabase>,
  request: ParseAmazonExportRequest,
  content: string,
): ReceiptRow | undefined {
  return database
    .prepare(
      'SELECT id, content_sha256, parser_name, parser_version, status, row_count, accepted_count, rejected_count, error_code FROM import_batches WHERE source_namespace_id = ? AND actual_account_id IS NULL AND content_sha256 = ? AND parser_name = ? AND parser_version = ?',
    )
    .get(
      request.sourceNamespaceId,
      content,
      request.parser.name,
      request.parser.version,
    ) as ReceiptRow | undefined;
}
function findReceiptById(
  database: ReturnType<typeof openCompanionDatabase>,
  id: string,
): ReceiptRow | undefined {
  return database
    .prepare(
      'SELECT id, content_sha256, parser_name, parser_version, status, row_count, accepted_count, rejected_count, error_code FROM import_batches WHERE id = ?',
    )
    .get(id) as ReceiptRow | undefined;
}
function markFailed(
  databasePath: string,
  id: string,
  error: NonNullable<AmazonImportReceipt['errorCode']>,
  now: () => Date,
) {
  return withDatabase(databasePath, database => {
    database
      .prepare(
        "UPDATE import_batches SET status = 'failed', completed_at = ?, error_code = ? WHERE id = ? AND status = 'parsing'",
      )
      .run(now().toISOString(), error, id);
    const receipt = findReceiptById(database, id);
    if (receipt === undefined) throw new Error('Amazon receipt is missing.');
    return toReceipt(receipt);
  });
}
function toReceipt(row: ReceiptRow): AmazonImportReceipt {
  return {
    id: row.id,
    contentSha256: row.content_sha256,
    parserName: row.parser_name,
    parserVersion: row.parser_version,
    status: row.status,
    rowCount: row.row_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    errorCode: row.error_code,
  };
}

function toParseResult(
  receipt: AmazonImportReceipt,
  replayed: boolean,
): ParseAmazonExportResult {
  const conflictReason = isConflictReason(receipt.errorCode)
    ? receipt.errorCode
    : null;
  return {
    receipt,
    replayed,
    result:
      receipt.status === 'parsed'
        ? conflictReason === null
          ? 'completed'
          : 'completed-with-conflicts'
        : 'failed',
    conflictReason,
  };
}

function isConflictReason(
  value: AmazonImportReceipt['errorCode'],
): value is AmazonConflictReason {
  return value === 'conflicting_observation' || value === 'ambiguous_identity';
}
function withDatabase<Result>(
  databasePath: string,
  operation: (database: ReturnType<typeof openCompanionDatabase>) => Result,
): Result {
  const database = openCompanionDatabase(databasePath, true);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  if (typeof item !== 'string') throw new Error('Invalid Amazon export field.');
  return item;
}

function requiredNullableString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  if (!(key in value)) {
    throw new Error('Invalid Amazon parser field.');
  }
  const item = value[key];
  if (item === null) return null;
  if (typeof item !== 'string') {
    throw new Error('Invalid Amazon parser field.');
  }
  return item;
}

function requiredEnum<const Value extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly Value[],
): Value {
  const item = value[key];
  if (typeof item !== 'string' || !allowed.includes(item as Value)) {
    throw new Error('Invalid Amazon parser field.');
  }
  return item as Value;
}

function requiredSectionName(
  value: Record<string, unknown>,
  key: string,
): string {
  const sectionName = requiredString(value, key);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(sectionName)) {
    throw new Error('Invalid Amazon export section name.');
  }
  return sectionName;
}

function normalizedSourceRowKey(
  value: Record<string, unknown>,
  kind: AmazonExportRecord['kind'],
  sectionName: string,
  recordNumber: number,
): string {
  const supplied = value.sourceRowKey;
  if (supplied === undefined) {
    return `export/${sectionName}/${recordNumber}`;
  }
  if (
    typeof supplied !== 'string' ||
    !new RegExp(
      `^eml/[0-9a-f]{64}/${kind}/[1-9][0-9]{0,5}\\.[1-9][0-9]{0,6}$`,
    ).test(supplied)
  ) {
    throw new Error('Invalid Amazon source position.');
  }
  return supplied;
}

function requiredPositiveSafeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const item = value[key];
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 1 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon parser integer.');
  }
  return item;
}

function requiredMoney(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 0 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon parser money.');
  }
  return item;
}

function requiredNullableMoney(
  value: Record<string, unknown>,
  key: string,
): number | null {
  if (!(key in value)) {
    throw new Error('Invalid Amazon parser money.');
  }
  const item = value[key];
  if (item === null) return null;
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 0 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon parser money.');
  }
  return item;
}

function requiredCurrency(value: Record<string, unknown>, key: string): string {
  const currency = requiredString(value, key);
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new Error('Invalid Amazon parser currency.');
  }
  return currency;
}

function requiredDate(value: Record<string, unknown>, key: string): string {
  const date = requiredString(value, key);
  if (!isCanonicalDate(date)) {
    throw new Error('Invalid Amazon parser date.');
  }
  return date;
}

function requiredNullableDate(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const date = requiredNullableString(value, key);
  if (date !== null && !isCanonicalDate(date)) {
    throw new Error('Invalid Amazon parser date.');
  }
  return date;
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const item = value[key];
  if (!Array.isArray(item) || item.some(entry => typeof entry !== 'string')) {
    throw new Error('Invalid Amazon parser string array.');
  }
  return item as readonly string[];
}

function isCanonicalDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizedOptionalIdentifier(value: string | null): string | null {
  return value === null ? null : normalizedIdentifier(value);
}

function normalizedOptionalText(value: string | null): string | null {
  return value === null ? null : normalizedTitle(value);
}

function normalizedOptionalSourceKey(
  value: string | null,
  expectedKind: 'shipment' | 'item',
): string | null {
  if (value === null) return null;
  const normalized = normalizedIdentifier(value);
  if (
    !normalized.startsWith(`${expectedKind}/`) &&
    !normalized.startsWith(`${expectedKind}-fallback/`)
  ) {
    throw new Error('Invalid Amazon canonical parent key.');
  }
  return normalized;
}
function optionalString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  if (item === undefined || item === null) return null;
  if (typeof item !== 'string') throw new Error('Invalid Amazon export field.');
  return item;
}
function stringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const item = value[key];
  if (!Array.isArray(item) || item.some(entry => typeof entry !== 'string')) {
    throw new Error('Invalid Amazon export field.');
  }
  return item as string[];
}
function money(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 0 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon money.');
  }
  return item;
}
function optionalMoney(
  value: Record<string, unknown>,
  key: string,
): number | null {
  const item = value[key];
  if (item === undefined || item === null) return null;
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 0 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon money.');
  }
  return item;
}
function positiveInteger(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (
    typeof item !== 'number' ||
    !Number.isSafeInteger(item) ||
    item < 1 ||
    item > MAXIMUM_SAFE_MINOR_UNITS
  ) {
    throw new Error('Invalid Amazon quantity.');
  }
  return item;
}
