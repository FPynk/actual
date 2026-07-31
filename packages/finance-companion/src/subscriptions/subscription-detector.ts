import { createHash } from 'node:crypto';

import { canonicalJson } from '#actual/canonical-json';
import type { SubscriptionScheduleSnapshotV1 } from '#contracts/adapter';

export type { SubscriptionScheduleSnapshotV1 } from '#contracts/adapter';

export const subscriptionDetectorVersion = 1;

export type SubscriptionCadence =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'unknown';

export type SubscriptionCandidateType =
  | 'subscription'
  | 'household_bill'
  | 'financial_bill'
  | 'unknown';

export type SubscriptionCandidateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'deferred'
  | 'stale'
  | 'applied';

export type SubscriptionReasonCode =
  | 'cadence-weekly'
  | 'cadence-monthly'
  | 'cadence-quarterly'
  | 'cadence-annual'
  | 'cadence-ambiguous'
  | 'minimum-occurrences'
  | 'billing-date-variance'
  | 'stable-amount'
  | 'amount-variance'
  | 'price-change'
  | 'gap-detected'
  | 'reconciled-history'
  | 'existing-schedule'
  | 'schedule-ambiguous';

export type SubscriptionHistoryTransactionV1 = Readonly<{
  id: string;
  accountId: string;
  payeeId: string | null;
  date: string;
  amount: number;
  isReconciled: boolean;
  isTransfer: boolean;
  isSplitParent: boolean;
  isStartingBalance: boolean;
  isTombstone: boolean;
}>;

export type SubscriptionCandidateV1 = Readonly<{
  detectorVersion: 1;
  signature: string;
  accountId: string;
  payeeId: string;
  cadence: SubscriptionCadence;
  cadenceInterval: 1;
  occurrenceCount: number;
  firstDate: string;
  lastDate: string;
  medianAmount: number;
  amountVarianceBasisPoints: number;
  dateVarianceDays: number;
  recentPriceChangeBasisPoints: number | null;
  candidateType: SubscriptionCandidateType;
  confidence: number;
  reasonCodes: readonly SubscriptionReasonCode[];
  status: SubscriptionCandidateStatus;
  actualScheduleId: string | null;
  evaluatedAt: string;
}>;

export type SubscriptionDetectorClock = Readonly<{ now(): Date }>;

export type SubscriptionDetectorInput = Readonly<{
  transactions: readonly SubscriptionHistoryTransactionV1[];
  schedules: readonly SubscriptionScheduleSnapshotV1[];
}>;

type CalendarDate = Readonly<{
  year: number;
  month: number;
  day: number;
  epochDay: number;
}>;

type Observation = Readonly<{
  transaction: SubscriptionHistoryTransactionV1;
  calendarDate: CalendarDate;
  amountMagnitude: number;
}>;

type CadenceDefinition = Readonly<{
  cadence: Exclude<SubscriptionCadence, 'unknown'>;
  minimumObservations: number;
  toleranceDays: number;
  addStep(date: CalendarDate, stepCount: number): number;
}>;

type CadenceRun = Readonly<{
  cadenceDefinition: CadenceDefinition;
  observations: readonly Observation[];
  dateVarianceDays: number;
  hasGap: boolean;
}>;

type AmountEvidence = Readonly<{
  medianAmount: number;
  amountVarianceBasisPoints: number;
  recentPriceChangeBasisPoints: number | null;
  isEligible: boolean;
}>;

const millisecondsPerDay = 86_400_000;

const cadenceDefinitions: readonly CadenceDefinition[] = [
  {
    cadence: 'weekly',
    minimumObservations: 4,
    toleranceDays: 2,
    addStep: (date, stepCount) => date.epochDay + 7 * stepCount,
  },
  {
    cadence: 'monthly',
    minimumObservations: 3,
    toleranceDays: 4,
    addStep: (date, stepCount) => addCalendarMonths(date, stepCount),
  },
  {
    cadence: 'quarterly',
    minimumObservations: 3,
    toleranceDays: 4,
    addStep: (date, stepCount) => addCalendarMonths(date, 3 * stepCount),
  },
  {
    cadence: 'annual',
    minimumObservations: 2,
    toleranceDays: 7,
    addStep: (date, stepCount) => addCalendarMonths(date, 12 * stepCount),
  },
];

