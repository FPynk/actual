import { randomUUID } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import { canonicalJson } from '#actual/canonical-json';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import type {
  SourceIdentityRepository,
  SourceTransactionForReconciliation,
} from '#database/source-identity-repository';
import {
  normalizeImportedPayeeV1,
  targetVersionHash,
} from '#reviews/classification';

export const reconciliationMatcherVersion = 1 as const;

export const reconciliationReasonCodes = [
  'source-observation',
  'fingerprint-review-only',
  'stable-id-agreement',
  'changed-id-review-only',
  'stable-id-unavailable',
  'exact-account',
  'exact-amount',
  'date-exact',
  'date-within-three-days',
  'date-outside-window',
  'payee-match',
  'payee-unavailable',
  'payee-mismatch',
  'pending-compatible',
  'posted-compatible',
  'pending-cleared-conflict',
  'posted-uncleared',
  'booking-status-unknown',
] as const;

export type ReconciliationReasonCode =
  (typeof reconciliationReasonCodes)[number];

export type ReconciliationCandidateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'superseded';

export type ReconciliationCandidateV1 = Readonly<{
  id: string;
  sourceTransactionId: string;
  actualTransactionId: string;
  actualTargetVersion: string;
  score: number;
  reasonCodes: readonly ReconciliationReasonCode[];
  matcherVersion: typeof reconciliationMatcherVersion;
  status: ReconciliationCandidateStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}>;

export type ReconciliationCandidateRepository = Readonly<{
  findBySourceAndActual(
    sourceTransactionId: string,
    actualTransactionId: string,
    matcherVersion: number,
  ): ReconciliationCandidateV1 | undefined;
  save(candidate: ReconciliationCandidateV1): ReconciliationCandidateV1;
  list(): readonly ReconciliationCandidateV1[];
  read(candidateId: string): ReconciliationCandidateV1;
  recordRevalidatedDecision(
    candidateId: string,
    status: 'approved' | 'rejected',
    decisionNote: string | null,
    decidedAt: string,
  ): ReconciliationCandidateV1;
  markStale(candidateId: string): ReconciliationCandidateV1;
}>;

export type ReconciliationCandidateGenerationRequest = Readonly<{
  adapter: ActualAdapter;
  sourceIdentityRepository: SourceIdentityRepository;
  candidateRepository: ReconciliationCandidateRepository;
  snapshot: ActualBudgetSnapshotV1;
  createdAt: string;
  createId?: () => string;
}>;

export async function generateReconciliationCandidates(
  request: ReconciliationCandidateGenerationRequest,
): Promise<readonly ReconciliationCandidateV1[]> {
  assertTimestamp(request.createdAt);
  const createId = request.createId ?? randomUUID;
  await revalidateStoredCandidates(
    request.candidateRepository,
    request.adapter,
  );
  const payeeNames = new Map(
    (request.snapshot.payees ?? []).map(payee => [payee.id, payee.name]),
  );
  const matchingTargets = (request.snapshot.transactions ?? []).filter(
    transaction => isEligibleActualTarget(transaction),
  );
  for (const source of request.sourceIdentityRepository.readReconciliationSources()) {
    for (const target of matchingTargets) {
      await createCandidateIfHardGatesMatch(
        source,
        target,
        payeeNames,
        request.adapter,
        request.createdAt,
        createId,
        request.candidateRepository,
      );
    }
  }
  return [...request.candidateRepository.list()].sort(compareCandidates);
}

export async function decideReconciliationCandidate(
  request: Readonly<{
    adapter: ActualAdapter;
    candidateRepository: ReconciliationCandidateRepository;
    candidateId: string;
    status: 'approved' | 'rejected';
    decisionNote: string | null;
    decidedAt: string;
  }>,
): Promise<ReconciliationCandidateV1> {
  assertTimestamp(request.decidedAt);
  const candidate = request.candidateRepository.read(request.candidateId);
  if (candidate.status !== 'pending') {
    throw new Error('Reconciliation candidate is not pending.');
  }
  const target = await readCurrentActualTarget(
    request.adapter,
    candidate.actualTransactionId,
  );
  if (
    target === null ||
    !isEligibleActualTarget(target.parent) ||
    target.targetVersionHash !== candidate.actualTargetVersion
  ) {
    return request.candidateRepository.markStale(candidate.id);
  }
  return request.candidateRepository.recordRevalidatedDecision(
    candidate.id,
    request.status,
    request.decisionNote,
    request.decidedAt,
  );
}

async function revalidateStoredCandidates(
  repository: ReconciliationCandidateRepository,
  adapter: ActualAdapter,
): Promise<void> {
  for (const candidate of repository.list()) {
    if (candidate.status !== 'pending' && candidate.status !== 'approved') {
      continue;
    }
    const target = await readCurrentActualTarget(
      adapter,
      candidate.actualTransactionId,
    );
    if (
      target === null ||
      !isEligibleActualTarget(target.parent) ||
      target.targetVersionHash !== candidate.actualTargetVersion
    ) {
      repository.markStale(candidate.id);
    }
  }
}

