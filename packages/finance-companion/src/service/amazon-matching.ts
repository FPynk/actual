import { createHash } from 'node:crypto';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualBudgetSnapshotV1,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import { targetVersionHash } from '#reviews/classification';
import { sha256Parts } from '#service/amazon-export-repository';

export const amazonMatcherVersion = 2 as const;
const maximumAmazonExactSubsetSearchSteps = 1_000_000;
const maximumAmazonExactCandidateSets = 10_000;

export class AmazonMatchCandidateSearchLimitError extends Error {
  constructor() {
    super('Amazon candidate search exceeded its deterministic safety limit.');
    this.name = 'AmazonMatchCandidateSearchLimitError';
  }
}

export const amazonMatchReasonCodes = [
  'currency-match',
  'currency-mismatch',
  'target-reconciled',
  'target-stale',
  'charge-sign-match',
  'refund-sign-match',
  'exact-parent-sum',
  'source-capacity-available',
  'source-capacity-exhausted',
  'target-capacity-exhausted',
  'date-exact',
  'date-within-three-days',
  'date-outside-window',
] as const;

export type AmazonMatchReasonCode = (typeof amazonMatchReasonCodes)[number];
export type AmazonAllocationKind =
  | 'merchandise'
  | 'tax'
  | 'shipping'
  | 'discount'
  | 'refund'
  | 'gift_card'
  | 'rounding';

export type AmazonSourceComponent = Readonly<{
  sourceIdentityHash: string;
  sourceComponentKind: AmazonAllocationKind;
  amazonOrderId: string;
  amazonItemId: string | null;
  amazonRefundId: string | null;
  amount: number;
  date: string;
  currencyCode: string;
}>;

export type AmazonTarget = Readonly<{
  id: string;
  amountMinorUnits: number;
  date: string;
  reconciled: boolean;
  targetVersionHash: string;
}>;

export type AmazonMatchCandidate = Readonly<{
  id: string;
  matcherVersion: typeof amazonMatcherVersion;
  status: 'pending' | 'stale';
  currencyCode: string;
  score: number;
  reasonCodes: readonly AmazonMatchReasonCode[];
  target: AmazonTarget;
  allocations: readonly AmazonSourceComponent[];
}>;

type CapacityUse = Readonly<{
  sourceIdentityHash: string;
  sourceComponentKind: AmazonAllocationKind;
  actualTransactionId: string;
  allocatedAmount: number;
}>;

/**
 * Builds independent, review-only candidate graphs. Pending graphs can overlap;
 * any future application must reserve and revalidate them again.
 */
export function buildAmazonMatchCandidates(
  request: Readonly<{
    budgetCurrencyCode: string;
    sources: readonly AmazonSourceComponent[];
    targets: readonly AmazonTarget[];
    capacityUses: readonly CapacityUse[];
  }>,
): readonly AmazonMatchCandidate[] {
  const candidates: AmazonMatchCandidate[] = [];
  const globalSearchBudget = {
    remainingCandidateSets: maximumAmazonExactCandidateSets,
    remainingSteps: maximumAmazonExactSubsetSearchSteps,
  };
  const sortedTargets = [...request.targets].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  for (const target of sortedTargets) {
    if (target.reconciled) {
      candidates.push(diagnosticCandidate(target, 'target-reconciled'));
      continue;
    }
    if (hasTargetCapacityUse(target.id, request.capacityUses)) {
      candidates.push(diagnosticCandidate(target, 'target-capacity-exhausted'));
      continue;
    }
    const sources = request.sources
      .filter(source => source.currencyCode === request.budgetCurrencyCode)
      .map(source => sourceWithRemainingCapacity(source, request.capacityUses))
      .filter((source): source is AmazonSourceComponent => source !== null);
    const matchingSignSources = sources.filter(source =>
      target.amountMinorUnits < 0
        ? source.sourceComponentKind !== 'refund'
        : target.amountMinorUnits > 0 &&
          source.sourceComponentKind === 'refund' &&
          source.amount > 0,
    );
    const exactAllocationSets = exactSubsets(
      matchingSignSources,
      target.amountMinorUnits,
      globalSearchBudget,
    );
    if (exactAllocationSets.length > 0) {
      candidates.push(
        ...exactAllocationSets.map(allocations =>
          candidateFromExactAllocations(
            target,
            allocations,
            request.budgetCurrencyCode,
          ),
        ),
      );
      continue;
    }
    if (
      request.sources.some(
        source => source.currencyCode !== request.budgetCurrencyCode,
      )
    ) {
      candidates.push(diagnosticCandidate(target, 'currency-mismatch'));
    }
  }
  return candidates.sort(compareCandidates);
}

