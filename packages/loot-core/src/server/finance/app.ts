import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { createSchedule, updateSchedule } from '#server/schedules/app';
import { mergeTransactions } from '#server/transactions/merge';
import { undoable } from '#server/undo';
import {
  withFinanceReviewDecision,
  withoutFinanceReviewDecision,
} from '#shared/finance-metadata';
import {
  detectRecurringPayments,
  validateRecurringPaymentCandidateForApply,
} from '#shared/finance/recurring-detector';
import type {
  RecurringPaymentCadence,
  RecurringPaymentSchedule,
  RecurringPaymentTransaction,
} from '#shared/finance/recurring-detector';
import { q } from '#shared/query';
import type {
  FinanceReviewDecision,
  FinanceReviewDecisionRecord,
} from '#types/finance';
import type {
  PayeeEntity,
  RecurConfig,
  RuleConditionEntity,
  ScheduleEntity,
  TransactionEntity,
} from '#types/models';

import {
  listNativeReconciliationCandidates,
  scoreNativeReconciliationPair,
} from './reconciliation';

type ReconciliationDecision = 'merge' | 'keep-both' | 'deferred';

export function isReconciliationDecision(
  value: unknown,
): value is ReconciliationDecision {
  return value === 'merge' || value === 'keep-both' || value === 'deferred';
}

export type FinanceHandlers = {
  'finance/reconciliation-list': typeof listNativeReconciliationCandidates;
  'finance/reconciliation-decide': typeof decideNativeReconciliationCandidate;
  'finance/recurring/get-decisions': typeof getRecurringReviewDecisions;
  'finance/recurring/save-decision': typeof saveRecurringReviewDecision;
  'finance/recurring/reopen-decision': typeof reopenRecurringReviewDecision;
  'finance/recurring/apply': typeof applyRecurringPaymentCandidate;
};

async function decideNativeReconciliationCandidate({
  candidateKey,
  fingerprint,
  decision,
}: {
  candidateKey: string;
  fingerprint: string;
  decision: ReconciliationDecision;
}) {
  if (!isReconciliationDecision(decision)) {
    throw new Error('Invalid reconciliation decision.');
  }

  const candidates = await listNativeReconciliationCandidates();
  const candidate = candidates.find(
    currentCandidate => currentCandidate.candidateKey === candidateKey,
  );
  if (!candidate || candidate.fingerprint !== fingerprint) {
    return { status: 'stale' as const };
  }

  const [left, right] = await Promise.all(
    candidate.transactionIds.map(transactionId =>
      db.getTransaction(transactionId),
    ),
  );
  if (!left || !right) {
    return { status: 'stale' as const };
  }

  const payeeIds = [left.payee, right.payee].filter(
    (payeeId): payeeId is string => Boolean(payeeId),
  );
  const payees = await Promise.all(
    payeeIds.map(payeeId => db.getPayee(payeeId)),
  );
  const freshCandidate = scoreNativeReconciliationPair(
    left,
    right,
    new Map(
      payees
        .filter(payee => payee !== null && payee !== undefined)
        .map(payee => [payee.id, payee.name]),
    ),
  );
  if (
    !freshCandidate ||
    freshCandidate.candidateKey !== candidateKey ||
    freshCandidate.fingerprint !== fingerprint
  ) {
    return { status: 'stale' as const };
  }

  if (decision === 'merge') {
    const leftHasImportEvidence = Boolean(
      left.imported_id || left.imported_payee,
    );
    const rightHasImportEvidence = Boolean(
      right.imported_id || right.imported_payee,
    );
    let preferredFieldsTransactionId: string | undefined;
    if (leftHasImportEvidence !== rightHasImportEvidence) {
      preferredFieldsTransactionId = leftHasImportEvidence ? right.id : left.id;
    }
    const keptTransactionId = await mergeTransactions(
      candidate.transactionIds.map(id => ({ id })),
      { preferredFieldsTransactionId },
    );
    return { status: 'merged' as const, keptTransactionId };
  }

  const storedDecision: FinanceReviewDecision =
    decision === 'keep-both' ? 'keep-both' : 'deferred';
  await prefs.saveFinanceMetadata(
    withFinanceReviewDecision(prefs.getFinanceMetadata(), {
      candidateKey,
      decision: storedDecision,
      feature: 'reconciliation',
      updatedAt: new Date().toISOString(),
    }),
  );
  return { status: storedDecision };
}

