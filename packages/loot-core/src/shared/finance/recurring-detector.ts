import * as d from 'date-fns';

export type RecurringPaymentTransaction = Readonly<{
  id: string;
  accountId: string;
  payeeId: string | null;
  payeeName: string | null;
  date: string;
  amount: number;
  isTransfer: boolean;
  isSplitParent: boolean;
  isStartingBalance: boolean;
  isTombstone: boolean;
  isReconciled: boolean;
}>;

export type RecurringPaymentSchedule = Readonly<{
  id: string;
  accountId: string | null;
  payeeId: string | null;
  amount: number | Readonly<{ num1: number; num2: number }> | null;
  amountOperator: string | null;
  recurrence:
    | string
    | Readonly<{
        frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
        interval?: number;
        start: string;
      }>
    | null;
  isCompleted: boolean;
}>;

export type RecurringPaymentCadence =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'ambiguous';

export type RecurringPaymentType =
  | 'optional-subscription'
  | 'household-bill'
  | 'financial-bill';

export type RecurringPaymentReason =
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

export type RecurringPaymentCandidate = Readonly<{
  candidateKey: string;
  evidenceFingerprint: string;
  evidenceTransactionIds: readonly string[];
  accountId: string;
  payeeId: string;
  payeeName: string;
  cadence: RecurringPaymentCadence;
  type: RecurringPaymentType;
  occurrenceCount: number;
  firstDate: string;
  lastDate: string;
  medianAmount: number;
  amountVarianceBasisPoints: number;
  dateVarianceDays: number;
  recentPriceChangeBasisPoints: number | null;
  confidence: number;
  hasReconciledHistory: boolean;
  relatedScheduleIds: readonly string[];
  matchingScheduleIds: readonly string[];
  reasons: readonly RecurringPaymentReason[];
}>;

export type RecurringPaymentApplyValidation =
  | Readonly<{
      status: 'ready';
      candidate: RecurringPaymentCandidate;
    }>
  | Readonly<{
      status:
        | 'stale'
        | 'blocked-reconciled'
        | 'blocked-ambiguous-cadence'
        | 'blocked-ambiguous-schedules';
    }>;

type CadenceDefinition = Readonly<{
  cadence: Exclude<RecurringPaymentCadence, 'ambiguous'>;
  minimumOccurrences: number;
  toleranceDays: number;
  addSteps: (date: Date, steps: number) => Date;
}>;