async function createCandidateIfHardGatesMatch(
  source: SourceTransactionForReconciliation,
  target: ActualTransactionV1,
  payeeNames: ReadonlyMap<string, string>,
  adapter: ActualAdapter,
  createdAt: string,
  createId: () => string,
  repository: ReconciliationCandidateRepository,
): Promise<ReconciliationCandidateV1 | undefined> {
  if (
    source.actualAccountId !== target.accountId ||
    source.amount !== target.amountMinorUnits
  ) {
    return undefined;
  }
  const existing = repository.findBySourceAndActual(
    source.id,
    target.id,
    reconciliationMatcherVersion,
  );
  if (existing !== undefined) return existing;
  const graph = await readCurrentActualTarget(adapter, target.id);
  if (graph === null) return undefined;
  assertTargetMatchesSnapshot(target, graph);
  const actualTargetVersion = graph.targetVersionHash;
  if (graph.parent.reconciled) return undefined;
  const match = scoreCandidate(source, graph.parent, payeeNames);
  return repository.save({
    actualTargetVersion,
    actualTransactionId: graph.parent.id,
    createdAt,
    decisionNote: null,
    decidedAt: null,
    id: createId(),
    matcherVersion: reconciliationMatcherVersion,
    reasonCodes: match.reasonCodes,
    score: match.score,
    sourceTransactionId: source.id,
    status: 'pending',
  });
}

async function readCurrentActualTarget(
  adapter: ActualAdapter,
  actualTransactionId: string,
): Promise<ActualTransactionGraphV1 | null> {
  const response = await adapter.execute({
    kind: 'read-actual-target',
    target: { id: actualTransactionId, kind: 'transaction' },
  });
  if (response.kind !== 'read-actual-target') {
    throw new Error(
      'Actual adapter returned an unexpected reconciliation read.',
    );
  }
  const graph = response.target;
  if (graph === null) return null;
  if (
    graph.parent.id !== actualTransactionId ||
    graph.targetVersionHash !== targetVersionHash(graph)
  ) {
    throw new Error('Actual reconciliation target hash is invalid.');
  }
  return graph;
}

export function scoreCandidate(
  source: SourceTransactionForReconciliation,
  target: ActualTransactionV1,
  payeeNames: ReadonlyMap<string, string> = new Map(),
): Readonly<{
  score: number;
  reasonCodes: readonly ReconciliationReasonCode[];
}> {
  if (
    source.actualAccountId !== target.accountId ||
    source.amount !== target.amountMinorUnits
  ) {
    throw new Error(
      'Reconciliation candidate requires exact account and amount.',
    );
  }
  const reasonCodes: ReconciliationReasonCode[] = [
    'source-observation',
    'fingerprint-review-only',
    source.externalTransactionId === null || target.importedId === null
      ? 'stable-id-unavailable'
      : source.externalTransactionId === target.importedId
        ? 'stable-id-agreement'
        : 'changed-id-review-only',
    'exact-account',
    'exact-amount',
  ];
  let score = 60;
  const dateDistance = dateDistanceInDays(
    source.postedDate ?? source.transactionDate,
    target.date,
  );
  if (dateDistance === 0) {
    reasonCodes.push('date-exact');
    score += 20;
  } else if (dateDistance <= 3) {
    reasonCodes.push('date-within-three-days');
    score += 10;
  } else {
    reasonCodes.push('date-outside-window');
  }
  const sourcePayee =
    source.normalizedPayeeKey ?? normalizeOptionalPayee(source.importedPayee);
  const targetPayee = normalizeOptionalPayee(
    target.importedPayee ??
      (target.payeeId === null
        ? null
        : (payeeNames.get(target.payeeId) ?? null)),
  );
  if (sourcePayee === null || targetPayee === null) {
    reasonCodes.push('payee-unavailable');
  } else if (sourcePayee === targetPayee) {
    reasonCodes.push('payee-match');
    score += 15;
  } else {
    reasonCodes.push('payee-mismatch');
  }
  if (source.bookingStatus === 'pending') {
    if (!target.cleared) {
      reasonCodes.push('pending-compatible');
      score += 5;
    } else {
      reasonCodes.push('pending-cleared-conflict');
    }
  } else if (source.bookingStatus === 'posted') {
    if (target.cleared) {
      reasonCodes.push('posted-compatible');
      score += 5;
    } else {
      reasonCodes.push('posted-uncleared');
    }
  } else {
    reasonCodes.push('booking-status-unknown');
  }
  return { reasonCodes, score };
}

function assertTargetMatchesSnapshot(
  target: ActualTransactionV1,
  graph: ActualTransactionGraphV1,
): void {
  if (
    graph.parent.id !== target.id ||
    graph.parent.isChild ||
    graph.parent.tombstone ||
    canonicalJson(graph.parent) !== canonicalJson(target)
  ) {
    throw new Error(
      'Actual reconciliation target no longer matches the snapshot.',
    );
  }
}

function isEligibleActualTarget(transaction: ActualTransactionV1): boolean {
  return (
    !transaction.tombstone &&
    !transaction.isChild &&
    !transaction.isStartingBalance &&
    !transaction.reconciled
  );
}

function normalizeOptionalPayee(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  return normalizeImportedPayeeV1(value);
}

function dateDistanceInDays(left: string, right: string): number {
  assertDate(left);
  assertDate(right);
  return Math.abs(
    (Date.parse(`${left}T00:00:00.000Z`) -
      Date.parse(`${right}T00:00:00.000Z`)) /
      (24 * 60 * 60 * 1000),
  );
}

function assertDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error('Reconciliation date is invalid.');
  }
}

export function assertTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('Reconciliation timestamp is invalid.');
  }
}

function compareCandidates(
  left: ReconciliationCandidateV1,
  right: ReconciliationCandidateV1,
): number {
  return (
    left.sourceTransactionId.localeCompare(right.sourceTransactionId) ||
    right.score - left.score ||
    left.actualTransactionId.localeCompare(right.actualTransactionId)
  );
}
