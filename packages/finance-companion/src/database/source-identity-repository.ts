import { randomUUID } from 'node:crypto';

import { openCompanionDatabase } from './connection.ts';

export type SourceNamespaceKind = 'statement' | 'amazon_profile';
export type SourceBookingStatus = 'unknown' | 'pending' | 'posted';

export type CreateSourceNamespace = Readonly<{
  id?: string;
  kind: SourceNamespaceKind;
  namespace: string;
  displayName: string;
  createdAt: string;
}>;

export type SourceObservation = Readonly<{
  id?: string;
  sourceNamespaceId: string;
  importBatchId: string;
  sourceRowIndex: number;
  actualAccountId: string;
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
  sourcePayloadHash: string;
  observedAt: string;
}>;

export type SourceObservationResult =
  | Readonly<{
      kind: 'created' | 'observed' | 'promoted';
      sourceTransactionId: string;
      observationId: string;
    }>
  | Readonly<{
      kind: 'conflict';
      sourceTransactionId: string;
      observationId: string;
      requiresReview: true;
    }>;

export type SourceIdentityRepository = Readonly<{
  createSourceNamespace: (
    sourceNamespace: CreateSourceNamespace,
  ) => Readonly<{ id: string }>;
  recordObservation: (
    observation: SourceObservation,
  ) => SourceObservationResult;
}>;

type SourceTransactionRow = Readonly<{
  id: string;
  currency_code: string;
  amount: number;
  booking_status: SourceBookingStatus;
  posted_date: string | null;
  last_observed_at: string;
}>;

export class SourceCurrencyMismatchError extends Error {
  constructor() {
    super(
      'The source observation currency does not match the companion budget.',
    );
  }
}

export function createSqliteSourceIdentityRepository(
  databasePath: string,
): SourceIdentityRepository {
  return {
    createSourceNamespace: sourceNamespace =>
      withDatabase(databasePath, database => {
        const id = sourceNamespace.id ?? randomUUID();
        database
          .prepare(
            'INSERT INTO source_namespaces (id, kind, namespace, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            id,
            sourceNamespace.kind,
            sourceNamespace.namespace,
            sourceNamespace.displayName,
            sourceNamespace.createdAt,
          );
        return { id };
      }),
    recordObservation: observation =>
      withDatabase(databasePath, database =>
        database
          .transaction(() => recordSourceObservation(database, observation))
          .immediate(),
      ),
  };
}

function recordSourceObservation(
  database: ReturnType<typeof openCompanionDatabase>,
  observation: SourceObservation,
): SourceObservationResult {
  assertObservationCurrencyMatchesBudget(database, observation.currencyCode);
  const existing =
    observation.externalTransactionId === null
      ? undefined
      : (database
          .prepare(
            'SELECT id, currency_code, amount, booking_status, posted_date, last_observed_at FROM source_transactions WHERE actual_account_id = ? AND source_namespace_id = ? AND external_transaction_id = ?',
          )
          .get(
            observation.actualAccountId,
            observation.sourceNamespaceId,
            observation.externalTransactionId,
          ) as SourceTransactionRow | undefined);
  const observationId = observation.id ?? randomUUID();

  if (existing === undefined) {
    const sourceTransactionId = randomUUID();
    insertSourceTransaction(database, sourceTransactionId, observation);
    insertObservation(
      database,
      observationId,
      sourceTransactionId,
      observation,
    );
    return {
      kind: 'created',
      sourceTransactionId,
      observationId,
    };
  }

  insertObservation(database, observationId, existing.id, observation);
  if (
    existing.currency_code !== observation.currencyCode ||
    existing.amount !== observation.amount
  ) {
    return {
      kind: 'conflict',
      sourceTransactionId: existing.id,
      observationId,
      requiresReview: true,
    };
  }

  const nextBookingStatus = promotedBookingStatus(
    existing.booking_status,
    observation.bookingStatus,
  );
  const isLatestObservation =
    observation.observedAt >= existing.last_observed_at;
  if (
    isLatestObservation &&
    doesNotDemoteBookingStatus(
      existing.booking_status,
      observation.bookingStatus,
    )
  ) {
    database
      .prepare(
        'UPDATE source_transactions SET transaction_date = ?, posted_date = COALESCE(?, posted_date), booking_status = ?, imported_payee = ?, normalized_payee_key = ?, fingerprint_version = ?, fingerprint = ?, last_observed_at = ? WHERE id = ?',
      )
      .run(
        observation.transactionDate,
        observation.postedDate,
        nextBookingStatus,
        observation.importedPayee,
        observation.normalizedPayeeKey,
        observation.fingerprintVersion,
        observation.fingerprint,
        observation.observedAt,
        existing.id,
      );
  } else if (nextBookingStatus !== existing.booking_status) {
    database
      .prepare(
        'UPDATE source_transactions SET booking_status = ?, last_observed_at = CASE WHEN last_observed_at < ? THEN ? ELSE last_observed_at END WHERE id = ?',
      )
      .run(
        nextBookingStatus,
        observation.observedAt,
        observation.observedAt,
        existing.id,
      );
  } else if (isLatestObservation) {
    database
      .prepare(
        'UPDATE source_transactions SET last_observed_at = ? WHERE id = ?',
      )
      .run(observation.observedAt, existing.id);
  }

  return {
    kind:
      existing.booking_status !== 'posted' && nextBookingStatus === 'posted'
        ? 'promoted'
        : 'observed',
    sourceTransactionId: existing.id,
    observationId,
  };
}

