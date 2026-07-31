import { randomUUID } from 'node:crypto';

import { openCompanionDatabase } from '#database/connection';
import {
  recordSourceObservationInTransaction,
  SourceCurrencyMismatchError,
} from '#database/source-identity-repository';
import type {
  SourceBookingStatus,
  SourceObservation,
  SourceObservationResult,
} from '#database/source-identity-repository';
import { canonicalJson, sha256 } from '#integrity/canonical-hash';

const MAXIMUM_IMPORT_BYTES = 10 * 1024 * 1024;
const MAXIMUM_PARSED_ROWS = 100_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const STABLE_ERROR_CODES = [
  'parser_failed',
  'currency_mismatch',
  'normalization_failed',
] as const;

export type ImportReceiptErrorCode = (typeof STABLE_ERROR_CODES)[number];

export type ParsedStatementImportRow = Readonly<{
  externalTransactionId: string | null;
  currencyCode: string;
  amount: number;
  transactionDate: string;
  postedDate: string | null;
  bookingStatus: SourceBookingStatus;
  importedPayee: string | null;
  normalizedPayeeKey: string | null;
  fingerprintVersion: number;
  fingerprint: string;
}>;

export type StatementImportParser = Readonly<{
  name: string;
  version: number;
  parse: (bytes: Buffer) => readonly ParsedStatementImportRow[];
}>;

export type ParseStatementImportRequest = Readonly<{
  sourceNamespaceId: string;
  actualAccountId: string;
  parser: StatementImportParser;
  /** Caller-owned bytes are parsed in memory; only their SHA-256 is retained. */
  bytes: Buffer;
}>;

export type ImportReceipt = Readonly<{
  id: string;
  contentSha256: string;
  parserName: string;
  parserVersion: number;
  status: 'parsing' | 'parsed' | 'applied' | 'failed' | 'discarded';
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errorCode: ImportReceiptErrorCode | null;
}>;

export type ParseStatementImportResult = Readonly<{
  receipt: ImportReceipt;
  replayed: boolean;
}>;

type ImportReceiptRow = Readonly<{
  id: string;
  content_sha256: string;
  parser_name: string;
  parser_version: number;
  status: 'parsing' | 'parsed' | 'applied' | 'failed' | 'discarded';
  row_count: number;
  accepted_count: number;
  rejected_count: number;
  error_code: ImportReceiptErrorCode | null;
}>;

type ImportReceiptFailureInjector = Readonly<{
  afterReceiptPersisted?: () => void;
  duringNormalization?: () => void;
  afterNormalizationCommitted?: () => void;
}>;

export class ImportReceiptInterruptedError extends Error {
  constructor() {
    super('The import receipt processing was interrupted.');
  }
}

export type ImportReceiptRepository = Readonly<{
  parseStatementImport: (
    request: ParseStatementImportRequest,
  ) => ParseStatementImportResult;
}>;

export function createSqliteImportReceiptRepository(
  databasePath: string,
  now = () => new Date(),
  failureInjector: ImportReceiptFailureInjector = {},
): ImportReceiptRepository {
  return {
    parseStatementImport: request =>
      parseStatementImport(databasePath, request, now, failureInjector),
  };
}

function parseStatementImport(
  databasePath: string,
  request: ParseStatementImportRequest,
  now: () => Date,
  failureInjector: ImportReceiptFailureInjector,
): ParseStatementImportResult {
  validateRequest(request);
  const contentSha256 = sha256(request.bytes);
  const receipt = createOrResolveReceipt(
    databasePath,
    request,
    contentSha256,
    now,
  );
  if (receipt.status !== 'parsing') {
    return { receipt: toImportReceipt(receipt), replayed: true };
  }

  failureInjector.afterReceiptPersisted?.();
  let rows: readonly ParsedStatementImportRow[];
  try {
    rows = parseRows(request.parser, request.bytes);
  } catch (error) {
    if (error instanceof ImportReceiptInterruptedError) throw error;
    return {
      receipt: markReceiptFailed(
        databasePath,
        receipt.id,
        'parser_failed',
        now,
      ),
      replayed: false,
    };
  }
  try {
    const normalizedReceipt = normalizeRows(
      databasePath,
      request,
      receipt.id,
      rows,
      now,
      failureInjector,
    );
    failureInjector.afterNormalizationCommitted?.();
    return { receipt: normalizedReceipt, replayed: false };
  } catch (error) {
    if (error instanceof ImportReceiptInterruptedError) throw error;
    const errorCode =
      error instanceof SourceCurrencyMismatchError
        ? 'currency_mismatch'
        : 'normalization_failed';
    return {
      receipt: markReceiptFailed(databasePath, receipt.id, errorCode, now),
      replayed: false,
    };
  }
}