export async function generateAmazonMatchCandidates(
  request: Readonly<{
    adapter: ActualAdapter;
    createdAt: string;
    databasePath: string;
    snapshot: ActualBudgetSnapshotV1;
  }>,
): Promise<readonly AmazonMatchCandidate[]> {
  assertTimestamp(request.createdAt);
  const repository = createSqliteAmazonMatchingRepository(request.databasePath);
  for (const pendingTarget of repository.readPendingTargets()) {
    const graph = await readCurrentTarget(
      request.adapter,
      pendingTarget.actualTransactionId,
    );
    if (
      graph === null ||
      graph.parent.reconciled ||
      pendingTarget.matcherVersion !== amazonMatcherVersion ||
      graph.targetVersionHash !== pendingTarget.actualTargetVersion ||
      graph.targetVersionHash !== targetVersionHash(graph)
    ) {
      repository.markStale(pendingTarget.matchId);
    }
  }
  const snapshotTargets = (request.snapshot.transactions ?? []).filter(
    isEligibleTarget,
  );
  const targets: AmazonTarget[] = [];
  for (const snapshotTarget of snapshotTargets.sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const graph = await readCurrentTarget(request.adapter, snapshotTarget.id);
    if (
      graph === null ||
      graph.parent.reconciled ||
      graph.targetVersionHash !== targetVersionHash(graph)
    ) {
      continue;
    }
    targets.push({
      amountMinorUnits: graph.parent.amountMinorUnits,
      date: graph.parent.date,
      id: graph.parent.id,
      reconciled: false,
      targetVersionHash: graph.targetVersionHash,
    });
  }
  const candidates = buildAmazonMatchCandidates({
    budgetCurrencyCode: request.snapshot.budget.currencyCode,
    capacityUses: repository.readCapacityUses(),
    sources: repository.readSourceComponents(),
    targets,
  });
  repository.saveCandidates(candidates, request.createdAt);
  return candidates;
}