function assertObservationCurrencyMatchesBudget(
  database: ReturnType<typeof openCompanionDatabase>,
  currencyCode: string,
): void {
  const companion = database
    .prepare(
      "SELECT budget_currency_code FROM companion_instance WHERE singleton_key = 'main'",
    )
    .get() as Readonly<{ budget_currency_code: string }> | undefined;
  if (companion === undefined) {
    throw new Error('The companion budget binding is unavailable.');
  }
  if (companion.budget_currency_code !== currencyCode) {
    throw new SourceCurrencyMismatchError();
  }
}

function promotedBookingStatus(
  existingStatus: SourceBookingStatus,
  observationStatus: SourceBookingStatus,
): SourceBookingStatus {
  if (existingStatus === 'posted' || observationStatus === 'posted') {
    return 'posted';
  }
  if (existingStatus === 'pending' || observationStatus === 'pending') {
    return 'pending';
  }
  return 'unknown';
}

function doesNotDemoteBookingStatus(
  existingStatus: SourceBookingStatus,
  observationStatus: SourceBookingStatus,
): boolean {
  return (
    bookingStatusRank(observationStatus) >= bookingStatusRank(existingStatus)
  );
}

function bookingStatusRank(status: SourceBookingStatus): number {
  if (status === 'posted') return 2;
  if (status === 'pending') return 1;
  return 0;
}

function insertSourceTransaction(
  database: ReturnType<typeof openCompanionDatabase>,
  sourceTransactionId: string,
  observation: SourceObservation,
): void {
  database
    .prepare(
      'INSERT INTO source_transactions (id, source_namespace_id, actual_account_id, actual_transaction_id, external_transaction_id, currency_code, amount, transaction_date, posted_date, booking_status, imported_payee, normalized_payee_key, fingerprint_version, fingerprint, state, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      sourceTransactionId,
      observation.sourceNamespaceId,
      observation.actualAccountId,
      null,
      observation.externalTransactionId,
      observation.currencyCode,
      observation.amount,
      observation.transactionDate,
      observation.postedDate,
      observation.bookingStatus,
      observation.importedPayee,
      observation.normalizedPayeeKey,
      observation.fingerprintVersion,
      observation.fingerprint,
      'unmatched',
      observation.observedAt,
      observation.observedAt,
    );
}

function insertObservation(
  database: ReturnType<typeof openCompanionDatabase>,
  observationId: string,
  sourceTransactionId: string,
  observation: SourceObservation,
): void {
  database
    .prepare(
      'INSERT INTO source_transaction_observations (id, source_transaction_id, import_batch_id, source_row_index, currency_code, amount, transaction_date, posted_date, booking_status, imported_payee, source_payload_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      observationId,
      sourceTransactionId,
      observation.importBatchId,
      observation.sourceRowIndex,
      observation.currencyCode,
      observation.amount,
      observation.transactionDate,
      observation.postedDate,
      observation.bookingStatus,
      observation.importedPayee,
      observation.sourcePayloadHash,
      observation.observedAt,
    );
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
