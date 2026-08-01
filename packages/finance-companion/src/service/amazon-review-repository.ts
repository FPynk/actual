import { openCompanionDatabase } from '#database/connection';
import { amazonMatchReasonCodes } from '#service/amazon-matching';
import type {
  AmazonAllocationKind,
  AmazonMatchReasonCode,
} from '#service/amazon-matching';

export type AmazonReviewStatus =
  | 'pending'
  | 'deferred'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'partially_applied'
  | 'applied';

export type AmazonReviewAction = Readonly<{
  kind: 'approve' | 'reject' | 'defer' | 'reopen';
}>;

export type AmazonReviewAllocationRecordV1 = Readonly<{
  kind: AmazonAllocationKind;
  amountMinorUnits: number;
  itemTitle: string | null;
  proposedActualCategoryId: string | null;
}>;

export type AmazonReviewParentRecordV1 = Readonly<{
  actualTransactionId: string;
  actualTargetVersion: string;
  allocatedAmountMinorUnits: number;
  applicationStatus: 'pending' | 'applying' | 'applied' | 'stale' | 'conflict';
  allocations: readonly AmazonReviewAllocationRecordV1[];
}>;

export type AmazonReviewRecordV1 = Readonly<{
  id: string;
  matcherVersion: number;
  currencyCode: string;
  score: number;
  reasonCodes: readonly AmazonMatchReasonCode[];
  status: AmazonReviewStatus;
  createdAt: string;
  decidedAt: string | null;
  parents: readonly AmazonReviewParentRecordV1[];
}>;

export type AmazonReviewRepository = Readonly<{
  listAmazonReviewRecords(): readonly AmazonReviewRecordV1[];
  recordAmazonReviewDecision(
    record: AmazonReviewRecordV1,
    action: AmazonReviewAction,
    decidedAt: string,
  ): AmazonReviewRecordV1;
  markAmazonReviewStale(matchId: string): void;
}>;

type MatchRow = Readonly<{
  id: string;
  matcher_version: number;
  currency_code: string;
  score: number;
  reason_codes_json: string;
  status: Exclude<AmazonReviewStatus, 'deferred'>;
  created_at: string;
  decided_at: string | null;
  deferred_at: string | null;
}>;

type ParentRow = Readonly<{
  actual_transaction_id: string;
  actual_target_version: string;
  allocated_amount: number;
  application_status: AmazonReviewParentRecordV1['applicationStatus'];
}>;

type AllocationRow = Readonly<{
  allocation_kind: AmazonAllocationKind;
  allocated_amount: number;
  item_title: string | null;
  proposed_actual_category_id: string | null;
}>;

export class AmazonReviewConflictError extends Error {
  constructor() {
    super('Amazon review state changed.');
    this.name = 'AmazonReviewConflictError';
  }
}

export class SqliteAmazonReviewRepository implements AmazonReviewRepository {
  readonly #databasePath: string;

  constructor(databasePath: string) {
    this.#databasePath = databasePath;
  }

