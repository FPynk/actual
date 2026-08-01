import type Database from 'better-sqlite3';

import { canonicalJson } from '#actual/canonical-json';

import {
  assertTimestamp,
  reconciliationMatcherVersion,
  reconciliationReasonCodes,
} from './candidates';
import type {
  ReconciliationCandidateRepository,
  ReconciliationCandidateStatus,
  ReconciliationCandidateV1,
  ReconciliationReasonCode,
} from './candidates';

type StoredCandidateRow = Readonly<{
  id: string;
  source_transaction_id: string;
  actual_transaction_id: string;
  actual_target_version: string;
  score: number;
  reason_codes_json: string;
  matcher_version: number;
  status: string;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}>;

const candidateStatuses = new Set<ReconciliationCandidateStatus>([
  'pending',
  'approved',
  'rejected',
  'stale',
  'superseded',
]);
const allowedReasonCodes = new Set<ReconciliationReasonCode>(
  reconciliationReasonCodes,
);

export class SqliteReconciliationCandidateRepository implements ReconciliationCandidateRepository {
  private readonly database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
  }

  findBySourceAndActual(
    sourceTransactionId: string,
    actualTransactionId: string,
    matcherVersion: number,
  ): ReconciliationCandidateV1 | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM reconciliation_candidates WHERE source_transaction_id = ? AND actual_transaction_id = ? AND matcher_version = ?',
      )
      .get(sourceTransactionId, actualTransactionId, matcherVersion) as
      | StoredCandidateRow
      | undefined;
    return row === undefined ? undefined : decodeCandidate(row);
  }

  save(candidate: ReconciliationCandidateV1): ReconciliationCandidateV1 {
    validateCandidate(candidate);
    const result = this.database
      .prepare(
        `INSERT INTO reconciliation_candidates (
          id,
          source_transaction_id,
          actual_transaction_id,
          actual_target_version,
          score,
          reason_codes_json,
          matcher_version,
          status,
          decision_note,
          decided_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        candidate.id,
        candidate.sourceTransactionId,
        candidate.actualTransactionId,
        candidate.actualTargetVersion,
        candidate.score,
        canonicalJson(candidate.reasonCodes),
        candidate.matcherVersion,
        candidate.status,
        candidate.decisionNote,
        candidate.decidedAt,
        candidate.createdAt,
      );
    if (result.changes === 1) return candidate;
    const sameId = this.database
      .prepare('SELECT * FROM reconciliation_candidates WHERE id = ?')
      .get(candidate.id) as StoredCandidateRow | undefined;
    if (sameId === undefined) {
      throw new Error('Reconciliation candidate persistence failed.');
    }
    const storedCandidate = decodeCandidate(sameId);
    if (!areCandidatesEquivalent(storedCandidate, candidate)) {
      throw new Error(
        'Reconciliation candidate ID conflicts with stored data.',
      );
    }
    return storedCandidate;
  }

  list(): readonly ReconciliationCandidateV1[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM reconciliation_candidates ORDER BY source_transaction_id, score DESC, actual_transaction_id, id',
        )
        .all() as readonly StoredCandidateRow[]
    ).map(decodeCandidate);
  }

  read(candidateId: string): ReconciliationCandidateV1 {
    return this.readRequired(candidateId);
  }

  recordRevalidatedDecision(
    candidateId: string,
    status: 'approved' | 'rejected',
    decisionNote: string | null,
    decidedAt: string,
  ): ReconciliationCandidateV1 {
    assertTimestamp(decidedAt);
    if (decisionNote !== null && typeof decisionNote !== 'string') {
      throw new TypeError('Reconciliation decision note is invalid.');
    }
    const existing = this.readRequired(candidateId);
    if (existing.status !== 'pending') {
      throw new Error('Reconciliation candidate is not pending.');
    }
    const result = this.database
      .prepare(
        "UPDATE reconciliation_candidates SET status = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(status, decisionNote, decidedAt, candidateId);
    if (result.changes !== 1) {
      throw new Error(
        'Reconciliation candidate decision could not be recorded.',
      );
    }
    return this.readRequired(candidateId);
  }

  markStale(candidateId: string): ReconciliationCandidateV1 {
    const existing = this.readRequired(candidateId);
    if (existing.status === 'pending' || existing.status === 'approved') {
      this.database
        .prepare(
          "UPDATE reconciliation_candidates SET status = 'stale' WHERE id = ?",
        )
        .run(candidateId);
    }
    return this.readRequired(candidateId);
  }

  private readRequired(candidateId: string): ReconciliationCandidateV1 {
    const row = this.database
      .prepare('SELECT * FROM reconciliation_candidates WHERE id = ?')
      .get(candidateId) as StoredCandidateRow | undefined;
    if (row === undefined) {
      throw new Error('Reconciliation candidate is missing.');
    }
    return decodeCandidate(row);
  }
}

function decodeCandidate(row: StoredCandidateRow): ReconciliationCandidateV1 {
  const candidate: ReconciliationCandidateV1 = {
    actualTargetVersion: row.actual_target_version,
    actualTransactionId: row.actual_transaction_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    id: row.id,
    matcherVersion: row.matcher_version as typeof reconciliationMatcherVersion,
    reasonCodes: parseReasonCodes(row.reason_codes_json),
    score: row.score,
    sourceTransactionId: row.source_transaction_id,
    status: row.status as ReconciliationCandidateStatus,
  };
  validateCandidate(candidate);
  return candidate;
}

function validateCandidate(candidate: ReconciliationCandidateV1): void {
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    typeof candidate.sourceTransactionId !== 'string' ||
    candidate.sourceTransactionId.length === 0 ||
    typeof candidate.actualTransactionId !== 'string' ||
    candidate.actualTransactionId.length === 0 ||
    !Number.isSafeInteger(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 100 ||
    candidate.matcherVersion !== reconciliationMatcherVersion ||
    !candidateStatuses.has(candidate.status) ||
    !isValidReasonCodes(candidate.reasonCodes) ||
    (candidate.decisionNote !== null &&
      typeof candidate.decisionNote !== 'string')
  ) {
    throw new TypeError('Reconciliation candidate DTO is invalid.');
  }
  assertHash(candidate.actualTargetVersion);
  assertTimestamp(candidate.createdAt);
  if (candidate.decidedAt !== null) assertTimestamp(candidate.decidedAt);
  if (
    (candidate.status === 'pending' && candidate.decidedAt !== null) ||
    ((candidate.status === 'approved' || candidate.status === 'rejected') &&
      candidate.decidedAt === null)
  ) {
    throw new TypeError('Reconciliation candidate decision state is invalid.');
  }
}

function parseReasonCodes(
  serialized: string,
): readonly ReconciliationReasonCode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError('Stored reconciliation candidate reasons are invalid.');
  }
  if (!Array.isArray(parsed) || !isValidReasonCodes(parsed)) {
    throw new TypeError('Stored reconciliation candidate reasons are invalid.');
  }
  return parsed;
}

function isValidReasonCodes(
  reasonCodes: readonly unknown[],
): reasonCodes is readonly ReconciliationReasonCode[] {
  return (
    reasonCodes.length > 0 &&
    reasonCodes.every(
      reasonCode =>
        typeof reasonCode === 'string' &&
        allowedReasonCodes.has(reasonCode as ReconciliationReasonCode),
    ) &&
    new Set(reasonCodes).size === reasonCodes.length
  );
}

function assertHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Reconciliation target hash is invalid.');
  }
}

function areCandidatesEquivalent(
  left: ReconciliationCandidateV1,
  right: ReconciliationCandidateV1,
): boolean {
  return (
    left.id === right.id &&
    left.sourceTransactionId === right.sourceTransactionId &&
    left.actualTransactionId === right.actualTransactionId &&
    left.actualTargetVersion === right.actualTargetVersion &&
    left.score === right.score &&
    canonicalJson(left.reasonCodes) === canonicalJson(right.reasonCodes) &&
    left.matcherVersion === right.matcherVersion &&
    left.status === right.status &&
    left.decisionNote === right.decisionNote &&
    left.decidedAt === right.decidedAt &&
    left.createdAt === right.createdAt
  );
}
