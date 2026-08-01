import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ActualAdapter } from '#actual/adapter';
import type {
  ActualAdapterRequest,
  ActualTransactionGraphV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import { openCompanionDatabase } from '#database/connection';
import { initializeCompanionDatabaseAndAnchor } from '#database/migrate';
import { targetVersionHash } from '#reviews/classification';
import { generateAmazonMatchCandidates } from '#service/amazon-matching';
import {
  AmazonReviewConflictError,
  SqliteAmazonReviewRepository,
} from '#service/amazon-review-repository';
import {
  createAmazonReviewRef,
  decideAmazonReview,
  readAmazonReviewDetail,
  readAmazonReviewList,
} from '#service/amazon-review-service';

const budgetKeyHash = 'a'.repeat(64);

describe('FIN-41 Amazon review service and SQLite decisions', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let repository: SqliteAmazonReviewRepository;
  let graph: ActualTransactionGraphV1;
  let requests: ActualAdapterRequest[];
  let adapter: ActualAdapter;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-amazon-review-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    await initializeCompanionDatabaseAndAnchor({
      databasePath,
      migrationsDirectory: path.resolve(
        import.meta.dirname,
        '../../migrations',
      ),
      anchorPath: path.join(temporaryDirectory, 'anchor.json'),
      anchorMacKey: randomBytes(32),
      budgetKeyHash,
      budgetCurrencyCode: 'USD',
      createOwnerCredentialHash: async () => 'owner',
    });
    const parent = transaction();
    const graphWithoutHash = {
      contractVersion: 1 as const,
      parent,
      children: [],
    };
    graph = {
      ...graphWithoutHash,
      targetVersionHash: targetVersionHash(graphWithoutHash),
    };
    insertCompetingCandidates(databasePath, graph.targetVersionHash);
    repository = new SqliteAmazonReviewRepository(databasePath);
    requests = [];
    adapter = createAdapter(requests, () => graph);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('keeps list DTOs generic and HMAC-opaque while detail exposes only sanitized titles and Actual labels', async () => {
    const list = await readAmazonReviewList(dependencies());

    expect(list.reviews).toHaveLength(2);
    expect(list.reviews[0]).toMatchObject({
      status: 'pending',
      parentCount: 1,
      allocationCount: 1,
      competingCandidateCount: 1,
    });
    expect(list.reviews[0]?.reviewRef).toMatch(/^amazon_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(list)).not.toContain('match-a');
    expect(JSON.stringify(list)).not.toContain('actual-parent');
    expect(JSON.stringify(list)).not.toContain('Private <script>');

    const detail = await readAmazonReviewDetail(
      list.reviews[0]?.reviewRef ?? '',
      dependencies(),
    );
    expect(detail).toMatchObject({
      status: 'pending',
      competingCandidateCount: 1,
      parents: [
        {
          account: 'Card & account',
          payee: 'Amazon <payee>',
          category: 'Shopping',
          competingCandidateCount: 1,
          allocations: [{ kind: 'merchandise', amountMinorUnits: -100 }],
        },
      ],
    });
    expect(detail?.parents[0]?.allocations[0]?.itemTitle).toHaveLength(160);
    expect(detail?.parents[0]?.parentRef).toMatch(/^parent_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(detail)).not.toContain('actual-parent');
    expect(
      requests.every(
        request =>
          request.kind === 'read-actual-target' ||
          request.kind === 'read-budget-snapshot',
      ),
    ).toBe(true);
  });

  it('records approve, reject, defer, and reopen atomically without selecting competitors or changing capacity/application state', async () => {
    const records = repository.listAmazonReviewRecords();
    const firstRef = createAmazonReviewRef(records[0]!, budgetKeyHash);
    const secondRef = createAmazonReviewRef(records[1]!, budgetKeyHash);

    const deferred = await decideAmazonReview(
      {
        reviewRef: firstRef,
        action: { kind: 'defer' },
        decidedAt: '2026-02-01T00:00:00.000Z',
      },
      dependencies(),
    );
    expect(deferred?.status).toBe('deferred');
    const reopened = await decideAmazonReview(
      {
        reviewRef: firstRef,
        action: { kind: 'reopen' },
        decidedAt: '2026-02-01T00:01:00.000Z',
      },
      dependencies(),
    );
    expect(reopened?.status).toBe('pending');
    const approved = await decideAmazonReview(
      {
        reviewRef: firstRef,
        action: { kind: 'approve' },
        decidedAt: '2026-02-01T00:02:00.000Z',
      },
      dependencies(),
    );
    expect(approved).toMatchObject({
      status: 'approved',
      guidance: expect.stringContaining('did not change Actual'),
    });
    const rejected = await decideAmazonReview(
      {
        reviewRef: secondRef,
        action: { kind: 'reject' },
        decidedAt: '2026-02-01T00:03:00.000Z',
      },
      dependencies(),
    );
    expect(rejected?.status).toBe('rejected');

    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT id, status FROM amazon_charge_matches ORDER BY id')
          .all(),
      ).toEqual([
        { id: 'match-a', status: 'approved' },
        { id: 'match-b', status: 'rejected' },
      ]);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_review_deferrals')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_allocation_holds')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM amazon_applied_allocation_reservations',
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            'SELECT application_receipt_id FROM amazon_match_transactions ORDER BY match_id',
          )
          .all(),
      ).toEqual([
        { application_receipt_id: null },
        { application_receipt_id: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('lets a reconciled target override a deferred decision and removes the deferral', async () => {
    const record = repository.listAmazonReviewRecords()[0]!;
    const reviewRef = createAmazonReviewRef(record, budgetKeyHash);
    repository.recordAmazonReviewDecision(
      record,
      { kind: 'defer' },
      '2026-02-01T00:00:00.000Z',
    );
    graph = {
      ...graph,
      parent: { ...graph.parent, reconciled: true },
    };

    const result = await decideAmazonReview(
      {
        reviewRef,
        action: { kind: 'reopen' },
        decidedAt: '2026-02-01T00:01:00.000Z',
      },
      dependencies(),
    );

    expect(result).toMatchObject({
      status: 'stale',
      staleReason: 'reconciled',
    });
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_review_deferrals')
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM amazon_charge_matches WHERE status = 'pending'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('rejects a same-status local candidate race using the full stored graph version', async () => {
    const record = repository.listAmazonReviewRecords()[0]!;
    const reviewRef = createAmazonReviewRef(record, budgetKeyHash);
    let raced = false;
    adapter = createAdapter(requests, () => {
      if (!raced) {
        raced = true;
        const database = openCompanionDatabase(databasePath, true);
        try {
          database
            .prepare(
              'UPDATE amazon_match_transactions SET actual_target_version = ? WHERE match_id = ?',
            )
            .run('f'.repeat(64), record.id);
        } finally {
          database.close();
        }
      }
      return graph;
    });

    await expect(
      decideAmazonReview(
        {
          reviewRef,
          action: { kind: 'approve' },
          decidedAt: '2026-02-01T00:00:00.000Z',
        },
        dependencies(),
      ),
    ).rejects.toBeInstanceOf(AmazonReviewConflictError);
    expect(repository.listAmazonReviewRecords()[0]?.status).toBe('pending');
  });

  it('removes a deferral when FIN-40 later invalidates the pending target', async () => {
    const record = repository.listAmazonReviewRecords()[0]!;
    repository.recordAmazonReviewDecision(
      record,
      { kind: 'defer' },
      '2026-02-01T00:00:00.000Z',
    );
    const missingAdapter = createAdapter([], () => null);

    await generateAmazonMatchCandidates({
      adapter: missingAdapter,
      createdAt: '2026-02-02T00:00:00.000Z',
      databasePath,
      snapshot: {
        contractVersion: 1,
        budget: {
          budgetKeyHash,
          currencyCode: 'USD',
          capturedAt: '2026-02-02T00:00:00.000Z',
        },
        transactions: [],
      },
    });

    expect(repository.listAmazonReviewRecords()[0]?.status).toBe('stale');
    const database = openCompanionDatabase(databasePath, true);
    try {
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM amazon_review_deferrals')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  function dependencies() {
    return {
      adapter,
      repository,
      budgetKeyHash,
      currencyCode: 'USD',
      now: () => new Date('2026-02-01T00:00:00.000Z'),
    } as const;
  }
});

function createAdapter(
  requests: ActualAdapterRequest[],
  readGraph: () => ActualTransactionGraphV1 | null,
): ActualAdapter {
  return {
    execute: async request => {
      requests.push(request);
      if (request.kind === 'read-actual-target') {
        return { kind: 'read-actual-target', target: readGraph() };
      }
      if (request.kind !== 'read-budget-snapshot') {
        throw new Error('Amazon review attempted to mutate Actual.');
      }
      return {
        kind: 'read-budget-snapshot',
        snapshot: {
          contractVersion: 1,
          budget: {
            budgetKeyHash,
            currencyCode: 'USD',
            capturedAt: '2026-02-01T00:00:00.000Z',
          },
          accounts: [
            {
              id: 'account-id',
              name: 'Card & account',
              offBudget: false,
              closed: false,
              syncSource: null,
              lastSync: null,
              syncStatus: null,
            },
          ],
          payees: [
            {
              id: 'payee-id',
              name: 'Amazon <payee>',
              transferAccountId: null,
            },
          ],
          categoryGroups: [],
          categories: [
            {
              id: 'category-id',
              name: 'Shopping',
              groupId: 'group-id',
              isIncome: false,
              hidden: false,
            },
          ],
        },
      };
    },
    getHealth: () => 'healthy',
    getActiveOperationStatus: () => null,
  };
}

function transaction(): ActualTransactionV1 {
  return {
    id: 'actual-parent',
    accountId: 'account-id',
    parentId: null,
    transferId: null,
    date: '2026-01-02',
    amountMinorUnits: -100,
    payeeId: 'payee-id',
    categoryId: 'category-id',
    notes: null,
    importedId: null,
    importedPayee: 'Amazon',
    cleared: true,
    reconciled: false,
    isParent: false,
    isChild: false,
    isStartingBalance: false,
    tombstone: false,
  };
}

function insertCompetingCandidates(databasePath: string, targetHash: string) {
  const database = openCompanionDatabase(databasePath, true);
  try {
    const namespaceId = randomUUID();
    database
      .prepare(
        "INSERT INTO source_namespaces (id, kind, namespace, display_name, created_at) VALUES (?, 'amazon_profile', ?, 'Synthetic profile', '2026-01-01T00:00:00.000Z')",
      )
      .run(namespaceId, `amazon-profile/v1/${randomUUID()}`);
    for (const [index, matchId] of ['match-a', 'match-b'].entries()) {
      const orderId = randomUUID();
      const itemId = randomUUID();
      database
        .prepare(
          `INSERT INTO amazon_orders
           (id, source_namespace_id, marketplace, external_order_id, order_date,
            currency_code, item_subtotal, tax_total, shipping_total, discount_total,
            gift_card_total, refund_total, order_total, first_observed_at, last_observed_at)
           VALUES (?, ?, 'amazon.com', ?, '2026-01-01', 'USD', 100, 0, 0, 0, 0, 0,
                   100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(orderId, namespaceId, `ORDER-${index}`);
      database
        .prepare(
          `INSERT INTO amazon_items
           (id, amazon_order_id, amazon_shipment_id, source_item_key, external_item_id,
            title, quantity, unit_amount, tax_amount, shipping_amount, discount_amount, refund_amount)
           VALUES (?, ?, NULL, ?, ?, ?, 1, 100, 0, 0, 0, 0)`,
        )
        .run(
          itemId,
          orderId,
          `item/ITEM-${index}`,
          `ITEM-${index}`,
          `Private <script>${index}</script> ${'x'.repeat(200)}`,
        );
      database
        .prepare(
          `INSERT INTO amazon_charge_matches
           (id, matcher_version, currency_code, score, reason_codes_json, status, created_at, decided_at)
           VALUES (?, 2, 'USD', ?, '["currency-match","charge-sign-match","exact-parent-sum","source-capacity-available","date-within-three-days"]', 'pending', '2026-01-03T00:00:00.000Z', NULL)`,
        )
        .run(matchId, 90 - index);
      database
        .prepare(
          `INSERT INTO amazon_match_transactions
           (match_id, actual_transaction_id, actual_target_version, allocated_amount, application_status, application_receipt_id)
           VALUES (?, 'actual-parent', ?, -100, 'pending', NULL)`,
        )
        .run(matchId, targetHash);
      database
        .prepare(
          `INSERT INTO amazon_transaction_item_allocations
           (match_id, actual_transaction_id, amazon_item_id, component_kind, allocated_amount, proposed_actual_category_id)
           VALUES (?, 'actual-parent', ?, 'merchandise', -100, NULL)`,
        )
        .run(matchId, itemId);
    }
  } finally {
    database.close();
  }
}