function validateRequest(request: ParseStatementImportRequest): void {
  if (
    !Buffer.isBuffer(request.bytes) ||
    request.bytes.length > MAXIMUM_IMPORT_BYTES
  ) {
    throw new Error('The import input exceeds the allowed size.');
  }
  if (
    request.sourceNamespaceId.length === 0 ||
    request.actualAccountId.length === 0 ||
    request.parser.name.length === 0 ||
    !Number.isSafeInteger(request.parser.version) ||
    request.parser.version < 1
  ) {
    throw new Error('The import request is invalid.');
  }
}

function createOrResolveReceipt(
  databasePath: string,
  request: ParseStatementImportRequest,
  contentSha256: string,
  now: () => Date,
): ImportReceiptRow {
  return withDatabase(databasePath, database =>
    database
      .transaction(() => {
        const existing = findReceipt(database, request, contentSha256);
        if (existing !== undefined) return existing;
        const id = randomUUID();
        database
          .prepare(
            'INSERT INTO import_batches (id, source_namespace_id, actual_account_id, source_kind, content_sha256, parser_name, parser_version, source_display_name, started_at, completed_at, status, row_count, accepted_count, rejected_count, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            request.sourceNamespaceId,
            request.actualAccountId,
            'statement',
            contentSha256,
            request.parser.name,
            request.parser.version,
            null,
            now().toISOString(),
            null,
            'parsing',
            0,
            0,
            0,
            null,
          );
        const created = findReceiptById(database, id);
        if (created === undefined) {
          throw new Error('The import receipt was not created.');
        }
        return created;
      })
      .immediate(),
  );
}

function parseRows(
  parser: StatementImportParser,
  bytes: Buffer,
): readonly ParsedStatementImportRow[] {
  try {
    const rows = parser.parse(bytes);
    if (!Array.isArray(rows) || rows.length > MAXIMUM_PARSED_ROWS) {
      throw new Error('The parser output is invalid.');
    }
    rows.forEach(validateParsedRow);
    return rows;
  } catch {
    throw new ImportParserFailureError();
  }
}

class ImportParserFailureError extends Error {}

function validateParsedRow(row: ParsedStatementImportRow): void {
  if (
    typeof row !== 'object' ||
    row === null ||
    (row.externalTransactionId !== null &&
      typeof row.externalTransactionId !== 'string') ||
    !CURRENCY_CODE_PATTERN.test(row.currencyCode) ||
    !Number.isSafeInteger(row.amount) ||
    !DATE_PATTERN.test(row.transactionDate) ||
    (row.postedDate !== null && !DATE_PATTERN.test(row.postedDate)) ||
    !['unknown', 'pending', 'posted'].includes(row.bookingStatus) ||
    (row.importedPayee !== null && typeof row.importedPayee !== 'string') ||
    (row.normalizedPayeeKey !== null &&
      typeof row.normalizedPayeeKey !== 'string') ||
    !Number.isSafeInteger(row.fingerprintVersion) ||
    row.fingerprintVersion < 1 ||
    !SHA256_PATTERN.test(row.fingerprint)
  ) {
    throw new Error('The parser output is invalid.');
  }
}

