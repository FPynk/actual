import { randomUUID } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import type { AmazonUploadSemanticRequest } from '#http/request-idempotency';
import { createRfc5322AmazonEmailParser } from '#service/amazon-email-parser';
import {
  createJsonAmazonExportParser,
  createSqliteAmazonExportRepository,
} from '#service/amazon-export-repository';
import type {
  AmazonConflictReason,
  AmazonImportReceipt,
  ParseAmazonExportResult,
} from '#service/amazon-export-repository';
import { generateAmazonMatchCandidates } from '#service/amazon-matching';

const millisecondsPerDay = 86_400_000;
const maximumAmazonSnapshotPartitions = 64;
const defaultAmazonProfileDisplayName = 'Amazon profile';

export type AmazonImportResponseDtoV1 = Readonly<{
  version: 1;
  status: ParseAmazonExportResult['result'];
  replayed: boolean;
  receipt: Readonly<{
    status: AmazonImportReceipt['status'];
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
  candidateCount: number;
}>;

export type AmazonImportUpload = AmazonUploadSemanticRequest &
  Readonly<{
    bytes: Buffer;
    discard(): void;
  }>;

export type AmazonImportDependencies = Readonly<{
  adapter: ActualAdapter;
  databasePath: string;
  budgetKeyHash: string;
  budgetCurrencyCode: string;
  now?: () => Date;
}>;

export async function importAmazonUpload(
  upload: AmazonImportUpload,
  dependencies: AmazonImportDependencies,
): Promise<AmazonImportResponseDtoV1> {
  const now = dependencies.now ?? (() => new Date());
  let parsed: ParseAmazonExportResult;
  try {
    const sourceNamespaceId = readOrCreateDefaultAmazonProfile(
      dependencies.databasePath,
      now,
    );
    const repository = createSqliteAmazonExportRepository(
      dependencies.databasePath,
      now,
    );
    const request = {
      bytes: upload.bytes,
      parser:
        upload.mediaKind === 'amazon-export-json'
          ? createJsonAmazonExportParser()
          : createRfc5322AmazonEmailParser(),
      sourceNamespaceId,
    };
    parsed =
      upload.mediaKind === 'amazon-export-json'
        ? repository.parseAmazonExport(request)
        : repository.parseAmazonEmail(request);
  } finally {
    upload.discard();
  }

  let candidateCount = 0;
  if (parsed.result !== 'failed' && parsed.receipt.acceptedCount > 0) {
    const sourceRange = readImportSourceDateRange(
      dependencies.databasePath,
      parsed.receipt.id,
    );
    if (sourceRange !== null) {
      const snapshot = await readBoundedActualSnapshot(
        sourceRange,
        dependencies,
      );
      candidateCount = (
        await generateAmazonMatchCandidates({
          adapter: dependencies.adapter,
          createdAt: now().toISOString(),
          databasePath: dependencies.databasePath,
          snapshot,
        })
      ).length;
    }
  }

  return {
    version: 1,
    status: parsed.result,
    replayed: parsed.replayed,
    receipt: {
      status: parsed.receipt.status,
      rowCount: parsed.receipt.rowCount,
      acceptedCount: parsed.receipt.acceptedCount,
      rejectedCount: parsed.receipt.rejectedCount,
      errorCode: parsed.receipt.errorCode,
    },
    candidateCount,
  };
}

function readOrCreateDefaultAmazonProfile(
  databasePath: string,
  now: () => Date,
): string {
  const database = openCompanionDatabase(databasePath, true);
  try {
    return database
      .transaction(() => {
        const existing = database
          .prepare(
            "SELECT id FROM source_namespaces WHERE kind = 'amazon_profile' ORDER BY created_at, id LIMIT 1",
          )
          .get() as Readonly<{ id: string }> | undefined;
        if (existing !== undefined) return existing.id;
        const id = randomUUID();
        database
          .prepare(
            "INSERT INTO source_namespaces (id, kind, namespace, display_name, created_at) VALUES (?, 'amazon_profile', ?, ?, ?)",
          )
          .run(
            id,
            `amazon-profile/v1/${randomUUID()}`,
            defaultAmazonProfileDisplayName,
            now().toISOString(),
          );
        return id;
      })
      .immediate();
  } finally {
    database.close();
  }
}

function readImportSourceDateRange(
  databasePath: string,
  importBatchId: string,
): Readonly<{ firstDate: string; lastDate: string }> | null {
  const database = openCompanionDatabase(databasePath, true);
  try {
    const row = database
      .prepare(
        `SELECT MIN(source_date) AS firstDate, MAX(source_date) AS lastDate
         FROM (
           SELECT orders.order_date AS source_date
           FROM amazon_source_observations observations
           JOIN amazon_orders orders ON orders.id = observations.amazon_order_id
           WHERE observations.import_batch_id = ?
           UNION ALL
           SELECT COALESCE(shipments.shipment_date, orders.order_date)
           FROM amazon_source_observations observations
           JOIN amazon_shipments shipments ON shipments.id = observations.amazon_shipment_id
           JOIN amazon_orders orders ON orders.id = shipments.amazon_order_id
           WHERE observations.import_batch_id = ?
           UNION ALL
           SELECT orders.order_date
           FROM amazon_source_observations observations
           JOIN amazon_items items ON items.id = observations.amazon_item_id
           JOIN amazon_orders orders ON orders.id = items.amazon_order_id
           WHERE observations.import_batch_id = ?
           UNION ALL
           SELECT refunds.refund_date
           FROM amazon_source_observations observations
           JOIN amazon_refunds refunds ON refunds.id = observations.amazon_refund_id
           WHERE observations.import_batch_id = ?
         )`,
      )
      .get(importBatchId, importBatchId, importBatchId, importBatchId) as
      | Readonly<{ firstDate: string | null; lastDate: string | null }>
      | undefined;
    if (
      row?.firstDate === null ||
      row?.lastDate === null ||
      row === undefined
    ) {
      return null;
    }
    assertDate(row.firstDate);
    assertDate(row.lastDate);
    return { firstDate: row.firstDate, lastDate: row.lastDate };
  } finally {
    database.close();
  }
}

async function readBoundedActualSnapshot(
  sourceRange: Readonly<{ firstDate: string; lastDate: string }>,
  dependencies: AmazonImportDependencies,
): Promise<ActualBudgetSnapshotV1> {
  const startDate = addDays(sourceRange.firstDate, -3);
  const endDateExclusive = addDays(sourceRange.lastDate, 4);
  const transactionsById = new Map<string, ActualTransactionV1>();
  let budget: ActualBudgetSnapshotV1['budget'] | undefined;
  const ranges = partitionDateRange(startDate, endDateExclusive);
  for (const transactionRange of ranges) {
    const response = await dependencies.adapter.execute({
      kind: 'read-budget-snapshot',
      sections: [],
      transactionRange,
    });
    if (
      response.kind !== 'read-budget-snapshot' ||
      response.snapshot.budget.budgetKeyHash !== dependencies.budgetKeyHash ||
      response.snapshot.budget.currencyCode !==
        dependencies.budgetCurrencyCode ||
      response.snapshot.transactions === undefined
    ) {
      throw new Error('Actual returned an unexpected Amazon snapshot.');
    }
    budget ??= response.snapshot.budget;
    for (const transaction of response.snapshot.transactions) {
      transactionsById.set(transaction.id, transaction);
    }
  }
  if (budget === undefined) {
    throw new Error('The Amazon snapshot range is empty.');
  }
  return {
    contractVersion: 1,
    budget,
    transactions: [...transactionsById.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
}

function partitionDateRange(
  startDate: string,
  endDateExclusive: string,
): readonly Readonly<{ startDate: string; endDateExclusive: string }>[] {
  const start = parseDate(startDate);
  const end = parseDate(endDateExclusive);
  if (start >= end) throw new TypeError('Amazon import range is invalid.');
  if (
    Math.ceil((end - start) / (90 * millisecondsPerDay)) >
    maximumAmazonSnapshotPartitions
  ) {
    throw new Error('The Amazon source date range is too broad.');
  }
  const ranges: Readonly<{ startDate: string; endDateExclusive: string }>[] =
    [];
  for (let cursor = start; cursor < end; cursor += 90 * millisecondsPerDay) {
    ranges.push({
      startDate: isoDate(cursor),
      endDateExclusive: isoDate(
        Math.min(end, cursor + 90 * millisecondsPerDay),
      ),
    });
  }
  return ranges;
}

function addDays(value: string, count: number): string {
  return isoDate(parseDate(value) + count * millisecondsPerDay);
}

function parseDate(value: string): number {
  assertDate(value);
  return Date.parse(`${value}T00:00:00.000Z`);
}

function assertDate(value: string): void {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed) ||
    isoDate(parsed) !== value
  ) {
    throw new TypeError('Amazon source date is invalid.');
  }
}

function isoDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}
