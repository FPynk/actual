import { createApp } from '#server/app';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import { getFinanceMetadata, saveFinanceMetadata } from '#server/prefs';
import { mergeTransactions } from '#server/transactions/merge';
import { undoable } from '#server/undo';
import { withFinanceReviewDecision } from '#shared/finance-metadata';
import type { FinanceReviewDecision } from '#types/finance';

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
  await saveFinanceMetadata(
    withFinanceReviewDecision(getFinanceMetadata(), {
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