function normalizeRows(
  databasePath: string,
  request: ParseStatementImportRequest,
  receiptId: string,
  rows: readonly ParsedStatementImportRow[],
  now: () => Date,
  failureInjector: ImportReceiptFailureInjector,
): ImportReceipt {
  return withDatabase(databasePath, database =>
    database
      .transaction(() => {
        const receipt = findReceiptById(database, receiptId);
        if (receipt === undefined) {
          throw new Error('The import receipt is missing.');
        }
        if (receipt.status !== 'parsing') {
          return toImportReceipt(receipt);
        }

        let acceptedCount = 0;
        let rejectedCount = 0;
        for (const [sourceRowIndex, row] of rows.entries()) {
          failureInjector.duringNormalization?.();
          const result = recordSourceObservationInTransaction(
            database,
            toSourceObservation(request, receiptId, sourceRowIndex, row, now),
          );
          if (isAcceptedObservation(result)) acceptedCount += 1;
          else rejectedCount += 1;
        }
        const completedAt = now().toISOString();
        const update = database
          .prepare(
            "UPDATE import_batches SET status = 'parsed', row_count = ?, accepted_count = ?, rejected_count = ?, completed_at = ?, error_code = NULL WHERE id = ? AND status = 'parsing'",
          )
          .run(
            rows.length,
            acceptedCount,
            rejectedCount,
            completedAt,
            receiptId,
          );
        if (update.changes !== 1) {
          throw new Error('The import receipt changed during normalization.');
        }
        const parsed = findReceiptById(database, receiptId);
        if (parsed === undefined) {
          throw new Error('The parsed receipt is missing.');
        }
        return toImportReceipt(parsed);
      })
      .immediate(),
  );
}

function toSourceObservation(
  request: ParseStatementImportRequest,
  importBatchId: string,
  sourceRowIndex: number,
  row: ParsedStatementImportRow,
  now: () => Date,
): SourceObservation {
  return {
    sourceNamespaceId: request.sourceNamespaceId,
    importBatchId,
    sourceRowIndex,
    actualAccountId: request.actualAccountId,
    externalTransactionId: row.externalTransactionId,
    currencyCode: row.currencyCode,
    amount: row.amount,
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    bookingStatus: row.bookingStatus,
    importedPayee: row.importedPayee,
    normalizedPayeeKey: row.normalizedPayeeKey,
    fingerprintVersion: row.fingerprintVersion,
    fingerprint: row.fingerprint,
    sourcePayloadHash: sha256(
      Buffer.from(
        canonicalJson({
          amount: row.amount,
          bookingStatus: row.bookingStatus,
          currencyCode: row.currencyCode,
          externalTransactionId: row.externalTransactionId,
          importedPayee: row.importedPayee,
          normalizedPayeeKey: row.normalizedPayeeKey,
          postedDate: row.postedDate,
          transactionDate: row.transactionDate,
        }),
        'utf8',
      ),
    ),
    observedAt: now().toISOString(),
  };
}

function isAcceptedObservation(result: SourceObservationResult): boolean {
  return result.kind !== 'conflict';
}

function markReceiptFailed(
  databasePath: string,
  receiptId: string,
  errorCode: ImportReceiptErrorCode,
  now: () => Date,
): ImportReceipt {
  return withDatabase(databasePath, database => {
    database
      .prepare(
        "UPDATE import_batches SET status = 'failed', completed_at = ?, error_code = ? WHERE id = ? AND status = 'parsing'",
      )
      .run(now().toISOString(), errorCode, receiptId);
    const receipt = findReceiptById(database, receiptId);
    if (receipt === undefined) {
      throw new Error('The failed receipt is missing.');
    }
    return toImportReceipt(receipt);
  });
}

function findReceipt(
  database: ReturnType<typeof openCompanionDatabase>,
  request: ParseStatementImportRequest,
  contentSha256: string,
): ImportReceiptRow | undefined {
  return database
    .prepare(
      'SELECT id, content_sha256, parser_name, parser_version, status, row_count, accepted_count, rejected_count, error_code FROM import_batches WHERE source_namespace_id = ? AND actual_account_id = ? AND content_sha256 = ? AND parser_name = ? AND parser_version = ?',
    )
    .get(
      request.sourceNamespaceId,
      request.actualAccountId,
      contentSha256,
      request.parser.name,
      request.parser.version,
    ) as ImportReceiptRow | undefined;
}

function findReceiptById(
  database: ReturnType<typeof openCompanionDatabase>,
  receiptId: string,
): ImportReceiptRow | undefined {
  return database
    .prepare(
      'SELECT id, content_sha256, parser_name, parser_version, status, row_count, accepted_count, rejected_count, error_code FROM import_batches WHERE id = ?',
    )
    .get(receiptId) as ImportReceiptRow | undefined;
}

function toImportReceipt(row: ImportReceiptRow): ImportReceipt {
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
