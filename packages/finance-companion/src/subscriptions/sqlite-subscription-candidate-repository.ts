import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { canonicalJson } from '#actual/canonical-json';

import { subscriptionDetectorVersion } from './subscription-detector';
import type {
  SubscriptionCadence,
  SubscriptionCandidateStatus,
  SubscriptionCandidateType,
  SubscriptionCandidateV1,
  SubscriptionReasonCode,
} from './subscription-detector';
import { SubscriptionReviewConflictError } from './subscription-review-service';
import type {
  SubscriptionReviewAction,
  SubscriptionReviewRecordV1,
  SubscriptionReviewRepository,
} from './subscription-review-service';

type StoredCandidateRow = Readonly<{
  actualAccountId: string | null;
  actualPayeeId: string;
  actualScheduleId: string | null;
  amountVarianceBasisPoints: number;
  cadence: string;
  cadenceInterval: number;
  candidateType: string;
  confidence: number;
  dateVarianceDays: number;
  decidedAt: string | null;
  detectorVersion: number;
  evaluatedAt: string;
  firstDate: string;
  lastDate: string;
  medianAmount: number;
  occurrenceCount: number;
  reasonCodesJson: string;
  recentPriceChangeBasisPoints: number | null;
  signature: string;
  status: string;
}>;

const cadences = new Set<SubscriptionCadence>([
  'weekly',
  'monthly',
  'quarterly',
  'annual',
  'unknown',
]);
const candidateTypes = new Set<SubscriptionCandidateType>([
  'subscription',
  'household_bill',
  'financial_bill',
  'unknown',
]);
const candidateStatuses = new Set<SubscriptionCandidateStatus>([
  'pending',
  'approved',
  'rejected',
  'deferred',
  'stale',
  'applied',
]);
const reasonCodes = new Set<SubscriptionReasonCode>([
  'cadence-weekly',
  'cadence-monthly',
  'cadence-quarterly',
  'cadence-annual',
  'cadence-ambiguous',
  'minimum-occurrences',
  'billing-date-variance',
  'stable-amount',
  'amount-variance',
  'price-change',
  'gap-detected',
  'reconciled-history',
  'existing-schedule',
  'schedule-ambiguous',
]);