const reasonCodeOrder: readonly SubscriptionReasonCode[] = [
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
];

export function detectSubscriptionCandidates(
  input: SubscriptionDetectorInput,
  clock: SubscriptionDetectorClock,
): readonly SubscriptionCandidateV1[] {
  const evaluatedAt = readClock(clock);
  const groups = groupEligibleObservations(input.transactions);
  const candidates: SubscriptionCandidateV1[] = [];

  for (const observations of groups.values()) {
    const qualifyingRuns = cadenceDefinitions.flatMap(cadenceDefinition =>
      findQualifyingRuns(observations, cadenceDefinition),
    );
    for (const runGroup of groupOverlappingRuns(qualifyingRuns)) {
      candidates.push(
        runGroup.length === 1
          ? buildCandidate(
              runGroup[0].observations,
              runGroup[0].cadenceDefinition.cadence,
              runGroup[0].cadenceDefinition.minimumObservations,
              runGroup[0].cadenceDefinition.toleranceDays,
              runGroup[0].dateVarianceDays,
              runGroup[0].hasGap,
              input.schedules,
              evaluatedAt,
            )
          : buildAmbiguousCandidate(runGroup, input.schedules, evaluatedAt),
      );
    }
  }

  const newestCandidateBySignature = new Map<string, SubscriptionCandidateV1>();
  for (const candidate of candidates) {
    const existing = newestCandidateBySignature.get(candidate.signature);
    if (existing === undefined || isPreferredRun(candidate, existing)) {
      newestCandidateBySignature.set(candidate.signature, candidate);
    }
  }
  return [...newestCandidateBySignature.values()].sort(compareCandidates);
}

export function matchingScheduleIds(
  candidate: Pick<SubscriptionCandidateV1, 'accountId' | 'payeeId' | 'cadence'>,
  schedules: readonly SubscriptionScheduleSnapshotV1[],
): readonly string[] {
  const cadence = candidate.cadence;
  if (cadence === 'unknown') return [];
  return schedules
    .filter(
      schedule =>
        !schedule.isCompleted &&
        schedule.accountId === candidate.accountId &&
        schedule.payeeId === candidate.payeeId &&
        scheduleMatchesCadence(schedule, cadence),
    )
    .map(schedule => schedule.id)
    .sort(compareStrings);
}

function groupEligibleObservations(
  transactions: readonly SubscriptionHistoryTransactionV1[],
): ReadonlyMap<string, readonly Observation[]> {
  const sortedTransactions = [...transactions].sort((left, right) => {
    const dateComparison = compareStrings(left.date, right.date);
    return dateComparison === 0
      ? compareStrings(left.id, right.id)
      : dateComparison;
  });
  const seenTransactionIds = new Set<string>();
  const groups = new Map<string, Observation[]>();
  for (const transaction of sortedTransactions) {
    if (seenTransactionIds.has(transaction.id)) continue;
    seenTransactionIds.add(transaction.id);
    if (
      transaction.payeeId === null ||
      transaction.payeeId.length === 0 ||
      !Number.isSafeInteger(transaction.amount) ||
      transaction.amount >= 0 ||
      transaction.isTransfer ||
      transaction.isSplitParent ||
      transaction.isStartingBalance ||
      transaction.isTombstone
    ) {
      continue;
    }
    const observation = {
      amountMagnitude: Math.abs(transaction.amount),
      calendarDate: parseCalendarDate(transaction.date),
      transaction,
    } satisfies Observation;
    const groupKey = `${transaction.accountId}\0${transaction.payeeId}`;
    const group = groups.get(groupKey) ?? [];
    group.push(observation);
    groups.set(groupKey, group);
  }
  return groups;
}