type Observation = Readonly<{
  transaction: RecurringPaymentTransaction;
  date: Date;
  amountMagnitude: number;
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

const cadenceDefinitions: readonly CadenceDefinition[] = [
  {
    cadence: 'weekly',
    minimumOccurrences: 4,
    toleranceDays: 2,
    addSteps: (date, steps) => d.addWeeks(date, steps),
  },
  {
    cadence: 'monthly',
    minimumOccurrences: 3,
    toleranceDays: 4,
    addSteps: (date, steps) => d.addMonths(date, steps),
  },
  {
    cadence: 'quarterly',
    minimumOccurrences: 3,
    toleranceDays: 4,
    addSteps: (date, steps) => d.addMonths(date, 3 * steps),
  },
  {
    cadence: 'annual',
    minimumOccurrences: 2,
    toleranceDays: 7,
    addSteps: (date, steps) => d.addYears(date, steps),
  },
];

const reasonOrder: readonly RecurringPaymentReason[] = [
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

export function detectRecurringPayments(
  transactions: readonly RecurringPaymentTransaction[],
  schedules: readonly RecurringPaymentSchedule[] = [],
): readonly RecurringPaymentCandidate[] {
  const candidates: RecurringPaymentCandidate[] = [];

  for (const observations of groupEligibleObservations(transactions).values()) {
    const cadenceRuns = cadenceDefinitions.flatMap(cadenceDefinition =>
      findQualifyingRuns(observations, cadenceDefinition),
    );

    for (const overlappingRuns of groupOverlappingRuns(cadenceRuns)) {
      candidates.push(
        overlappingRuns.length === 1
          ? createCandidate(
              overlappingRuns[0].observations,
              overlappingRuns[0].cadenceDefinition,
              overlappingRuns[0].dateVarianceDays,
              overlappingRuns[0].hasGap,
              schedules,
            )
          : createAmbiguousCandidate(overlappingRuns, schedules),
      );
    }
  }

  const newestCandidateByKey = new Map<string, RecurringPaymentCandidate>();
  for (const candidate of candidates) {
    const currentCandidate = newestCandidateByKey.get(candidate.candidateKey);
    if (
      currentCandidate == null ||
      candidate.lastDate > currentCandidate.lastDate ||
      (candidate.lastDate === currentCandidate.lastDate &&
        candidate.occurrenceCount > currentCandidate.occurrenceCount)
    ) {
      newestCandidateByKey.set(candidate.candidateKey, candidate);
    }
  }

  return [...newestCandidateByKey.values()].sort(
    (left, right) =>
      left.payeeName.localeCompare(right.payeeName) ||
      left.accountId.localeCompare(right.accountId) ||
      left.cadence.localeCompare(right.cadence),
  );
}

export function validateRecurringPaymentCandidateForApply(
  candidateKey: string,
  evidenceFingerprint: string,
  currentCandidates: readonly RecurringPaymentCandidate[],
): RecurringPaymentApplyValidation {
  const candidate = currentCandidates.find(
    currentCandidate => currentCandidate.candidateKey === candidateKey,
  );
  if (
    candidate == null ||
    candidate.evidenceFingerprint !== evidenceFingerprint
  ) {
    return { status: 'stale' };
  }
  if (candidate.hasReconciledHistory) {
    return { status: 'blocked-reconciled' };
  }
  if (candidate.cadence === 'ambiguous') {
    return { status: 'blocked-ambiguous-cadence' };
  }
  if (candidate.relatedScheduleIds.length > 1) {
    return { status: 'blocked-ambiguous-schedules' };
  }
  return { candidate, status: 'ready' };
}

function groupEligibleObservations(
  transactions: readonly RecurringPaymentTransaction[],
): ReadonlyMap<string, readonly Observation[]> {
  const groups = new Map<string, Observation[]>();
  const seenTransactionIds = new Set<string>();

  for (const transaction of [...transactions].sort(
    (left, right) =>
      left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  )) {
    if (seenTransactionIds.has(transaction.id)) continue;
    seenTransactionIds.add(transaction.id);

    const parsedDate = d.parseISO(transaction.date);
    if (
      transaction.payeeId == null ||
      transaction.payeeId.length === 0 ||
      transaction.payeeName == null ||
      transaction.payeeName.length === 0 ||
      !Number.isSafeInteger(transaction.amount) ||
      transaction.amount >= 0 ||
      transaction.isTransfer ||
      transaction.isSplitParent ||
      transaction.isStartingBalance ||
      transaction.isTombstone ||
      !d.isValid(parsedDate)
    ) {
      continue;
    }

    const observation = {
      amountMagnitude: Math.abs(transaction.amount),
      date: parsedDate,
      transaction,
    } satisfies Observation;
    const groupKey = JSON.stringify([
      transaction.accountId,
      transaction.payeeId,
    ]);
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
      observations[index - 1].date,
      observations[index].date,
      cadenceDefinition,
    );
    if (evidence == null) {
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
  previousDate: Date,
  nextDate: Date,
  cadenceDefinition: CadenceDefinition,
): Readonly<{ residualDays: number; isGap: boolean }> | null {
  const oneStepResidual = Math.abs(
    d.differenceInCalendarDays(
      nextDate,
      cadenceDefinition.addSteps(previousDate, 1),
    ),
  );
  if (oneStepResidual <= cadenceDefinition.toleranceDays) {
    return { residualDays: oneStepResidual, isGap: false };
  }

  const twoStepResidual = Math.abs(
    d.differenceInCalendarDays(
      nextDate,
      cadenceDefinition.addSteps(previousDate, 2),
    ),
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
  const amountEvidence = calculateAmountEvidence(observations);
  if (
    observations.length < cadenceDefinition.minimumOccurrences ||
    transitionEvidence.filter(evidence => evidence.isGap).length > 1 ||
    !amountEvidence.isEligible
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
      const previousRunIndex = firstRunByTransactionId.get(
        observation.transaction.id,
      );
      if (previousRunIndex == null) {
        firstRunByTransactionId.set(observation.transaction.id, runIndex);
      } else {
        joinRunGroups(parents, runIndex, previousRunIndex);
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

function createAmbiguousCandidate(
  runs: readonly CadenceRun[],
  schedules: readonly RecurringPaymentSchedule[],
): RecurringPaymentCandidate {
  const observationsById = new Map<string, Observation>();
  for (const run of runs) {
    for (const observation of run.observations) {
      observationsById.set(observation.transaction.id, observation);
    }
  }
  const observations = [...observationsById.values()].sort(
    (left, right) =>
      left.transaction.date.localeCompare(right.transaction.date) ||
      left.transaction.id.localeCompare(right.transaction.id),
  );
  const strictestDefinition = [...runs].sort(
    (left, right) =>
      right.cadenceDefinition.minimumOccurrences -
      left.cadenceDefinition.minimumOccurrences,
  )[0].cadenceDefinition;

  return createCandidate(
    observations,
    { ...strictestDefinition, cadence: 'ambiguous' },
    Math.max(...runs.map(run => run.dateVarianceDays)),
    runs.some(run => run.hasGap),
    schedules,
  );
}

function createCandidate(
  observations: readonly Observation[],
  cadenceDefinition: Omit<CadenceDefinition, 'cadence'> & {
    cadence: RecurringPaymentCadence;
  },
  dateVarianceDays: number,
  hasGap: boolean,
  schedules: readonly RecurringPaymentSchedule[],
): RecurringPaymentCandidate {
  const firstObservation = observations[0];
  const lastObservation = observations[observations.length - 1];
  const payeeId = firstObservation.transaction.payeeId;
  const payeeName = firstObservation.transaction.payeeName;
  if (payeeId == null || payeeName == null) {
    throw new Error('Eligible recurring observations require a payee.');
  }

  const accountId = firstObservation.transaction.accountId;
  const cadence = cadenceDefinition.cadence;
  const candidateKey = JSON.stringify([accountId, payeeId, cadence]);
  const relatedSchedules = schedules
    .filter(
      schedule =>
        !schedule.isCompleted &&
        schedule.accountId === accountId &&
        schedule.payeeId === payeeId,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const matchingSchedules = relatedSchedules.filter(schedule =>
    scheduleMatchesCadence(schedule, cadence),
  );
  const amountEvidence = calculateAmountEvidence(observations);
  const hasReconciledHistory = observations.some(
    observation => observation.transaction.isReconciled,
  );
  const applicableReasons = new Set<RecurringPaymentReason>([
    cadenceReason(cadence),
    'minimum-occurrences',
    amountEvidence.amountVarianceBasisPoints <= 750
      ? 'stable-amount'
      : 'amount-variance',
  ]);
  if (dateVarianceDays > 0) applicableReasons.add('billing-date-variance');
  if (amountEvidence.recentPriceChangeBasisPoints != null) {
    applicableReasons.add('price-change');
  }
  if (hasGap) applicableReasons.add('gap-detected');
  if (hasReconciledHistory) applicableReasons.add('reconciled-history');
  if (matchingSchedules.length === 1) {
    applicableReasons.add('existing-schedule');
  }
  if (relatedSchedules.length > 1) {
    applicableReasons.add('schedule-ambiguous');
  }

  let confidence = 50;
  confidence += Math.min(
    20,
    (observations.length - cadenceDefinition.minimumOccurrences) * 10,
  );
  if (dateVarianceDays <= cadenceDefinition.toleranceDays) confidence += 15;
  confidence += amountEvidence.amountVarianceBasisPoints <= 750 ? 15 : -15;
  if (matchingSchedules.length === 1) confidence += 5;
  if (hasGap) confidence -= 10;
  if (amountEvidence.recentPriceChangeBasisPoints != null) confidence -= 10;

  return {
    accountId,
    amountVarianceBasisPoints: amountEvidence.amountVarianceBasisPoints,
    cadence,
    candidateKey,
    confidence: Math.max(0, Math.min(100, confidence)),
    dateVarianceDays,
    evidenceFingerprint: JSON.stringify({
      candidateKey,
      schedules: relatedSchedules.map(schedule => ({
        accountId: schedule.accountId,
        amount: schedule.amount,
        amountOperator: schedule.amountOperator,
        id: schedule.id,
        isCompleted: schedule.isCompleted,
        payeeId: schedule.payeeId,
        recurrence: schedule.recurrence,
      })),
      transactions: observations.map(observation => ({
        amount: observation.transaction.amount,
        date: observation.transaction.date,
        id: observation.transaction.id,
        isReconciled: observation.transaction.isReconciled,
      })),
    }),
    evidenceTransactionIds: observations.map(
      observation => observation.transaction.id,
    ),
    firstDate: firstObservation.transaction.date,
    hasReconciledHistory,
    lastDate: lastObservation.transaction.date,
    matchingScheduleIds: matchingSchedules.map(schedule => schedule.id),
    medianAmount: amountEvidence.medianAmount,
    occurrenceCount: observations.length,
    payeeId,
    payeeName,
    reasons: reasonOrder.filter(reason => applicableReasons.has(reason)),
    recentPriceChangeBasisPoints: amountEvidence.recentPriceChangeBasisPoints,
    relatedScheduleIds: relatedSchedules.map(schedule => schedule.id),
    type: classifyRecurringPayment(payeeName),
  };
}

function calculateAmountEvidence(
  observations: readonly Observation[],
): AmountEvidence {
  if (observations.length === 0) {
    return {
      amountVarianceBasisPoints: 0,
      isEligible: false,
      medianAmount: 0,
      recentPriceChangeBasisPoints: null,
    };
  }

  const amounts = observations
    .map(observation => observation.amountMagnitude)
    .sort((left, right) => left - right);
  const medianAmount = median(amounts);
  const amountVarianceBasisPoints = Math.max(
    ...amounts.map(amount => basisPointDifference(amount, medianAmount)),
  );
  let recentPriceChangeBasisPoints: number | null = null;

  if (observations.length > 1) {
    const precedingAmounts = observations
      .slice(0, -1)
      .map(observation => observation.amountMagnitude)
      .sort((left, right) => left - right);
    const precedingMedian = median(precedingAmounts);
    const precedingVariance = Math.max(
      ...precedingAmounts.map(amount =>
        basisPointDifference(amount, precedingMedian),
      ),
    );
    const latestDifference = basisPointDifference(
      observations[observations.length - 1].amountMagnitude,
      precedingMedian,
    );
    if (
      precedingVariance <= 750 &&
      latestDifference >= 1_000 &&
      latestDifference <= 5_000
    ) {
      recentPriceChangeBasisPoints = latestDifference;
    }
  }

  return {
    amountVarianceBasisPoints,
    isEligible:
      amountVarianceBasisPoints <= 3_500 ||
      (recentPriceChangeBasisPoints != null &&
        amountVarianceBasisPoints <= 5_000),
    medianAmount,
    recentPriceChangeBasisPoints,
  };
}

function median(sortedAmounts: readonly number[]): number {
  const middle = Math.floor(sortedAmounts.length / 2);
  return sortedAmounts.length % 2 === 1
    ? sortedAmounts[middle]
    : Math.round((sortedAmounts[middle - 1] + sortedAmounts[middle]) / 2);
}

function basisPointDifference(amount: number, medianAmount: number): number {
  return Math.round(
    (Math.abs(amount - medianAmount) * 10_000) / Math.max(1, medianAmount),
  );
}

function scheduleMatchesCadence(
  schedule: RecurringPaymentSchedule,
  cadence: RecurringPaymentCadence,
): boolean {
  if (
    cadence === 'ambiguous' ||
    schedule.recurrence == null ||
    typeof schedule.recurrence === 'string'
  ) {
    return false;
  }
  const interval = schedule.recurrence.interval ?? 1;
  if (cadence === 'weekly') {
    return schedule.recurrence.frequency === 'weekly' && interval === 1;
  }
  if (cadence === 'monthly' || cadence === 'quarterly') {
    return (
      schedule.recurrence.frequency === 'monthly' &&
      interval === (cadence === 'monthly' ? 1 : 3)
    );
  }
  return schedule.recurrence.frequency === 'yearly' && interval === 1;
}

function cadenceReason(
  cadence: RecurringPaymentCadence,
): RecurringPaymentReason {
  if (cadence === 'weekly') return 'cadence-weekly';
  if (cadence === 'monthly') return 'cadence-monthly';
  if (cadence === 'quarterly') return 'cadence-quarterly';
  if (cadence === 'annual') return 'cadence-annual';
  return 'cadence-ambiguous';
}

function classifyRecurringPayment(name: string): RecurringPaymentType {
  const normalizedName = name.toLowerCase();
  if (/bank|credit|insurance|loan|mortgage|tax/.test(normalizedName)) {
    return 'financial-bill';
  }
  if (
    /electric|energy|gas|hoa|internet|phone|rent|utility|water/.test(
      normalizedName,
    )
  ) {
    return 'household-bill';
  }
  return 'optional-subscription';
}