export class SqliteSubscriptionCandidateRepository implements SubscriptionReviewRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly createId: () => string = randomUUID,
  ) {}

  readCandidates(detectorVersion: number): readonly SubscriptionCandidateV1[] {
    if (detectorVersion !== subscriptionDetectorVersion) {
      throw new TypeError('Unsupported subscription detector version.');
    }
    const rows = this.database
      .prepare(
        `SELECT
          actual_account_id AS actualAccountId,
          actual_payee_id AS actualPayeeId,
          actual_schedule_id AS actualScheduleId,
          amount_variance_basis_points AS amountVarianceBasisPoints,
          cadence,
          cadence_interval AS cadenceInterval,
          candidate_type AS candidateType,
          confidence,
          date_variance_days AS dateVarianceDays,
          decided_at AS decidedAt,
          detector_version AS detectorVersion,
          evaluated_at AS evaluatedAt,
          first_date AS firstDate,
          last_date AS lastDate,
          median_amount AS medianAmount,
          occurrence_count AS occurrenceCount,
          reason_codes_json AS reasonCodesJson,
          recent_price_change_basis_points AS recentPriceChangeBasisPoints,
          signature,
          status
        FROM subscription_candidates
        WHERE detector_version = ?
        ORDER BY signature`,
      )
      .all(detectorVersion) as StoredCandidateRow[];
    return rows.map(projectStoredCandidate);
  }

  persistCandidates(candidates: readonly SubscriptionCandidateV1[]): void {
    const signatures = new Set<string>();
    for (const candidate of candidates) {
      if (signatures.has(candidate.signature)) {
        throw new TypeError('Duplicate subscription candidate signature.');
      }
      signatures.add(candidate.signature);
    }
    const upsert = this.database.prepare(
      `INSERT INTO subscription_candidates (
        id,
        actual_payee_id,
        actual_account_id,
        signature,
        detector_version,
        cadence,
        cadence_interval,
        occurrence_count,
        first_date,
        last_date,
        median_amount,
        amount_variance_basis_points,
        date_variance_days,
        recent_price_change_basis_points,
        candidate_type,
        confidence,
        reason_codes_json,
        status,
        actual_schedule_id,
        evaluated_at,
        decided_at
      ) VALUES (
        @id,
        @actualPayeeId,
        @actualAccountId,
        @signature,
        @detectorVersion,
        @cadence,
        @cadenceInterval,
        @occurrenceCount,
        @firstDate,
        @lastDate,
        @medianAmount,
        @amountVarianceBasisPoints,
        @dateVarianceDays,
        @recentPriceChangeBasisPoints,
        @candidateType,
        @confidence,
        @reasonCodesJson,
        @status,
        @actualScheduleId,
        @evaluatedAt,
        CASE
          WHEN @status IN ('approved', 'rejected', 'deferred', 'applied') THEN (
            SELECT decided_at
            FROM subscription_candidates
            WHERE signature = @signature AND detector_version = @detectorVersion
          )
          ELSE NULL
        END
      )
      ON CONFLICT(signature, detector_version) DO UPDATE SET
        actual_payee_id = excluded.actual_payee_id,
        actual_account_id = excluded.actual_account_id,
        cadence = excluded.cadence,
        cadence_interval = excluded.cadence_interval,
        occurrence_count = excluded.occurrence_count,
        first_date = excluded.first_date,
        last_date = excluded.last_date,
        median_amount = excluded.median_amount,
        amount_variance_basis_points = excluded.amount_variance_basis_points,
        date_variance_days = excluded.date_variance_days,
        recent_price_change_basis_points = excluded.recent_price_change_basis_points,
        candidate_type = excluded.candidate_type,
        confidence = excluded.confidence,
        reason_codes_json = excluded.reason_codes_json,
        status = excluded.status,
        actual_schedule_id = excluded.actual_schedule_id,
        evaluated_at = excluded.evaluated_at,
        decided_at = CASE
          WHEN excluded.status = 'pending' THEN NULL
          ELSE subscription_candidates.decided_at
        END
      WHERE subscription_candidates.status <> 'rejected'`,
    );
    this.database
      .transaction((rows: readonly SubscriptionCandidateV1[]) => {
        for (const candidate of rows) {
          upsert.run({
            actualAccountId: candidate.accountId,
            actualPayeeId: candidate.payeeId,
            actualScheduleId: candidate.actualScheduleId,
            amountVarianceBasisPoints: candidate.amountVarianceBasisPoints,
            cadence: candidate.cadence,
            cadenceInterval: candidate.cadenceInterval,
            candidateType: candidate.candidateType,
            confidence: candidate.confidence,
            dateVarianceDays: candidate.dateVarianceDays,
            detectorVersion: candidate.detectorVersion,
            evaluatedAt: candidate.evaluatedAt,
            firstDate: candidate.firstDate,
            id: this.createId(),
            lastDate: candidate.lastDate,
            medianAmount: candidate.medianAmount,
            occurrenceCount: candidate.occurrenceCount,
            reasonCodesJson: canonicalJson(candidate.reasonCodes),
            recentPriceChangeBasisPoints:
              candidate.recentPriceChangeBasisPoints,
            signature: candidate.signature,
            status: candidate.status,
          });
        }
      })
      .immediate(candidates);
  }

  rejectCandidate(
    signature: string,
    detectorVersion: number,
    decidedAt: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE subscription_candidates
        SET status = 'rejected', decided_at = ?
        WHERE signature = ? AND detector_version = ?`,
      )
      .run(decidedAt, signature, detectorVersion);
    if (result.changes !== 1) {
      throw new TypeError('Subscription candidate does not exist.');
    }
  }

  listSubscriptionReviewRecords(): readonly SubscriptionReviewRecordV1[] {
    const rows = this.database
      .prepare(
        `SELECT
          actual_account_id AS actualAccountId,
          actual_payee_id AS actualPayeeId,
          actual_schedule_id AS actualScheduleId,
          amount_variance_basis_points AS amountVarianceBasisPoints,
          cadence,
          cadence_interval AS cadenceInterval,
          candidate_type AS candidateType,
          confidence,
          date_variance_days AS dateVarianceDays,
          decided_at AS decidedAt,
          detector_version AS detectorVersion,
          evaluated_at AS evaluatedAt,
          first_date AS firstDate,
          last_date AS lastDate,
          median_amount AS medianAmount,
          occurrence_count AS occurrenceCount,
          reason_codes_json AS reasonCodesJson,
          recent_price_change_basis_points AS recentPriceChangeBasisPoints,
          signature,
          status
        FROM subscription_candidates
        ORDER BY
          CASE status WHEN 'pending' THEN 0 ELSE 1 END,
          confidence DESC,
          evaluated_at,
          signature`,
      )
      .all() as StoredCandidateRow[];
    return rows.map(row => ({
      candidate: projectStoredCandidate(row),
      decidedAt: row.decidedAt,
    }));
  }

  recordSubscriptionReviewDecision(
    record: SubscriptionReviewRecordV1,
    action: SubscriptionReviewAction,
    decidedAt: string,
  ): SubscriptionReviewRecordV1 {
    assertTimestamp(decidedAt);
    const update = () => {
      const result =
        action.kind === 'reopen'
          ? this.database
              .prepare(
                `UPDATE subscription_candidates
                SET status = 'pending', candidate_type = 'unknown', decided_at = NULL
                WHERE signature = ? AND detector_version = ?
                  AND status IN ('approved', 'rejected', 'deferred')
                  AND evaluated_at = ? AND actual_schedule_id IS ?`,
              )
              .run(
                record.candidate.signature,
                record.candidate.detectorVersion,
                record.candidate.evaluatedAt,
                record.candidate.actualScheduleId,
              )
          : this.database
              .prepare(
                `UPDATE subscription_candidates
                SET status = ?, candidate_type = ?, decided_at = ?
                WHERE signature = ? AND detector_version = ? AND status = 'pending'
                  AND evaluated_at = ? AND actual_schedule_id IS ?`,
              )
              .run(
                action.kind === 'approve'
                  ? 'approved'
                  : action.kind === 'defer'
                    ? 'deferred'
                    : 'rejected',
                action.kind === 'approve' ? action.userSelectedType : 'unknown',
                decidedAt,
                record.candidate.signature,
                record.candidate.detectorVersion,
                record.candidate.evaluatedAt,
                record.candidate.actualScheduleId,
              );
      if (result.changes !== 1) {
        throw new SubscriptionReviewConflictError();
      }
      const decided = this.listSubscriptionReviewRecords().find(
        candidateRecord =>
          candidateRecord.candidate.signature === record.candidate.signature &&
          candidateRecord.candidate.detectorVersion ===
            record.candidate.detectorVersion,
      );
      if (decided === undefined) {
        throw new SubscriptionReviewConflictError();
      }
      return decided;
    };
    return this.database.transaction(update).immediate();
  }
}

function projectStoredCandidate(
  row: StoredCandidateRow,
): SubscriptionCandidateV1 {
  const parsedReasonCodes = JSON.parse(row.reasonCodesJson) as unknown;
  if (
    row.actualAccountId === null ||
    !cadences.has(row.cadence as SubscriptionCadence) ||
    row.cadenceInterval !== 1 ||
    !candidateTypes.has(row.candidateType as SubscriptionCandidateType) ||
    !candidateStatuses.has(row.status as SubscriptionCandidateStatus) ||
    row.detectorVersion !== subscriptionDetectorVersion ||
    !Array.isArray(parsedReasonCodes) ||
    parsedReasonCodes.some(
      reasonCode =>
        typeof reasonCode !== 'string' ||
        !reasonCodes.has(reasonCode as SubscriptionReasonCode),
    )
  ) {
    throw new TypeError('Stored subscription candidate is invalid.');
  }
  return {
    accountId: row.actualAccountId,
    actualScheduleId: row.actualScheduleId,
    amountVarianceBasisPoints: row.amountVarianceBasisPoints,
    cadence: row.cadence as SubscriptionCadence,
    cadenceInterval: 1,
    candidateType: row.candidateType as SubscriptionCandidateType,
    confidence: row.confidence,
    dateVarianceDays: row.dateVarianceDays,
    detectorVersion: subscriptionDetectorVersion,
    evaluatedAt: row.evaluatedAt,
    firstDate: row.firstDate,
    lastDate: row.lastDate,
    medianAmount: row.medianAmount,
    occurrenceCount: row.occurrenceCount,
    payeeId: row.actualPayeeId,
    reasonCodes: parsedReasonCodes as SubscriptionReasonCode[],
    recentPriceChangeBasisPoints: row.recentPriceChangeBasisPoints,
    signature: row.signature,
    status: row.status as SubscriptionCandidateStatus,
  };
}

function assertTimestamp(value: string): void {
  const date = new Date(value);
  if (
    value.length !== 24 ||
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== value
  ) {
    throw new TypeError('Subscription review timestamp is invalid.');
  }
}