function findQualifyingRuns(
  observations: readonly Observation[],
  cadenceDefinition: CadenceDefinition,
): readonly CadenceRun[] {
  const runs: CadenceRun[] = [];
  let runStartIndex = 0;
  let transitionEvidence: Readonly<{
    residualDays: number;
    isGap: boolean;
  }>[] = [];

  for (let index = 1; index < observations.length; index += 1) {
    const evidence = cadenceTransition(
      observations[index - 1].calendarDate,
      observations[index].calendarDate,
      cadenceDefinition,
    );
    if (evidence === null) {
      appendQualifyingRun(
        runs,
        observations.slice(runStartIndex, index),
        cadenceDefinition,
        transitionEvidence,
      );
      runStartIndex = index;
      transitionEvidence = [];
    } else {
      transitionEvidence = [...transitionEvidence, evidence];
    }
  }
  appendQualifyingRun(
    runs,
    observations.slice(runStartIndex),
    cadenceDefinition,
    transitionEvidence,
  );
  return runs;
}

function cadenceTransition(
  previousDate: CalendarDate,
  nextDate: CalendarDate,
  cadenceDefinition: CadenceDefinition,
): Readonly<{ residualDays: number; isGap: boolean }> | null {
  const oneStepResidual = Math.abs(
    nextDate.epochDay - cadenceDefinition.addStep(previousDate, 1),
  );
  if (oneStepResidual <= cadenceDefinition.toleranceDays) {
    return { residualDays: oneStepResidual, isGap: false };
  }
  const twoStepResidual = Math.abs(
    nextDate.epochDay - cadenceDefinition.addStep(previousDate, 2),
  );
  if (twoStepResidual <= cadenceDefinition.toleranceDays * 2) {
    return { residualDays: twoStepResidual, isGap: true };
  }
  return null;
}

function appendQualifyingRun(
  runs: CadenceRun[],
  observations: readonly Observation[],
  cadenceDefinition: CadenceDefinition,
  transitionEvidence: readonly Readonly<{
    residualDays: number;
    isGap: boolean;
  }>[],
): void {
  if (
    observations.length < cadenceDefinition.minimumObservations ||
    transitionEvidence.filter(evidence => evidence.isGap).length > 1 ||
    !calculateAmountEvidence(observations).isEligible
  ) {
    return;
  }
  runs.push({
    cadenceDefinition,
    dateVarianceDays: Math.max(
      0,
      ...transitionEvidence.map(evidence => evidence.residualDays),
    ),
    hasGap: transitionEvidence.some(evidence => evidence.isGap),
    observations,
  });
}

function groupOverlappingRuns(
  runs: readonly CadenceRun[],
): readonly (readonly CadenceRun[])[] {
  const parents = runs.map((_run, index) => index);
  const firstRunByTransactionId = new Map<string, number>();
  for (const [runIndex, run] of runs.entries()) {
    for (const observation of run.observations) {
      const existingRun = firstRunByTransactionId.get(
        observation.transaction.id,
      );
      if (existingRun === undefined) {
        firstRunByTransactionId.set(observation.transaction.id, runIndex);
      } else {
        joinRunGroups(parents, runIndex, existingRun);
      }
    }
  }
  const groupedRuns = new Map<number, CadenceRun[]>();
  for (const [runIndex, run] of runs.entries()) {
    const root = findRunGroup(parents, runIndex);
    const group = groupedRuns.get(root) ?? [];
    group.push(run);
    groupedRuns.set(root, group);
  }
  return [...groupedRuns.values()];
}

function findRunGroup(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root];
  let current = index;
  while (parents[current] !== current) {
    const next = parents[current];
    parents[current] = root;
    current = next;
  }
  return root;
}

