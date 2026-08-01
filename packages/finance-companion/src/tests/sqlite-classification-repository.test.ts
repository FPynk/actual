import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type {
  ActualBudgetSnapshotV1,
  ActualTransactionV1,
} from '#contracts/adapter';
import {
  createClassificationRuleSetSnapshot,
  detectClassificationProposals,
} from '#reviews/classification';
import { SqliteClassificationProposalRepository } from '#reviews/sqlite-classification-repository';

const evaluatedAt = '2026-07-31T12:00:00.000Z';
const emptyRuleSetSnapshot = createClassificationRuleSetSnapshot([]);
const timestampRowIds = {
  classification_reviews: 'classification-status',
  merchant_normalization_proposals: 'merchant-status',
  reconciliation_candidates: 'reconciliation-status',
  subscription_candidates: 'subscription-status',
} as const;

describe('SQLite classification proposal repository', () => {
  let temporaryDirectory: string;
  let databasePath: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'finance-companion-classification-'),
    );
    databasePath = path.join(temporaryDirectory, 'companion.sqlite');
    const database = new Database(databasePath);
    database.exec(
      await readFile(
        path.resolve(
          import.meta.dirname,
          '../../migrations/004-review-candidates.sql',
        ),
        'utf8',
      ),
    );
    database.close();
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  it('creates the complete frozen migration 004 table group and indexes', () => {
    const database = new Database(databasePath);
    try {
      const tableNames = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all() as readonly Readonly<{ name: string }>[]
      ).map(row => row.name);
      expect(tableNames).toEqual([
        'classification_reviews',
        'merchant_normalization_proposals',
        'reconciliation_candidates',
        'subscription_candidates',
      ]);
      expect(columnNames(database, 'merchant_normalization_proposals')).toEqual(
        [
          'id',
          'imported_payee',
          'normalized_imported_payee',
          'proposed_actual_payee_id',
          'evidence_count',
          'confidence',
          'reason_codes_json',
          'detector_version',
          'status',
          'created_at',
          'decided_at',
          'proposal_metadata_json',
        ],
      );
      expect(columnNames(database, 'classification_reviews')).toEqual([
        'id',
        'actual_transaction_id',
        'actual_target_version',
        'proposed_category_id',
        'proposed_action',
        'confidence',
        'reason_codes_json',
        'detector_version',
        'status',
        'created_at',
        'decided_at',
        'proposal_metadata_json',
      ]);
      const indexNames = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as readonly Readonly<{ name: string }>[]
      ).map(row => row.name);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          'classification_reviews_pending_unique_idx',
          'classification_reviews_status_confidence_idx',
          'merchant_normalization_proposals_pending_unique_idx',
          'merchant_normalization_proposals_status_confidence_idx',
          'reconciliation_candidates_status_score_idx',
          'subscription_candidates_status_confidence_idx',
        ]),
      );
      expect(
        indexColumnNames(
          database,
          'merchant_normalization_proposals_pending_unique_idx',
        ),
      ).toEqual([
        'normalized_imported_payee',
        'proposed_actual_payee_id',
        'detector_version',
      ]);
      expect(
        indexColumnNames(database, 'classification_reviews_pending_unique_idx'),
      ).toEqual([
        'actual_transaction_id',
        'proposed_category_id',
        'actual_target_version',
        'detector_version',
      ]);
    } finally {
      database.close();
    }
  });

  it('survives restart, keeps pending inserts idempotent, and persists rejection', () => {
    const initialDatabase = new Database(databasePath);
    const initialRepository = new SqliteClassificationProposalRepository(
      initialDatabase,
    );
    const firstResult = detect(initialRepository);
    const firstProposal = firstResult.proposals[0]?.proposal;
    expect(firstProposal?.kind).toBe('merchant-alias');
    if (firstProposal?.kind !== 'merchant-alias') {
      throw new Error('Missing merchant alias proposal');
    }
    detect(initialRepository);
    expect(
      initialDatabase
        .prepare(
          'SELECT COUNT(*) AS count FROM merchant_normalization_proposals',
        )
        .get(),
    ).toEqual({ count: 1 });
    initialDatabase.close();

    const restartedDatabase = new Database(databasePath);
    const restartedRepository = new SqliteClassificationProposalRepository(
      restartedDatabase,
    );
    expect(detect(restartedRepository).proposals[0]?.proposal).toEqual(
      firstProposal,
    );
    restartedRepository.rejectMerchantAlias(firstProposal, evaluatedAt);
    restartedDatabase.close();

    const rejectedDatabase = new Database(databasePath);
    const rejectedRepository = new SqliteClassificationProposalRepository(
      rejectedDatabase,
    );
    expect(detect(rejectedRepository).proposals).toEqual([]);
    expect(detect(rejectedRepository).suppressions).toContainEqual({
      kind: 'merchant-alias',
      reasonCodes: ['suppressed'],
      subjectId: 'coffee shop',
    });
    rejectedDatabase.close();
  });

  it('persists an explicit classification action with no pending default', () => {
    const database = new Database(databasePath);
    const repository = new SqliteClassificationProposalRepository(database);
    detectCategory(repository);
    const pending = repository
      .listClassificationReviews()
      .find(record => record.proposal.kind === 'category');
    if (pending === undefined) throw new Error('Missing category review.');
    expect(pending.selectedAction).toBeNull();
    expect(() =>
      repository.recordClassificationDecision(
        pending,
        'approved',
        null,
        evaluatedAt,
      ),
    ).toThrow('decision is invalid');

    repository.recordClassificationDecision(
      pending,
      'approved',
      'create_rule',
      evaluatedAt,
    );
    database.close();

    const restartedDatabase = new Database(databasePath);
    const restarted = new SqliteClassificationProposalRepository(
      restartedDatabase,
    )
      .listClassificationReviews()
      .find(record => record.proposal.kind === 'category');
    expect(restarted).toMatchObject({
      decidedAt: evaluatedAt,
      selectedAction: 'create_rule',
      status: 'approved',
    });
    restartedDatabase.close();
  });

  it('enforces timestamp and pending-decision checks in migration 004', () => {
    const database = new Database(databasePath);
    const repository = new SqliteClassificationProposalRepository(database);
    detect(repository);

    expect(() =>
      database
        .prepare(
          "UPDATE merchant_normalization_proposals SET created_at = '2026-07-31'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          "UPDATE merchant_normalization_proposals SET status = 'rejected'",
        )
        .run(),
    ).toThrow();
    database.close();
  });

  it('rejects 24-character unparsable timestamps in every migration 004 timestamp column', () => {
    const database = new Database(databasePath);
    try {
      insertReconciliationSchemaRow(database);
      insertMerchantSchemaRow(database);
      insertClassificationSchemaRow(database);
      insertSubscriptionSchemaRow(database);
      const invalidTimestamp = 'x'.repeat(24);

      for (const [tableName, timestampColumn] of [
        ['reconciliation_candidates', 'created_at'],
        ['merchant_normalization_proposals', 'created_at'],
        ['classification_reviews', 'created_at'],
        ['subscription_candidates', 'evaluated_at'],
      ] as const) {
        expect(() =>
          database
            .prepare(
              `UPDATE ${tableName} SET ${timestampColumn} = ? WHERE id = ?`,
            )
            .run(invalidTimestamp, timestampRowIds[tableName]),
        ).toThrow();
      }

      for (const tableName of [
        'reconciliation_candidates',
        'merchant_normalization_proposals',
        'classification_reviews',
        'subscription_candidates',
      ] as const) {
        expect(() =>
          database
            .prepare(
              `UPDATE ${tableName} SET status = 'approved', decided_at = ? WHERE id = ?`,
            )
            .run(invalidTimestamp, timestampRowIds[tableName]),
        ).toThrow();
      }
    } finally {
      database.close();
    }
  });

  it('allows pending to become stale and pending again while enforcing decision timestamps', () => {
    const database = new Database(databasePath);
    try {
      insertReconciliationSchemaRow(database);
      insertMerchantSchemaRow(database);
      insertClassificationSchemaRow(database);
      insertSubscriptionSchemaRow(database);

      assertDecisionTimestampMatrix(
        database,
        'reconciliation_candidates',
        'reconciliation-status',
        ['approved', 'rejected'],
        ['stale', 'superseded'],
      );
      assertDecisionTimestampMatrix(
        database,
        'merchant_normalization_proposals',
        'merchant-status',
        ['approved', 'rejected', 'applied'],
        ['stale'],
      );
      assertDecisionTimestampMatrix(
        database,
        'classification_reviews',
        'classification-status',
        ['approved', 'rejected', 'applied'],
        ['stale'],
      );
      assertSubscriptionDecisionTimestampMatrix(database);
    } finally {
      database.close();
    }
  });

  it('persists pending detector-version resets as distinct semantic proposals', () => {
    const database = new Database(databasePath);
    try {
      insertMerchantSchemaRow(database, {
        detectorVersion: 1,
        id: 'merchant-v1',
      });
      insertMerchantSchemaRow(database, {
        detectorVersion: 2,
        id: 'merchant-v2',
      });
      expect(() =>
        insertMerchantSchemaRow(database, {
          detectorVersion: 2,
          id: 'merchant-v2-duplicate',
        }),
      ).toThrow();

      insertClassificationSchemaRow(database, {
        detectorVersion: 1,
        id: 'classification-v1',
      });
      insertClassificationSchemaRow(database, {
        detectorVersion: 2,
        id: 'classification-v2',
      });
      expect(() =>
        insertClassificationSchemaRow(database, {
          detectorVersion: 2,
          id: 'classification-v2-duplicate',
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('fails closed when a merchant deterministic ID collides with a different valid DTO', () => {
    const database = new Database(databasePath);
    try {
      const repository = new SqliteClassificationProposalRepository(database);
      const proposal = detect(repository).proposals.find(
        record => record.proposal.kind === 'merchant-alias',
      )?.proposal;
      if (proposal?.kind !== 'merchant-alias') {
        throw new Error('Missing merchant alias proposal');
      }
      database
        .prepare(
          "UPDATE merchant_normalization_proposals SET evidence_count = 3, confidence = 90, proposal_metadata_json = json_set(proposal_metadata_json, '$.evidenceTransactionIds', json(?)) WHERE id = ?",
        )
        .run(
          JSON.stringify(['alias-1', 'alias-2', 'alias-3']),
          proposal.proposalId,
        );

      expect(() =>
        repository.savePendingMerchantAlias(proposal, evaluatedAt),
      ).toThrow('does not match the insert');
    } finally {
      database.close();
    }
  });

  it('fails closed when a category deterministic ID collides with a different valid DTO', () => {
    const database = new Database(databasePath);
    try {
      const repository = new SqliteClassificationProposalRepository(database);
      const proposal = detectCategory(repository).proposals.find(
        record => record.proposal.kind === 'category',
      )?.proposal;
      if (proposal?.kind !== 'category') {
        throw new Error('Missing category proposal');
      }
      database
        .prepare(
          "UPDATE classification_reviews SET proposal_metadata_json = json_set(proposal_metadata_json, '$.eligibleHistoryCount', 4, '$.proposedCategoryCount', 4) WHERE id = ?",
        )
        .run(proposal.reviewId);

      expect(() =>
        repository.savePendingCategory(proposal, evaluatedAt),
      ).toThrow('does not match the insert');
    } finally {
      database.close();
    }
  });

  it.each([
    { label: 'short', signature: 'a'.repeat(63) },
    { label: 'uppercase', signature: 'A'.repeat(64) },
    { label: 'non-hex', signature: 'g'.repeat(64) },
  ])('rejects a $label subscription signature', ({ signature }) => {
    const database = new Database(databasePath);
    try {
      expect(() =>
        insertSubscriptionSchemaRow(database, { signature }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it.each(['2026-99-99', '2026-02-30'])(
    'rejects the non-canonical subscription date %s',
    invalidDate => {
      const database = new Database(databasePath);
      try {
        expect(() =>
          insertSubscriptionSchemaRow(database, {
            firstDate: invalidDate,
            lastDate: invalidDate,
          }),
        ).toThrow();
      } finally {
        database.close();
      }
    },
  );

  it('enforces subscription identifier and amount constraints', () => {
    const database = new Database(databasePath);
    try {
      for (const overrides of [
        { actualAccountId: '' },
        { actualScheduleId: '' },
        { medianAmount: 0 },
        { medianAmount: -1 },
        { recentPriceChangeBasisPoints: -1 },
      ]) {
        expect(() =>
          insertSubscriptionSchemaRow(database, overrides),
        ).toThrow();
      }

      insertSubscriptionSchemaRow(database, {
        actualAccountId: 'account-status',
        actualScheduleId: 'schedule-status',
        medianAmount: 1000,
        recentPriceChangeBasisPoints: 250,
      });
      expect(
        database
          .prepare(
            'SELECT median_amount FROM subscription_candidates WHERE id = ?',
          )
          .get('subscription-status'),
      ).toEqual({ median_amount: 1000 });
    } finally {
      database.close();
    }
  });

  it.each([
    {
      mutation:
        "UPDATE merchant_normalization_proposals SET proposal_metadata_json = json_set(proposal_metadata_json, '$.unexpected', 1)",
      expectedError: 'metadata is invalid',
    },
    {
      mutation:
        'UPDATE merchant_normalization_proposals SET evidence_count = evidence_count + 1',
      expectedError: 'columns disagree',
    },
  ])(
    'fails closed for corrupt durable proposal data',
    ({ mutation, expectedError }) => {
      const database = new Database(databasePath);
      const repository = new SqliteClassificationProposalRepository(database);
      detect(repository);
      database.prepare(mutation).run();

      expect(() => detect(repository)).toThrow(expectedError);
      database.close();
    },
  );
});

function columnNames(database: Database.Database, tableName: string): string[] {
  return (
    database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as readonly Readonly<{
      name: string;
    }>[]
  ).map(row => row.name);
}

function indexColumnNames(
  database: Database.Database,
  indexName: string,
): string[] {
  return (
    database
      .prepare(`PRAGMA index_info(${indexName})`)
      .all() as readonly Readonly<{
      name: string;
    }>[]
  ).map(row => row.name);
}

function assertDecisionTimestampMatrix(
  database: Database.Database,
  tableName:
    | 'reconciliation_candidates'
    | 'merchant_normalization_proposals'
    | 'classification_reviews'
    | 'subscription_candidates',
  id: string,
  decisionStatuses: readonly string[],
  staleStatuses: readonly string[],
): void {
  const updateStatus = database.prepare(
    `UPDATE ${tableName} SET status = ?, decided_at = ? WHERE id = ?`,
  );
  for (const status of decisionStatuses) {
    expect(() => updateStatus.run(status, null, id)).toThrow();
    updateStatus.run(status, evaluatedAt, id);
    updateStatus.run('pending', null, id);
  }
  for (const status of staleStatuses) {
    updateStatus.run(status, null, id);
    updateStatus.run('pending', null, id);
    updateStatus.run(status, evaluatedAt, id);
    expect(() => updateStatus.run('pending', evaluatedAt, id)).toThrow();
    updateStatus.run('pending', null, id);
  }
}

function assertSubscriptionDecisionTimestampMatrix(
  database: Database.Database,
): void {
  const updateStatusAndDecision = database.prepare(
    'UPDATE subscription_candidates SET status = ?, decided_at = ? WHERE id = ?',
  );
  const updateStatus = database.prepare(
    'UPDATE subscription_candidates SET status = ? WHERE id = ?',
  );

  updateStatusAndDecision.run('pending', evaluatedAt, 'subscription-status');
  updateStatusAndDecision.run('stale', null, 'subscription-status');
  updateStatusAndDecision.run('stale', evaluatedAt, 'subscription-status');
  updateStatusAndDecision.run('pending', null, 'subscription-status');

  for (const status of ['approved', 'rejected', 'deferred', 'applied']) {
    expect(() =>
      updateStatusAndDecision.run(status, null, 'subscription-status'),
    ).toThrow();
    updateStatusAndDecision.run(status, evaluatedAt, 'subscription-status');
    if (status === 'approved' || status === 'deferred') {
      updateStatus.run('stale', 'subscription-status');
      updateStatus.run('pending', 'subscription-status');
      expect(
        database
          .prepare(
            'SELECT status, decided_at FROM subscription_candidates WHERE id = ?',
          )
          .get('subscription-status'),
      ).toEqual({ decided_at: evaluatedAt, status: 'pending' });
    }
    updateStatusAndDecision.run('pending', null, 'subscription-status');
  }
}

function insertReconciliationSchemaRow(database: Database.Database): void {
  database.exec('CREATE TABLE source_transactions (id TEXT PRIMARY KEY)');
  database
    .prepare("INSERT INTO source_transactions (id) VALUES ('source-status')")
    .run();
  database
    .prepare(
      "INSERT INTO reconciliation_candidates (id, source_transaction_id, actual_transaction_id, actual_target_version, score, reason_codes_json, matcher_version, status, decided_at, created_at) VALUES ('reconciliation-status', 'source-status', 'actual-status', ?, 80, '[]', 1, 'pending', NULL, ?)",
    )
    .run('a'.repeat(64), evaluatedAt);
}

function insertMerchantSchemaRow(
  database: Database.Database,
  overrides: Readonly<{
    detectorVersion?: number;
    id?: string;
  }> = {},
): void {
  const detectorVersion = overrides.detectorVersion ?? 1;
  database
    .prepare(
      "INSERT INTO merchant_normalization_proposals (id, imported_payee, normalized_imported_payee, proposed_actual_payee_id, evidence_count, confidence, reason_codes_json, detector_version, status, created_at, decided_at, proposal_metadata_json) VALUES (?, 'Coffee Shop', 'coffee shop', 'payee-status', 2, 80, '[\"consistent-imported-payee-alias\"]', ?, 'pending', ?, NULL, ?)",
    )
    .run(
      overrides.id ?? 'merchant-status',
      detectorVersion,
      evaluatedAt,
      JSON.stringify({ contractVersion: 1, detectorVersion }),
    );
}

function insertClassificationSchemaRow(
  database: Database.Database,
  overrides: Readonly<{
    detectorVersion?: number;
    id?: string;
  }> = {},
): void {
  const detectorVersion = overrides.detectorVersion ?? 1;
  database
    .prepare(
      "INSERT INTO classification_reviews (id, actual_transaction_id, actual_target_version, proposed_category_id, proposed_action, confidence, reason_codes_json, detector_version, status, created_at, decided_at, proposal_metadata_json) VALUES (?, 'actual-status', ?, 'category-status', 'categorize_once', 100, '[\"dominant-category-history\"]', ?, 'pending', ?, NULL, ?)",
    )
    .run(
      overrides.id ?? 'classification-status',
      'b'.repeat(64),
      detectorVersion,
      evaluatedAt,
      JSON.stringify({ contractVersion: 1, detectorVersion }),
    );
}

function insertSubscriptionSchemaRow(
  database: Database.Database,
  overrides: Readonly<{
    actualAccountId?: string | null;
    actualScheduleId?: string | null;
    firstDate?: string;
    lastDate?: string;
    medianAmount?: number;
    recentPriceChangeBasisPoints?: number | null;
    signature?: string;
  }> = {},
): void {
  database
    .prepare(
      "INSERT INTO subscription_candidates (id, actual_payee_id, actual_account_id, signature, detector_version, cadence, cadence_interval, occurrence_count, first_date, last_date, median_amount, amount_variance_basis_points, date_variance_days, recent_price_change_basis_points, candidate_type, confidence, reason_codes_json, status, actual_schedule_id, evaluated_at, decided_at) VALUES ('subscription-status', 'payee-status', ?, ?, 1, 'monthly', 1, 3, ?, ?, ?, 0, 0, ?, 'subscription', 80, '[]', 'pending', ?, ?, NULL)",
    )
    .run(
      overrides.actualAccountId ?? null,
      overrides.signature ?? 'c'.repeat(64),
      overrides.firstDate ?? '2026-05-31',
      overrides.lastDate ?? '2026-07-31',
      overrides.medianAmount ?? 1000,
      overrides.recentPriceChangeBasisPoints ?? null,
      overrides.actualScheduleId ?? null,
      evaluatedAt,
    );
}

function detect(repository: SqliteClassificationProposalRepository) {
  return detectClassificationProposals({
    boundBudgetCurrency: 'USD',
    evaluatedAt,
    repository,
    ruleSetSnapshot: emptyRuleSetSnapshot,
    snapshot: snapshot([
      transaction({ id: 'alias-1' }),
      transaction({ id: 'alias-2' }),
    ]),
  });
}

function detectCategory(repository: SqliteClassificationProposalRepository) {
  return detectClassificationProposals({
    boundBudgetCurrency: 'USD',
    evaluatedAt,
    repository,
    ruleSetSnapshot: emptyRuleSetSnapshot,
    snapshot: snapshot([
      transaction({ categoryId: 'category-1', id: 'history-1' }),
      transaction({ categoryId: 'category-1', id: 'history-2' }),
      transaction({ categoryId: 'category-1', id: 'history-3' }),
      transaction({ id: 'target' }),
    ]),
  });
}

function snapshot(
  transactions: readonly ActualTransactionV1[],
): ActualBudgetSnapshotV1 {
  return {
    budget: {
      budgetKeyHash: 'b'.repeat(64),
      capturedAt: evaluatedAt,
      currencyCode: 'USD',
    },
    contractVersion: 1,
    categories: [
      {
        groupId: 'group-1',
        hidden: false,
        id: 'category-1',
        isIncome: false,
        name: 'Food',
      },
    ],
    payees: [{ id: 'payee-1', name: 'Coffee Shop', transferAccountId: null }],
    transactions,
  };
}

function transaction({
  id,
  ...overrides
}: Partial<ActualTransactionV1> &
  Pick<ActualTransactionV1, 'id'>): ActualTransactionV1 {
  return {
    accountId: 'account-1',
    amountMinorUnits: -500,
    categoryId: null,
    cleared: false,
    date: '2026-07-30',
    id,
    importedId: `import-${id}`,
    importedPayee: 'Coffee Shop',
    isChild: false,
    isParent: false,
    isStartingBalance: false,
    notes: null,
    parentId: null,
    payeeId: 'payee-1',
    reconciled: false,
    tombstone: false,
    transferId: null,
    ...overrides,
  };
}