export const app = createApp<FinanceHandlers>();

app.method('finance/reconciliation-list', listNativeReconciliationCandidates);
app.method(
  'finance/reconciliation-decide',
  mutator(undoable(decideNativeReconciliationCandidate)),
);

const recurringReviewDecisions = ['deferred', 'rejected', 'applied'] as const;
const maximumCandidateKeyLength = 256;
const maximumEvidenceFingerprintLength = 65_536;

type RecurringReviewDecision = (typeof recurringReviewDecisions)[number];

export type RecurringReviewDecisionRecord = FinanceReviewDecisionRecord &
  Readonly<{
    decision: RecurringReviewDecision;
    feature: 'recurring';
  }>;

type ApplyRecurringPaymentResult =
  | Readonly<{
      status: 'created' | 'updated';
      scheduleId: string;
    }>
  | Readonly<{
      status:
        | 'stale'
        | 'blocked-reconciled'
        | 'blocked-ambiguous-cadence'
        | 'blocked-ambiguous-schedules';
    }>;

export async function getRecurringReviewDecisions(): Promise<
  readonly RecurringReviewDecisionRecord[]
> {
  return prefs
    .getFinanceMetadata()
    .reviewDecisions.filter(
      (decision): decision is RecurringReviewDecisionRecord =>
        decision.feature === 'recurring' &&
        isRecurringReviewDecision(decision.decision),
    );
}

export async function saveRecurringReviewDecision({
  candidateKey,
  decision,
}: {
  candidateKey: string;
  decision: RecurringReviewDecision;
}): Promise<RecurringReviewDecisionRecord> {
  assertCandidateKey(candidateKey);
  if (!isRecurringReviewDecision(decision)) {
    throw new Error('Invalid recurring review decision.');
  }

  const record = {
    candidateKey,
    decision,
    feature: 'recurring',
    updatedAt: new Date().toISOString(),
  } satisfies RecurringReviewDecisionRecord;
  const finance = withFinanceReviewDecision(prefs.getFinanceMetadata(), record);
  await prefs.saveFinanceMetadata(finance);
  return record;
}

export function isRecurringReviewDecision(
  decision: string,
): decision is RecurringReviewDecision {
  return recurringReviewDecisions.some(
    recurringDecision => recurringDecision === decision,
  );
}

export async function reopenRecurringReviewDecision({
  candidateKey,
}: {
  candidateKey: string;
}): Promise<void> {
  assertCandidateKey(candidateKey);
  await prefs.saveFinanceMetadata(
    withoutFinanceReviewDecision(
      prefs.getFinanceMetadata(),
      'recurring',
      candidateKey,
    ),
  );
}

export async function applyRecurringPaymentCandidate({
  candidateKey,
  evidenceFingerprint,
}: {
  candidateKey: string;
  evidenceFingerprint: string;
}): Promise<ApplyRecurringPaymentResult> {
  assertCandidateKey(candidateKey);
  if (
    evidenceFingerprint.length === 0 ||
    evidenceFingerprint.length > maximumEvidenceFingerprintLength
  ) {
    throw new Error('Invalid recurring evidence fingerprint.');
  }

  const currentCandidates = await readRecurringPaymentCandidates();
  const validation = validateRecurringPaymentCandidateForApply(
    candidateKey,
    evidenceFingerprint,
    currentCandidates,
  );
  if (validation.status !== 'ready') return validation;

  const candidate = validation.candidate;
  const conditions = createScheduleConditions(candidate);
  const currentScheduleId = candidate.relatedScheduleIds[0];
  let result: ApplyRecurringPaymentResult;
  if (currentScheduleId == null) {
    const scheduleId = await createSchedule({
      conditions,
      schedule: { posts_transaction: false },
    });
    result = { scheduleId, status: 'created' };
  } else {
    await updateSchedule({
      conditions,
      resetNextDate: true,
      schedule: { id: currentScheduleId },
    });
    result = { scheduleId: currentScheduleId, status: 'updated' };
  }

  await saveRecurringReviewDecision({ candidateKey, decision: 'applied' });
  return result;
}