function joinRunGroups(parents: number[], left: number, right: number): void {
  const leftRoot = findRunGroup(parents, left);
  const rightRoot = findRunGroup(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}

function buildAmbiguousCandidate(
  runs: readonly CadenceRun[],
  schedules: readonly SubscriptionScheduleSnapshotV1[],
  evaluatedAt: string,
): SubscriptionCandidateV1 {
  const observationsById = new Map<string, Observation>();
  for (const run of runs) {
    for (const observation of run.observations) {
      observationsById.set(observation.transaction.id, observation);
    }
  }
  const observations = [...observationsById.values()].sort(compareObservations);
  return buildCandidate(
    observations,
    'unknown',
    Math.max(...runs.map(run => run.cadenceDefinition.minimumObservations)),
    Math.min(...runs.map(run => run.cadenceDefinition.toleranceDays)),
    Math.max(...runs.map(run => run.dateVarianceDays)),
    runs.some(run => run.hasGap),
    schedules,
    evaluatedAt,
  );
}

function buildCandidate(
  observations: readonly Observation[],
  cadence: SubscriptionCadence,
  minimumObservations: number,
  toleranceDays: number,
  dateVarianceDays: number,
  hasGap: boolean,
  schedules: readonly SubscriptionScheduleSnapshotV1[],
  evaluatedAt: string,
): SubscriptionCandidateV1 {
  const amountEvidence = calculateAmountEvidence(observations);
  const firstObservation = observations[0];
  const lastObservation = observations[observations.length - 1];
  const accountId = firstObservation.transaction.accountId;
  const payeeId = firstObservation.transaction.payeeId ?? '';
  const scheduleIds = matchingScheduleIds(
    { accountId, cadence, payeeId },
    schedules,
  );
  const applicableReasons = new Set<SubscriptionReasonCode>([
    cadenceReason(cadence),
    'minimum-occurrences',
    amountEvidence.amountVarianceBasisPoints <= 750
      ? 'stable-amount'
      : 'amount-variance',
  ]);
  if (dateVarianceDays > 0) applicableReasons.add('billing-date-variance');
  if (amountEvidence.recentPriceChangeBasisPoints !== null) {
    applicableReasons.add('price-change');
  }
  if (hasGap) applicableReasons.add('gap-detected');
  if (observations.some(observation => observation.transaction.isReconciled)) {
    applicableReasons.add('reconciled-history');
  }
  if (scheduleIds.length === 1) applicableReasons.add('existing-schedule');
  if (scheduleIds.length > 1) applicableReasons.add('schedule-ambiguous');

  let confidence = 50;
  confidence += Math.min(20, (observations.length - minimumObservations) * 10);
  if (dateVarianceDays <= toleranceDays) confidence += 15;
  if (amountEvidence.amountVarianceBasisPoints <= 750) {
    confidence += 15;
  } else {
    confidence -= 15;
  }
  if (scheduleIds.length === 1) confidence += 5;
  if (hasGap) confidence -= 10;
  if (amountEvidence.recentPriceChangeBasisPoints !== null) confidence -= 10;

  return {
    accountId,
    actualScheduleId: scheduleIds.length === 1 ? scheduleIds[0] : null,
    amountVarianceBasisPoints: amountEvidence.amountVarianceBasisPoints,
    cadence,
    cadenceInterval: 1,
    candidateType: 'unknown',
    confidence: Math.max(0, Math.min(100, confidence)),
    dateVarianceDays,
    detectorVersion: subscriptionDetectorVersion,
    evaluatedAt,
    firstDate: firstObservation.transaction.date,
    lastDate: lastObservation.transaction.date,
    medianAmount: amountEvidence.medianAmount,
    occurrenceCount: observations.length,
    payeeId,
    reasonCodes: reasonCodeOrder.filter(reason =>
      applicableReasons.has(reason),
    ),
    recentPriceChangeBasisPoints: amountEvidence.recentPriceChangeBasisPoints,
    signature: subscriptionSignature(accountId, payeeId, cadence),
    status: 'pending',
  };
}

function calculateAmountEvidence(
  observations: readonly Observation[],
): AmountEvidence {
  const amounts = observations
    .map(observation => observation.amountMagnitude)
    .sort((left, right) => left - right);
  const medianAmount = integerMedian(amounts);
  const amountVarianceBasisPoints = Math.max(
    ...amounts.map(amount => basisPointDifference(amount, medianAmount)),
  );
  let recentPriceChangeBasisPoints: number | null = null;
  if (observations.length > 1) {
    const precedingAmounts = observations
      .slice(0, -1)
      .map(observation => observation.amountMagnitude)
      .sort((left, right) => left - right);
    const precedingMedian = integerMedian(precedingAmounts);
    const precedingVariance = Math.max(
      ...precedingAmounts.map(amount =>
        basisPointDifference(amount, precedingMedian),
      ),
    );
    const lastDifference = basisPointDifference(
      observations[observations.length - 1].amountMagnitude,
      precedingMedian,
    );
    if (
      precedingVariance <= 750 &&
      lastDifference >= 1_000 &&
      lastDifference <= 5_000
    ) {
      recentPriceChangeBasisPoints = lastDifference;
    }
  }
  return {
    amountVarianceBasisPoints,
    isEligible:
      amountVarianceBasisPoints <= 3_500 ||
      (recentPriceChangeBasisPoints !== null &&
        amountVarianceBasisPoints <= 5_000),
    medianAmount,
    recentPriceChangeBasisPoints,
  };
}

function integerMedian(sortedAmounts: readonly number[]): number {
  const midpoint = Math.floor(sortedAmounts.length / 2);
  return sortedAmounts.length % 2 === 1
    ? sortedAmounts[midpoint]
    : Math.round((sortedAmounts[midpoint - 1] + sortedAmounts[midpoint]) / 2);
}

function basisPointDifference(amount: number, medianAmount: number): number {
  return Math.round(
    (Math.abs(amount - medianAmount) * 10_000) / Math.max(1, medianAmount),
  );
}

function scheduleMatchesCadence(
  schedule: SubscriptionScheduleSnapshotV1,
  cadence: Exclude<SubscriptionCadence, 'unknown'>,
): boolean {
  if (schedule.recurrence.kind !== 'recurring') return false;
  if (cadence === 'weekly') {
    return (
      schedule.recurrence.frequency === 'weekly' &&
      schedule.recurrence.interval === 1
    );
  }
  if (cadence === 'monthly' || cadence === 'quarterly') {
    return (
      schedule.recurrence.frequency === 'monthly' &&
      schedule.recurrence.interval === (cadence === 'monthly' ? 1 : 3)
    );
  }
  return (
    schedule.recurrence.frequency === 'yearly' &&
    schedule.recurrence.interval === 1
  );
}

function cadenceReason(cadence: SubscriptionCadence): SubscriptionReasonCode {
  if (cadence === 'unknown') return 'cadence-ambiguous';
  if (cadence === 'weekly') return 'cadence-weekly';
  if (cadence === 'monthly') return 'cadence-monthly';
  if (cadence === 'quarterly') return 'cadence-quarterly';
  return 'cadence-annual';
}

function subscriptionSignature(
  accountId: string,
  payeeId: string,
  cadence: SubscriptionCadence,
): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        'finance-companion/subscription-signature/v1',
        { accountId, cadence, payeeId },
      ]),
    )
    .digest('hex');
}

function parseCalendarDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new TypeError('Invalid subscription history date.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1_000 || month < 1 || month > 12) {
    throw new TypeError('Invalid subscription history date.');
  }
  const daysInMonth = calendarMonthDays(year, month);
  if (day < 1 || day > daysInMonth) {
    throw new TypeError('Invalid subscription history date.');
  }
  return {
    day,
    epochDay: Math.floor(Date.UTC(year, month - 1, day) / millisecondsPerDay),
    month,
    year,
  };
}

function addCalendarMonths(date: CalendarDate, monthCount: number): number {
  const totalMonths = date.year * 12 + date.month - 1 + monthCount;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(date.day, calendarMonthDays(year, month));
  return Math.floor(Date.UTC(year, month - 1, day) / millisecondsPerDay);
}

function calendarMonthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function readClock(clock: SubscriptionDetectorClock): string {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('Invalid subscription detector clock.');
  }
  return now.toISOString();
}

function compareObservations(left: Observation, right: Observation): number {
  const dateComparison =
    left.calendarDate.epochDay - right.calendarDate.epochDay;
  return dateComparison === 0
    ? compareStrings(left.transaction.id, right.transaction.id)
    : dateComparison;
}

function compareStrings(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function compareCandidates(
  left: SubscriptionCandidateV1,
  right: SubscriptionCandidateV1,
): number {
  return (
    compareStrings(left.accountId, right.accountId) ||
    compareStrings(left.payeeId, right.payeeId) ||
    compareStrings(left.cadence, right.cadence) ||
    compareStrings(left.firstDate, right.firstDate) ||
    compareStrings(left.signature, right.signature)
  );
}

function isPreferredRun(
  candidate: SubscriptionCandidateV1,
  existing: SubscriptionCandidateV1,
): boolean {
  return (
    candidate.lastDate > existing.lastDate ||
    (candidate.lastDate === existing.lastDate &&
      candidate.occurrenceCount > existing.occurrenceCount)
  );
}