export function createSqliteAmazonMatchingRepository(databasePath: string) {
  return {
    readPendingTargets(): readonly PendingTargetRow[] {
      const database = openCompanionDatabase(databasePath, true);
      try {
        return database
          .prepare(`SELECT mt.match_id AS matchId, mt.actual_transaction_id AS actualTransactionId,
              mt.actual_target_version AS actualTargetVersion, m.matcher_version AS matcherVersion
            FROM amazon_match_transactions mt
            JOIN amazon_charge_matches m ON m.id = mt.match_id
            WHERE m.status = 'pending'`)
          .all() as readonly PendingTargetRow[];
      } finally {
        database.close();
      }
    },
    markStale(matchId: string): void {
      const database = openCompanionDatabase(databasePath, true);
      try {
        database
          .transaction(() => {
            database
              .prepare(
                "UPDATE amazon_charge_matches SET status = 'stale' WHERE id = ? AND status = 'pending'",
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
    },
    readSourceComponents(): readonly AmazonSourceComponent[] {
      const database = openCompanionDatabase(databasePath, true);
      try {
        const items = database
          .prepare(`
          SELECT i.id AS amazon_item_id, i.amazon_order_id, i.source_item_key,
                 n.namespace, o.currency_code, o.order_date,
                 i.quantity, i.unit_amount, i.tax_amount, i.shipping_amount, i.discount_amount
          FROM amazon_items i
          JOIN amazon_orders o ON o.id = i.amazon_order_id
          JOIN source_namespaces n ON n.id = o.source_namespace_id
        `)
          .all() as readonly ItemRow[];
        const refunds = database
          .prepare(`
          SELECT r.id AS amazon_refund_id, r.amazon_order_id, r.source_refund_key,
                 n.namespace, o.currency_code, r.refund_date, r.amount
          FROM amazon_refunds r
          JOIN amazon_orders o ON o.id = r.amazon_order_id
          JOIN source_namespaces n ON n.id = o.source_namespace_id
        `)
          .all() as readonly RefundRow[];
        const orders = database
          .prepare(`
          SELECT o.id AS amazon_order_id, n.namespace, o.marketplace, o.external_order_id,
                 o.currency_code, o.order_date, o.order_total, o.gift_card_total,
                 o.item_subtotal, o.tax_total, o.shipping_total, o.discount_total
          FROM amazon_orders o JOIN source_namespaces n ON n.id = o.source_namespace_id
        `)
          .all() as readonly OrderRow[];
        return [
          ...itemComponents(items),
          ...refundComponents(refunds),
          ...orderComponents(orders, items),
        ].sort(compareSources);
      } finally {
        database.close();
      }
    },
    readCapacityUses(): readonly CapacityUse[] {
      const database = openCompanionDatabase(databasePath, true);
      try {
        return database
          .prepare(`
          SELECT source_identity_hash, source_component_kind, actual_transaction_id, allocated_amount
          FROM amazon_applied_allocation_reservations
          UNION ALL
          SELECT source_identity_hash, source_component_kind, actual_transaction_id, allocated_amount
          FROM amazon_allocation_holds
        `)
          .all()
          .map(row => ({
            actualTransactionId: (row as CapacityUseRow).actual_transaction_id,
            allocatedAmount: (row as CapacityUseRow).allocated_amount,
            sourceComponentKind: (row as CapacityUseRow)
              .source_component_kind as AmazonAllocationKind,
            sourceIdentityHash: (row as CapacityUseRow).source_identity_hash,
          }));
      } finally {
        database.close();
      }
    },
    saveCandidates(
      candidates: readonly AmazonMatchCandidate[],
      createdAt: string,
    ): void {
      assertTimestamp(createdAt);
      const database = openCompanionDatabase(databasePath, true);
      try {
        const save = database.transaction(() => {
          for (const candidate of candidates) {
            if (candidate.status !== 'pending') continue;
            database
              .prepare(`INSERT INTO amazon_charge_matches
              (id, matcher_version, currency_code, score, reason_codes_json, status, created_at, decided_at)
              VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL) ON CONFLICT(id) DO NOTHING`)
              .run(
                candidate.id,
                candidate.matcherVersion,
                candidate.currencyCode,
                candidate.score,
                JSON.stringify(candidate.reasonCodes),
                createdAt,
              );
            database
              .prepare(`INSERT OR IGNORE INTO amazon_match_transactions
              (match_id, actual_transaction_id, actual_target_version, allocated_amount, application_status, application_receipt_id)
              VALUES (?, ?, ?, ?, 'pending', NULL)`)
              .run(
                candidate.id,
                candidate.target.id,
                candidate.target.targetVersionHash,
                candidate.target.amountMinorUnits,
              );
            for (const allocation of candidate.allocations) {
              saveAllocation(database, candidate, allocation);
            }
          }
        });
        save();
      } finally {
        database.close();
      }
    },
  };
}

function exactSubsets(
  sources: readonly AmazonSourceComponent[],
  targetAmount: number,
  searchBudget: {
    remainingCandidateSets: number;
    remainingSteps: number;
  },
) {
  const sorted = [...sources].sort(compareSources);
  const amounts = sorted.map(source => BigInt(source.amount));
  const target = BigInt(targetAmount);
  const suffixMinimums = new Array<bigint>(sorted.length + 1).fill(0n);
  const suffixMaximums = new Array<bigint>(sorted.length + 1).fill(0n);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const amount = amounts[index] ?? 0n;
    suffixMinimums[index] =
      (suffixMinimums[index + 1] ?? 0n) + (amount < 0n ? amount : 0n);
    suffixMaximums[index] =
      (suffixMaximums[index + 1] ?? 0n) + (amount > 0n ? amount : 0n);
  }
  const exactSets: AmazonSourceComponent[][] = [];
  const allocations: AmazonSourceComponent[] = [];
  const stack: ExactSubsetSearchFrame[] = [
    { currentAmount: 0n, index: 0, kind: 'search' },
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.kind === 'remove-source') {
      allocations.pop();
      continue;
    }
    if (frame.kind === 'include-source') {
      const source = sorted[frame.index];
      if (source === undefined) continue;
      allocations.push(source);
      stack.push({ kind: 'remove-source' });
      stack.push({
        currentAmount: frame.currentAmount + (amounts[frame.index] ?? 0n),
        index: frame.index + 1,
        kind: 'search',
      });
      continue;
    }

    if (searchBudget.remainingSteps <= 0) {
      throw new AmazonMatchCandidateSearchLimitError();
    }
    searchBudget.remainingSteps -= 1;
    if (
      frame.currentAmount + (suffixMinimums[frame.index] ?? 0n) > target ||
      frame.currentAmount + (suffixMaximums[frame.index] ?? 0n) < target
    ) {
      continue;
    }
    if (frame.index === sorted.length) {
      if (searchBudget.remainingCandidateSets <= 0) {
        throw new AmazonMatchCandidateSearchLimitError();
      }
      searchBudget.remainingCandidateSets -= 1;
      exactSets.push([...allocations]);
      continue;
    }
    stack.push({
      currentAmount: frame.currentAmount,
      index: frame.index,
      kind: 'include-source',
    });
    stack.push({
      currentAmount: frame.currentAmount,
      index: frame.index + 1,
      kind: 'search',
    });
  }
  return exactSets;
}

type ExactSubsetSearchFrame =
  | Readonly<{
      currentAmount: bigint;
      index: number;
      kind: 'search' | 'include-source';
    }>
  | Readonly<{ kind: 'remove-source' }>;

function candidateFromExactAllocations(
  target: AmazonTarget,
  allocations: readonly AmazonSourceComponent[],
  currencyCode: string,
): AmazonMatchCandidate {
  const earliestDate =
    allocations.map(value => value.date).sort()[0] ?? target.date;
  const dateDistance =
    Math.abs(
      Date.parse(`${target.date}T00:00:00Z`) -
        Date.parse(`${earliestDate}T00:00:00Z`),
    ) / 86_400_000;
  const dateReason: AmazonMatchReasonCode =
    dateDistance === 0
      ? 'date-exact'
      : dateDistance <= 3
        ? 'date-within-three-days'
        : 'date-outside-window';
  const signReason: AmazonMatchReasonCode =
    target.amountMinorUnits < 0 ? 'charge-sign-match' : 'refund-sign-match';
  const orderedAllocations = [...allocations].sort(compareSources);
  return {
    allocations: orderedAllocations,
    currencyCode,
    id: candidateId(target, orderedAllocations),
    matcherVersion: amazonMatcherVersion,
    reasonCodes: [
      'currency-match',
      signReason,
      'exact-parent-sum',
      'source-capacity-available',
      dateReason,
    ],
    score:
      dateReason === 'date-exact'
        ? 100
        : dateReason === 'date-within-three-days'
          ? 90
          : 80,
    status: 'pending',
    target,
  };
}

function diagnosticCandidate(
  target: AmazonTarget,
  reason: AmazonMatchReasonCode,
): AmazonMatchCandidate {
  return {
    allocations: [],
    currencyCode: '---',
    id: candidateId(target, []),
    matcherVersion: amazonMatcherVersion,
    reasonCodes: [reason],
    score: 0,
    status: 'stale',
    target,
  };
}

function sourceWithRemainingCapacity(
  source: AmazonSourceComponent,
  uses: readonly CapacityUse[],
): AmazonSourceComponent | null {
  const used = uses
    .filter(
      use =>
        use.sourceIdentityHash === source.sourceIdentityHash &&
        use.sourceComponentKind === source.sourceComponentKind,
    )
    .reduce((sum, use) => sum + BigInt(Math.abs(use.allocatedAmount)), 0n);
  const sourceAmount = BigInt(source.amount);
  const remainingMagnitude =
    (sourceAmount < 0n ? -sourceAmount : sourceAmount) - used;
  if (remainingMagnitude <= 0n) return null;
  return {
    ...source,
    amount: Number(
      sourceAmount < 0n ? -remainingMagnitude : remainingMagnitude,
    ),
  };
}

function hasTargetCapacityUse(targetId: string, uses: readonly CapacityUse[]) {
  return uses.some(
    use => use.actualTransactionId === targetId && use.allocatedAmount !== 0,
  );
}

function itemComponents(
  items: readonly ItemRow[],
): readonly AmazonSourceComponent[] {
  return items.flatMap(item => {
    const identity = sha256Parts([item.namespace, item.source_item_key]);
    return [
      component(
        identity,
        'merchandise',
        item,
        -(item.quantity * item.unit_amount),
      ),
      component(identity, 'tax', item, -item.tax_amount),
      component(identity, 'shipping', item, -item.shipping_amount),
      component(identity, 'discount', item, item.discount_amount),
    ].filter(value => value.amount !== 0);
  });
}

function refundComponents(
  refunds: readonly RefundRow[],
): readonly AmazonSourceComponent[] {
  return refunds
    .filter(refund => refund.amount !== 0)
    .map(refund => ({
      amazonItemId: null,
      amazonOrderId: refund.amazon_order_id,
      amazonRefundId: refund.amazon_refund_id,
      amount: refund.amount,
      currencyCode: refund.currency_code,
      date: refund.refund_date,
      sourceComponentKind: 'refund',
      sourceIdentityHash: sha256Parts([
        refund.namespace,
        refund.source_refund_key,
      ]),
    }));
}

function orderComponents(
  orders: readonly OrderRow[],
  items: readonly ItemRow[],
): readonly AmazonSourceComponent[] {
  return orders.flatMap(order => {
    const sourceItemTotal = items
      .filter(item => item.amazon_order_id === order.amazon_order_id)
      .reduce(
        (sum, item) =>
          sum -
          item.quantity * item.unit_amount -
          item.tax_amount -
          item.shipping_amount +
          item.discount_amount,
        0,
      );
    const assignedTax = items
      .filter(item => item.amazon_order_id === order.amazon_order_id)
      .reduce((sum, item) => sum + item.tax_amount, 0);
    const assignedShipping = items
      .filter(item => item.amazon_order_id === order.amazon_order_id)
      .reduce((sum, item) => sum + item.shipping_amount, 0);
    const identity = sha256Parts([
      order.namespace,
      `order/${order.marketplace}/${order.external_order_id}`,
    ]);
    const expectedCharge = -order.order_total + order.gift_card_total;
    const unassignedTax = -Math.max(order.tax_total - assignedTax, 0);
    const unassignedShipping = -Math.max(
      order.shipping_total - assignedShipping,
      0,
    );
    const rounding =
      expectedCharge -
      sourceItemTotal -
      order.gift_card_total -
      unassignedTax -
      unassignedShipping;
    return [
      adjustment(identity, 'gift_card', order, order.gift_card_total),
      adjustment(identity, 'tax', order, unassignedTax),
      adjustment(identity, 'shipping', order, unassignedShipping),
      adjustment(identity, 'rounding', order, rounding),
    ].filter(value => value.amount !== 0);
  });
}

function component(
  identity: string,
  kind: Exclude<AmazonAllocationKind, 'refund' | 'gift_card' | 'rounding'>,
  item: ItemRow,
  amount: number,
): AmazonSourceComponent {
  return {
    amazonItemId: item.amazon_item_id,
    amazonOrderId: item.amazon_order_id,
    amazonRefundId: null,
    amount,
    currencyCode: item.currency_code,
    date: item.order_date,
    sourceComponentKind: kind,
    sourceIdentityHash: identity,
  };
}

function adjustment(
  identity: string,
  kind: 'gift_card' | 'tax' | 'shipping' | 'rounding',
  order: OrderRow,
  amount: number,
): AmazonSourceComponent {
  return {
    amazonItemId: null,
    amazonOrderId: order.amazon_order_id,
    amazonRefundId: null,
    amount,
    currencyCode: order.currency_code,
    date: order.order_date,
    sourceComponentKind: kind,
    sourceIdentityHash: identity,
  };
}

function saveAllocation(
  database: ReturnType<typeof openCompanionDatabase>,
  candidate: AmazonMatchCandidate,
  allocation: AmazonSourceComponent,
) {
  if (allocation.amazonItemId !== null) {
    database
      .prepare(`INSERT OR IGNORE INTO amazon_transaction_item_allocations
      (match_id, actual_transaction_id, amazon_item_id, component_kind, allocated_amount, proposed_actual_category_id)
      VALUES (?, ?, ?, ?, ?, NULL)`)
      .run(
        candidate.id,
        candidate.target.id,
        allocation.amazonItemId,
        allocation.sourceComponentKind,
        allocation.amount,
      );
  } else if (allocation.amazonRefundId !== null) {
    database
      .prepare(`INSERT OR IGNORE INTO amazon_transaction_refund_allocations
      (match_id, actual_transaction_id, amazon_refund_id, allocated_amount, proposed_actual_category_id)
      VALUES (?, ?, ?, ?, NULL)`)
      .run(
        candidate.id,
        candidate.target.id,
        allocation.amazonRefundId,
        allocation.amount,
      );
  } else {
    database
      .prepare(`INSERT OR IGNORE INTO amazon_transaction_order_adjustments
      (match_id, actual_transaction_id, amazon_order_id, adjustment_kind, allocated_amount)
      VALUES (?, ?, ?, ?, ?)`)
      .run(
        candidate.id,
        candidate.target.id,
        allocation.amazonOrderId,
        allocation.sourceComponentKind,
        allocation.amount,
      );
  }
}

async function readCurrentTarget(
  adapter: ActualAdapter,
  id: string,
): Promise<ActualTransactionGraphV1 | null> {
  const response = await adapter.execute({
    kind: 'read-actual-target',
    target: { id, kind: 'transaction' },
  });
  if (response.kind !== 'read-actual-target') {
    throw new Error(
      'Actual adapter returned an unexpected Amazon target read.',
    );
  }
  return response.target;
}

function isEligibleTarget(transaction: ActualTransactionV1) {
  return (
    !transaction.tombstone &&
    !transaction.isChild &&
    !transaction.isStartingBalance &&
    !transaction.reconciled
  );
}

function assertTimestamp(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError('Amazon candidate timestamp is invalid.');
  }
}

function candidateId(
  target: AmazonTarget,
  allocations: readonly AmazonSourceComponent[],
) {
  return `amazon-v${amazonMatcherVersion}-${createHash('sha256')
    .update(
      JSON.stringify([
        target.id,
        target.targetVersionHash,
        allocations.map(source => [
          source.sourceIdentityHash,
          source.sourceComponentKind,
          source.amount,
        ]),
      ]),
    )
    .digest('hex')}`;
}

function compareSources(
  left: AmazonSourceComponent,
  right: AmazonSourceComponent,
) {
  return (
    left.amazonOrderId.localeCompare(right.amazonOrderId) ||
    left.sourceIdentityHash.localeCompare(right.sourceIdentityHash) ||
    left.sourceComponentKind.localeCompare(right.sourceComponentKind) ||
    left.amount - right.amount
  );
}
function compareCandidates(
  left: AmazonMatchCandidate,
  right: AmazonMatchCandidate,
) {
  return (
    left.target.id.localeCompare(right.target.id) ||
    right.score - left.score ||
    left.id.localeCompare(right.id)
  );
}

type ItemRow = Readonly<{
  amazon_item_id: string;
  amazon_order_id: string;
  source_item_key: string;
  namespace: string;
  currency_code: string;
  order_date: string;
  quantity: number;
  unit_amount: number;
  tax_amount: number;
  shipping_amount: number;
  discount_amount: number;
}>;
type RefundRow = Readonly<{
  amazon_refund_id: string;
  amazon_order_id: string;
  source_refund_key: string;
  namespace: string;
  currency_code: string;
  refund_date: string;
  amount: number;
}>;
type OrderRow = Readonly<{
  amazon_order_id: string;
  namespace: string;
  marketplace: string;
  external_order_id: string;
  currency_code: string;
  order_date: string;
  order_total: number;
  gift_card_total: number;
  item_subtotal: number;
  tax_total: number;
  shipping_total: number;
  discount_total: number;
}>;
type CapacityUseRow = Readonly<{
  source_identity_hash: string;
  source_component_kind: string;
  actual_transaction_id: string;
  allocated_amount: number;
}>;
type PendingTargetRow = Readonly<{
  matchId: string;
  actualTransactionId: string;
  actualTargetVersion: string;
  matcherVersion: number;
}>;