  listAmazonReviewRecords(): readonly AmazonReviewRecordV1[] {
    const database = openCompanionDatabase(this.#databasePath, true);
    try {
      return readRecords(database);
    } finally {
      database.close();
    }
  }

  recordAmazonReviewDecision(
    record: AmazonReviewRecordV1,
    action: AmazonReviewAction,
    decidedAt: string,
  ): AmazonReviewRecordV1 {
    assertTimestamp(decidedAt);
    const database = openCompanionDatabase(this.#databasePath, true);
    try {
      return database
        .transaction(() => {
          const current = readRecord(database, record.id);
          if (current === null || !sameRecordVersion(current, record)) {
            throw new AmazonReviewConflictError();
          }
          if (action.kind === 'defer') {
            if (current.status !== 'pending') {
              throw new AmazonReviewConflictError();
            }
            database
              .prepare(
                'INSERT INTO amazon_review_deferrals (match_id, deferred_at) VALUES (?, ?)',
              )
              .run(current.id, decidedAt);
          } else if (action.kind === 'approve' || action.kind === 'reject') {
            if (current.status !== 'pending') {
              throw new AmazonReviewConflictError();
            }
            const status = action.kind === 'approve' ? 'approved' : 'rejected';
            const updated = database
              .prepare(
                "UPDATE amazon_charge_matches SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM amazon_review_deferrals WHERE match_id = ?)",
              )
              .run(status, decidedAt, current.id, current.id);
            if (updated.changes !== 1) throw new AmazonReviewConflictError();
          } else if (current.status === 'deferred') {
            const reopened = database
              .prepare('DELETE FROM amazon_review_deferrals WHERE match_id = ?')
              .run(current.id);
            if (reopened.changes !== 1) throw new AmazonReviewConflictError();
          } else if (
            current.status === 'approved' ||
            current.status === 'rejected'
          ) {
            const reopened = database
              .prepare(
                "UPDATE amazon_charge_matches SET status = 'pending', decided_at = NULL WHERE id = ? AND status = ?",
              )
              .run(current.id, current.status);
            if (reopened.changes !== 1) throw new AmazonReviewConflictError();
          } else {
            throw new AmazonReviewConflictError();
          }
          const decided = readRecord(database, current.id);
          if (decided === null) throw new AmazonReviewConflictError();
          return decided;
        })
        .immediate();
    } finally {
      database.close();
    }
  }

  markAmazonReviewStale(matchId: string): void {
    const database = openCompanionDatabase(this.#databasePath, true);
    try {
      database
        .transaction(() => {
          database
            .prepare(
              "UPDATE amazon_charge_matches SET status = 'stale' WHERE id = ? AND status IN ('pending', 'approved', 'rejected')",
            )
            .run(matchId);
          database
            .prepare(
              "UPDATE amazon_match_transactions SET application_status = 'stale' WHERE match_id = ? AND application_status = 'pending'",
            )
            .run(matchId);
          database
            .prepare('DELETE FROM amazon_review_deferrals WHERE match_id = ?')
            .run(matchId);
        })
        .immediate();
    } finally {
      database.close();
    }
  }
}

function readRecords(
  database: ReturnType<typeof openCompanionDatabase>,
): readonly AmazonReviewRecordV1[] {
  return (
    database
      .prepare(
        `SELECT matches.id, matches.matcher_version, matches.currency_code, matches.score,
                matches.reason_codes_json, matches.status, matches.created_at, matches.decided_at,
                deferrals.deferred_at
         FROM amazon_charge_matches matches
         LEFT JOIN amazon_review_deferrals deferrals ON deferrals.match_id = matches.id
         ORDER BY CASE WHEN matches.status = 'pending' AND deferrals.match_id IS NULL THEN 0
                       WHEN matches.status = 'pending' THEN 1 ELSE 2 END,
                  matches.score DESC, matches.created_at DESC, matches.id`,
      )
      .all() as readonly MatchRow[]
  ).map(row => toRecord(database, row));
}

function readRecord(
  database: ReturnType<typeof openCompanionDatabase>,
  matchId: string,
): AmazonReviewRecordV1 | null {
  const row = database
    .prepare(
      `SELECT matches.id, matches.matcher_version, matches.currency_code, matches.score,
              matches.reason_codes_json, matches.status, matches.created_at, matches.decided_at,
              deferrals.deferred_at
       FROM amazon_charge_matches matches
       LEFT JOIN amazon_review_deferrals deferrals ON deferrals.match_id = matches.id
       WHERE matches.id = ?`,
    )
    .get(matchId) as MatchRow | undefined;
  return row === undefined ? null : toRecord(database, row);
}

function toRecord(
  database: ReturnType<typeof openCompanionDatabase>,
  row: MatchRow,
): AmazonReviewRecordV1 {
  if (row.deferred_at !== null && row.status !== 'pending') {
    throw new Error('Stored Amazon deferral state is invalid.');
  }
  const status: AmazonReviewStatus =
    row.deferred_at === null ? row.status : 'deferred';
  const parents = (
    database
      .prepare(
        `SELECT actual_transaction_id, actual_target_version, allocated_amount, application_status
         FROM amazon_match_transactions WHERE match_id = ? ORDER BY actual_transaction_id`,
      )
      .all(row.id) as readonly ParentRow[]
  ).map(parent => toParent(database, row.id, parent));
  if (parents.length === 0) {
    throw new Error('Stored Amazon review has no target parents.');
  }
  return {
    id: row.id,
    matcherVersion: row.matcher_version,
    currencyCode: row.currency_code,
    score: row.score,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    status,
    createdAt: row.created_at,
    decidedAt: row.deferred_at ?? row.decided_at,
    parents,
  };
}

function toParent(
  database: ReturnType<typeof openCompanionDatabase>,
  matchId: string,
  row: ParentRow,
): AmazonReviewParentRecordV1 {
  const allocations = database
    .prepare(
      `SELECT item_allocations.component_kind AS allocation_kind,
              item_allocations.allocated_amount,
              items.title AS item_title,
              item_allocations.proposed_actual_category_id
       FROM amazon_transaction_item_allocations item_allocations
       JOIN amazon_items items ON items.id = item_allocations.amazon_item_id
       WHERE item_allocations.match_id = ? AND item_allocations.actual_transaction_id = ?
       UNION ALL
       SELECT 'refund', refund_allocations.allocated_amount, items.title,
              refund_allocations.proposed_actual_category_id
       FROM amazon_transaction_refund_allocations refund_allocations
       JOIN amazon_refunds refunds ON refunds.id = refund_allocations.amazon_refund_id
       LEFT JOIN amazon_items items ON items.id = refunds.amazon_item_id
       WHERE refund_allocations.match_id = ? AND refund_allocations.actual_transaction_id = ?
       UNION ALL
       SELECT adjustment_allocations.adjustment_kind,
              adjustment_allocations.allocated_amount, NULL, NULL
       FROM amazon_transaction_order_adjustments adjustment_allocations
       WHERE adjustment_allocations.match_id = ? AND adjustment_allocations.actual_transaction_id = ?
       ORDER BY allocation_kind, item_title, allocated_amount`,
    )
    .all(
      matchId,
      row.actual_transaction_id,
      matchId,
      row.actual_transaction_id,
      matchId,
      row.actual_transaction_id,
    ) as readonly AllocationRow[];
  if (
    allocations.reduce(
      (sum, allocation) => sum + allocation.allocated_amount,
      0,
    ) !== row.allocated_amount
  ) {
    throw new Error('Stored Amazon allocation graph is not exact.');
  }
  return {
    actualTransactionId: row.actual_transaction_id,
    actualTargetVersion: row.actual_target_version,
    allocatedAmountMinorUnits: row.allocated_amount,
    applicationStatus: row.application_status,
    allocations: allocations.map(allocation => ({
      kind: allocation.allocation_kind,
      amountMinorUnits: allocation.allocated_amount,
      itemTitle: allocation.item_title,
      proposedActualCategoryId: allocation.proposed_actual_category_id,
    })),
  };
}

function parseReasonCodes(value: string): readonly AmazonMatchReasonCode[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      reason =>
        typeof reason === 'string' &&
        amazonMatchReasonCodes.some(allowed => allowed === reason),
    )
  ) {
    throw new Error('Stored Amazon match reasons are invalid.');
  }
  return parsed as readonly AmazonMatchReasonCode[];
}

function assertTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Amazon decision timestamp is invalid.');
  }
}

function sameRecordVersion(
  current: AmazonReviewRecordV1,
  expected: AmazonReviewRecordV1,
): boolean {
  return JSON.stringify(current) === JSON.stringify(expected);
}