async function readRecurringPaymentCandidates() {
  const [transactionResult, scheduleResult, payeeResult] = await Promise.all([
    aqlQuery(q('transactions').select('*')),
    aqlQuery(q('schedules').select('*')),
    aqlQuery(q('payees').select('*')),
  ]);
  const transactions = transactionResult.data as TransactionEntity[];
  const schedules = scheduleResult.data as ScheduleEntity[];
  const payees = payeeResult.data as PayeeEntity[];
  const payeeNames = new Map(payees.map(payee => [payee.id, payee.name]));

  return detectRecurringPayments(
    transactions.map(
      transaction =>
        ({
          accountId: transaction.account,
          amount: transaction.amount,
          date: transaction.date,
          id: transaction.id,
          isReconciled: transaction.reconciled === true,
          isSplitParent: transaction.is_parent === true,
          isStartingBalance: transaction.starting_balance_flag === true,
          isTombstone:
            transaction.tombstone === true || transaction._deleted === true,
          isTransfer: transaction.transfer_id != null,
          payeeId: transaction.payee ?? null,
          payeeName:
            transaction.payee == null
              ? null
              : (payeeNames.get(transaction.payee) ?? null),
        }) satisfies RecurringPaymentTransaction,
    ),
    schedules.map(projectRecurringPaymentSchedule),
  );
}

function projectRecurringPaymentSchedule(
  schedule: ScheduleEntity,
): RecurringPaymentSchedule {
  return {
    accountId: schedule._account ?? null,
    amount: schedule._amount ?? null,
    amountOperator: schedule._amountOp ?? null,
    id: schedule.id,
    isCompleted: schedule.completed,
    payeeId: schedule._payee ?? null,
    recurrence: schedule._date ?? null,
  };
}

function createScheduleConditions(candidate: {
  accountId: string;
  cadence: RecurringPaymentCadence;
  lastDate: string;
  medianAmount: number;
  payeeId: string;
}): RuleConditionEntity[] {
  if (candidate.cadence === 'ambiguous') {
    throw new Error('An ambiguous cadence cannot create a schedule.');
  }
  const frequency =
    candidate.cadence === 'annual'
      ? 'yearly'
      : candidate.cadence === 'quarterly'
        ? 'monthly'
        : candidate.cadence;
  const recurrence = {
    endDate: candidate.lastDate,
    endMode: 'never',
    endOccurrences: 1,
    frequency,
    interval: candidate.cadence === 'quarterly' ? 3 : 1,
    patterns: [],
    skipWeekend: false,
    start: candidate.lastDate,
    weekendSolveMode: 'after',
  } satisfies RecurConfig;

  return [
    { field: 'payee', op: 'is', value: candidate.payeeId },
    { field: 'account', op: 'is', value: candidate.accountId },
    { field: 'date', op: 'isapprox', value: recurrence },
    { field: 'amount', op: 'isapprox', value: -candidate.medianAmount },
  ];
}

function assertCandidateKey(candidateKey: string): void {
  if (
    candidateKey.length === 0 ||
    candidateKey.length > maximumCandidateKeyLength
  ) {
    throw new Error('Invalid recurring candidate key.');
  }
}

app.method('finance/recurring/get-decisions', getRecurringReviewDecisions);
app.method(
  'finance/recurring/save-decision',
  mutator(saveRecurringReviewDecision),
);
app.method(
  'finance/recurring/reopen-decision',
  mutator(reopenRecurringReviewDecision),
);
app.method(
  'finance/recurring/apply',
  mutator(undoable(applyRecurringPaymentCandidate)),
);
