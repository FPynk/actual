import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionV1,
  ReadBudgetSnapshotRequest,
} from '#contracts/adapter';

import {
  detectSubscriptionCandidates,
  matchingScheduleIds,
  subscriptionDetectorVersion,
} from './subscription-detector';
import type {
  SubscriptionCandidateStatus,
  SubscriptionCandidateV1,
  SubscriptionDetectorClock,
  SubscriptionDetectorInput,
  SubscriptionHistoryTransactionV1,
} from './subscription-detector';

export type SubscriptionCandidateRepository = Readonly<{
  readCandidates(
    detectorVersion: number,
  ):
    | readonly SubscriptionCandidateV1[]
    | Promise<readonly SubscriptionCandidateV1[]>;
  persistCandidates(
    candidates: readonly SubscriptionCandidateV1[],
  ): void | Promise<void>;
}>;

export type SubscriptionScanInput = SubscriptionDetectorInput &
  Readonly<{
    clock: SubscriptionDetectorClock;
    repository: SubscriptionCandidateRepository;
  }>;

export type SubscriptionHistoryRange = NonNullable<
  ReadBudgetSnapshotRequest['transactionRange']
>;

export type ActualSubscriptionScanInput = Readonly<{
  adapter: Pick<ActualAdapter, 'execute'>;
  clock: SubscriptionDetectorClock;
  historyRanges: readonly SubscriptionHistoryRange[];
  repository: SubscriptionCandidateRepository;
}>;

export async function scanActualSubscriptionCandidates(
  input: ActualSubscriptionScanInput,
): Promise<readonly SubscriptionCandidateV1[]> {
  if (input.historyRanges.length === 0) {
    throw new TypeError('At least one subscription history range is required.');
  }
  const [firstRange, ...remainingRanges] = input.historyRanges;
  const firstSnapshot = await readSnapshot(input.adapter, {
    kind: 'read-budget-snapshot',
    sections: ['schedules'],
    transactionRange: firstRange,
  });
  if (firstSnapshot.schedules === undefined) {
    throw new TypeError('Subscription schedule snapshot is missing.');
  }
  const transactions = [...requiredTransactions(firstSnapshot)];
  for (const transactionRange of remainingRanges) {
    const snapshot = await readSnapshot(input.adapter, {
      kind: 'read-budget-snapshot',
      sections: [],
      transactionRange,
    });
    transactions.push(...requiredTransactions(snapshot));
  }
  return scanSubscriptionCandidates({
    clock: input.clock,
    repository: input.repository,
    schedules: firstSnapshot.schedules,
    transactions: transactions.map(projectHistoryTransaction),
  });
}

export async function scanSubscriptionCandidates(
  input: SubscriptionScanInput,
): Promise<readonly SubscriptionCandidateV1[]> {
  const evaluatedAtDate = input.clock.now();
  if (Number.isNaN(evaluatedAtDate.getTime())) {
    throw new TypeError('Invalid subscription detector clock.');
  }
  const evaluatedAt = evaluatedAtDate.toISOString();
  const detectedCandidates = detectSubscriptionCandidates(
    { schedules: input.schedules, transactions: input.transactions },
    { now: () => evaluatedAtDate },
  );
  const existingCandidates = await input.repository.readCandidates(
    subscriptionDetectorVersion,
  );
  const existingBySignature = new Map<string, SubscriptionCandidateV1>();
  for (const existingCandidate of existingCandidates) {
    if (
      existingCandidate.detectorVersion !== subscriptionDetectorVersion ||
      existingBySignature.has(existingCandidate.signature)
    ) {
      throw new TypeError('Invalid subscription candidate repository state.');
    }
    existingBySignature.set(existingCandidate.signature, existingCandidate);
  }

  const results: SubscriptionCandidateV1[] = [];
  for (const detectedCandidate of detectedCandidates) {
    const existingCandidate = existingBySignature.get(
      detectedCandidate.signature,
    );
    if (existingCandidate === undefined) {
      results.push(detectedCandidate);
      continue;
    }
    existingBySignature.delete(detectedCandidate.signature);
    if (existingCandidate.status === 'rejected') {
      results.push(existingCandidate);
      continue;
    }
    let status: SubscriptionCandidateStatus =
      existingCandidate.status === 'stale'
        ? 'pending'
        : existingCandidate.status;
    let actualScheduleId = detectedCandidate.actualScheduleId;
    if (
      existingCandidate.status === 'approved' &&
      existingCandidate.actualScheduleId !== null
    ) {
      const exactScheduleIds = matchingScheduleIds(
        existingCandidate,
        input.schedules,
      );
      status = exactScheduleIds.includes(existingCandidate.actualScheduleId)
        ? 'approved'
        : 'stale';
      actualScheduleId = existingCandidate.actualScheduleId;
    }
    results.push({
      ...detectedCandidate,
      actualScheduleId,
      candidateType: existingCandidate.candidateType,
      status,
    });
  }

  for (const existingCandidate of existingBySignature.values()) {
    if (
      existingCandidate.status === 'pending' ||
      existingCandidate.status === 'deferred' ||
      existingCandidate.status === 'approved'
    ) {
      results.push({
        ...existingCandidate,
        evaluatedAt,
        status: 'stale',
      });
    } else {
      results.push(existingCandidate);
    }
  }
  const sortedResults = results.sort((left, right) =>
    Buffer.compare(Buffer.from(left.signature), Buffer.from(right.signature)),
  );
  await input.repository.persistCandidates(sortedResults);
  return sortedResults;
}

async function readSnapshot(
  adapter: Pick<ActualAdapter, 'execute'>,
  request: ReadBudgetSnapshotRequest,
): Promise<ActualBudgetSnapshotV1> {
  const response = await adapter.execute(request);
  if (response.kind !== 'read-budget-snapshot') {
    throw new TypeError('Actual returned an unexpected subscription snapshot.');
  }
  return response.snapshot;
}

function requiredTransactions(
  snapshot: ActualBudgetSnapshotV1,
): readonly ActualTransactionV1[] {
  if (snapshot.transactions === undefined) {
    throw new TypeError('Subscription transaction snapshot is missing.');
  }
  return snapshot.transactions;
}

function projectHistoryTransaction(
  transaction: ActualTransactionV1,
): SubscriptionHistoryTransactionV1 {
  return {
    accountId: transaction.accountId,
    amount: transaction.amountMinorUnits,
    date: transaction.date,
    id: transaction.id,
    isReconciled: transaction.reconciled,
    isSplitParent: transaction.isParent,
    isStartingBalance: transaction.isStartingBalance,
    isTombstone: transaction.tombstone,
    isTransfer: transaction.transferId !== null,
    payeeId: transaction.payeeId,
  };
}
