// @ts-strict-ignore
import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { post } from '#server/post';
import { getServer } from '#server/server-config';
import { setSyncingMode } from '#server/sync';
import { handlers } from '#server/tests/mockSyncServer';
import { insertRule, loadRules } from '#server/transactions/transaction-rules';
import * as monthUtils from '#shared/months';
import type { SyncedPrefs } from '#types/prefs';

import { app as accountsApp } from './app';
import {
  addTransactions,
  reconcileTransactions,
  simpleFinBatchSync,
} from './sync';

vi.mock('#shared/months', async () => ({
  ...(await vi.importActual('#shared/months')),
  currentDay: vi.fn(),
  currentMonth: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(monthUtils.currentDay).mockReturnValue('2017-10-15');
  vi.mocked(monthUtils.currentMonth).mockReturnValue('2017-10');
  await global.emptyDatabase()();
  await loadMappings();
  await loadRules();
});

function getAllTransactions() {
  return db.all<
    db.DbViewTransactionInternal & { payee_name: db.DbPayee['name'] }
  >(
    `SELECT t.*, p.name as payee_name
       FROM v_transactions_internal t
       LEFT JOIN payees p ON p.id = t.payee
       ORDER BY date DESC, amount DESC, id
     `,
  );
}

async function prepareDatabase() {
  await db.insertCategoryGroup({ id: 'group1', name: 'group1', is_income: 1 });
  await db.insertCategory({
    name: 'income',
    cat_group: 'group1',
    is_income: 1,
  });

  const { accounts } = await post(getServer().GOCARDLESS_SERVER + '/accounts', {
    client_id: '',
    group_id: '',
    item_id: '1',
  });
  const acct = accounts[0];

  const id = await db.insertAccount({
    id: 'one',
    account_id: acct.account_id,
    name: acct.official_name,
    balance_current: acct.balances.current,
  });
  await db.insertPayee({
    id: 'transfer-' + id,
    name: '',
    transfer_acct: id,
  });

  return { id, account_id: acct.account_id };
}

async function getAllPayees() {
  return (await db.getPayees()).filter(p => p.transfer_acct == null);
}

async function prepareLocalAccount(id: string) {
  await db.insertAccount({ id, name: id });
  await db.insertPayee({
    id: `transfer-${id}`,
    name: '',
    transfer_acct: id,
  });
}

async function getStoredTransactionCounts() {
  return db.first<{ active: number; tombstoned: number }>(
    `SELECT
       (SELECT COUNT(*) FROM v_transactions_internal) AS active,
       (SELECT COUNT(*) FROM transactions WHERE tombstone = 1) AS tombstoned`,
  );
}

describe('Account sync', () => {
  test('reconcile creates payees correctly', async () => {
    const { id } = await prepareDatabase();

    let payees = await getAllPayees();
    expect(payees.length).toBe(0);

    await reconcileTransactions(id, [
      { date: '2020-01-02', payee_name: 'bakkerij', amount: 4133 },
      { date: '2020-01-03', payee_name: 'kroger', amount: 5000 },
    ]);

    payees = await getAllPayees();
    expect(payees.length).toBe(2);

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(2);
    expect(transactions.find(t => t.amount === 4133).payee).toBe(
      payees.find(p => p.name === 'Bakkerij').id,
    );
    expect(transactions.find(t => t.amount === 5000).payee).toBe(
      payees.find(p => p.name === 'Kroger').id,
    );
  });

  test('reconcile handles transactions with undefined fields', async () => {
    const { id: acctId } = await prepareDatabase();

    await db.insertTransaction({
      id: 'one',
      account: acctId,
      amount: 2948,
      date: '2020-01-01',
    });

    await reconcileTransactions(acctId, [
      { date: '2020-01-02' },
      { date: '2020-01-01', amount: 2948 },
    ]);

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(2);
    expect(transactions).toMatchSnapshot();

    // No payees should be created
    const payees = await getAllPayees();
    expect(payees.length).toBe(0);

    // Make _at least_ the date is required
    await expect(reconcileTransactions(acctId, [{}])).rejects.toThrow(
      /`date` is required/,
    );
  });

  test('reconcile doesnt rematch deleted transactions if reimport disabled', async () => {
    const { id: acctId } = await prepareDatabase();
    const reimportKey =
      `sync-reimport-deleted-${acctId}` satisfies keyof SyncedPrefs;
    await db.update('preferences', { id: reimportKey, value: 'false' });

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid' },
    ]);

    const transactions1 = await getAllTransactions();
    expect(transactions1.length).toBe(1);

    await db.deleteTransaction(transactions1[0]);

    expect(await getStoredTransactionCounts()).toEqual({
      active: 1,
      tombstoned: 1,
    });

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid' },
    ]);
    const transactions2 = await getAllTransactions();
    expect(transactions2.length).toBe(1);
    expect(await getStoredTransactionCounts()).toEqual({
      active: 1,
      tombstoned: 1,
    });
    expect(transactions2).toMatchSnapshot();
  });

  test('reconcile does rematch deleted transactions by default', async () => {
    const { id: acctId } = await prepareDatabase();

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid' },
    ]);

    const transactions1 = await getAllTransactions();
    expect(transactions1.length).toBe(1);

    await db.deleteTransaction(transactions1[0]);

    expect(await getStoredTransactionCounts()).toEqual({
      active: 1,
      tombstoned: 1,
    });

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid' },
    ]);
    const transactions2 = await getAllTransactions();
    expect(transactions2.length).toBe(2);
    expect(await getStoredTransactionCounts()).toEqual({
      active: 2,
      tombstoned: 1,
    });
    expect(transactions2).toMatchSnapshot();
  });

  test('reconcile doesnt rematch deleted transactions with reimportDeleted override false', async () => {
    const { id: acctId } = await prepareDatabase();

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid-override' },
    ]);

    const transactions1 = await getAllTransactions();
    expect(transactions1.length).toBe(1);

    await db.deleteTransaction(transactions1[0]);

    await reconcileTransactions(
      acctId,
      [{ date: '2020-01-01', imported_id: 'finid-override' }],
      false,
      true,
      false,
      true,
      false,
      false,
    );
    const transactions2 = await getAllTransactions();
    expect(transactions2.length).toBe(1);
    expect(await getStoredTransactionCounts()).toEqual({
      active: 1,
      tombstoned: 1,
    });
  });

  test('reconcile does rematch deleted transactions with reimportDeleted override true', async () => {
    const { id: acctId } = await prepareDatabase();

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid-override2' },
    ]);

    const transactions1 = await getAllTransactions();
    expect(transactions1.length).toBe(1);

    await db.deleteTransaction(transactions1[0]);

    await reconcileTransactions(
      acctId,
      [{ date: '2020-01-01', imported_id: 'finid-override2' }],
      false,
      true,
      false,
      true,
      false,
      true,
    );
    const transactions2 = await getAllTransactions();
    expect(transactions2.length).toBe(2);
    expect(await getStoredTransactionCounts()).toEqual({
      active: 2,
      tombstoned: 1,
    });
  });

  test('reimportDeleted override takes precedence over stored preference', async () => {
    const { id: acctId } = await prepareDatabase();
    const reimportKey =
      `sync-reimport-deleted-${acctId}` satisfies keyof SyncedPrefs;
    // Preference says reimport (true), but override says don't (false)
    await db.update('preferences', { id: reimportKey, value: 'true' });

    await reconcileTransactions(acctId, [
      { date: '2020-01-01', imported_id: 'finid-precedence' },
    ]);

    const transactions1 = await getAllTransactions();
    expect(transactions1.length).toBe(1);

    await db.deleteTransaction(transactions1[0]);

    await reconcileTransactions(
      acctId,
      [{ date: '2020-01-01', imported_id: 'finid-precedence' }],
      false,
      true,
      false,
      true,
      false,
      false,
    );
    const transactions2 = await getAllTransactions();
    expect(transactions2.length).toBe(1);
  });

  test('reconcile run rules with inferred payee', async () => {
    const { id: acctId } = await prepareDatabase();
    await db.insertCategoryGroup({
      id: 'group2',
      name: 'group2',
    });
    const catId = await db.insertCategory({
      name: 'Food',
      cat_group: 'group2',
    });

    const payeeId = await db.insertPayee({ name: 'bakkerij' });

    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: payeeId }],
      actions: [{ op: 'set', field: 'category', value: catId }],
    });

    await reconcileTransactions(acctId, [
      { date: '2020-01-02', payee_name: 'Bakkerij', amount: 4133 },
    ]);

    const transactions = await getAllTransactions();
    // Even though the payee was inferred from the string name (no
    // renaming rules ran), it should match the above rule and set the
    // category
    expect(transactions.length).toBe(1);
    expect(transactions[0].payee).toBe(payeeId);
    expect(transactions[0].category).toBe(catId);

    // It also should not have created a payee
    const payees = await getAllPayees();
    expect(payees.length).toBe(1);
    expect(payees[0].id).toBe(payeeId);
  });

  test('reconcile avoids creating blank payees', async () => {
    const { id: acctId } = await prepareDatabase();

    await reconcileTransactions(acctId, [
      { date: '2020-01-02', payee_name: '     ', amount: 4133 },
    ]);

    const transactions = await getAllTransactions();
    // Even though the payee was inferred from the string name (no
    // renaming rules ran), it should match the above rule and set the
    // category
    expect(transactions.length).toBe(1);
    expect(transactions[0].payee).toBe(null);
    expect(transactions[0].amount).toBe(4133);
    expect(transactions[0].date).toBe(20200102);

    // It also should not have created a payee
    const payees = await getAllPayees();
    expect(payees.length).toBe(0);
  });

  test('reconcile run rules dont create unnecessary payees', async () => {
    const { id: acctId } = await prepareDatabase();

    const payeeId = await db.insertPayee({ name: 'bakkerij-renamed' });

    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Bakkerij' }],
      actions: [{ op: 'set', field: 'payee', value: payeeId }],
    });

    await reconcileTransactions(acctId, [
      { date: '2020-01-02', payee_name: 'bakkerij', amount: 4133 },
    ]);

    const payees = await getAllPayees();
    expect(payees.length).toBe(1);
    expect(payees[0].id).toBe(payeeId);

    const transactions = await getAllTransactions();
    expect(transactions.length).toBe(1);
    expect(transactions[0].payee).toBe(payeeId);
  });

  const testMapped = version => {
    test(`reconcile matches unmapped and mapped payees (${version})`, async () => {
      const { id: acctId } = await prepareDatabase();

      if (version === 'v1') {
        // This is quite complicated, but important to test. If a payee is
        // merged with another, a rule sets the payee of a transaction to
        // the updated one, make sure it still matches an existing
        // transaction that points to the old merged payee
      } else if (version === 'v2') {
        // This is similar to v1, but inverted: make sure that
        // if a rule sets the payee to an *old* payee, that it still
        // matches to a transaction with the new payee that it was merged
        // to
      }

      const payeeId1 = await db.insertPayee({ name: 'bakkerij2' });
      const payeeId2 = await db.insertPayee({ name: 'bakkerij-renamed' });

      // Insert a rule *before* payees are merged. Not that v2 would
      // fail if we inserted this rule after, because the rule would
      // set to an *old* payee but the matching would take place on a
      // *new* payee. But that's ok - it would fallback to matching
      // amount anyway, so while it loses some fidelity, it's an edge
      // case that we don't need to worry much about because the user
      // shouldn't be able able to create rules for a merged payee.
      // Unless they sync in a rule...
      await insertRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'imported_payee', value: 'Bakkerij' }],
        actions: [{ op: 'set', field: 'payee', value: payeeId2 }],
      });

      if (version === 'v1') {
        await db.mergePayees(payeeId2, [payeeId1]);
      } else if (version === 'v2') {
        await db.mergePayees(payeeId1, [payeeId2]);
      }

      await db.insertTransaction({
        id: 'one',
        account: acctId,
        amount: -2947,
        date: '2017-10-15',
        payee: payeeId1,
      });
      // It will try to match to this one first, make sure it matches
      // the above transaction though
      await db.insertTransaction({
        id: 'two',
        account: acctId,
        amount: -2947,
        date: '2017-10-17',
        payee: null,
      });

      const { updated } = await reconcileTransactions(acctId, [
        {
          date: '2017-10-17',
          payee_name: 'bakkerij',
          amount: -2947,
          imported_id: 'imported1',
        },
      ]);

      const payees = await getAllPayees();
      expect(payees.length).toBe(1);
      expect(payees[0].id).toBe(version === 'v1' ? payeeId2 : payeeId1);

      expect(updated.length).toBe(1);
      expect(updated[0]).toBe('one');

      const transactions = await getAllTransactions();
      expect(transactions.length).toBe(2);
      expect(transactions.find(t => t.id === 'one').imported_id).toBe(
        'imported1',
      );
    });
  };

  testMapped('v1');
  testMapped('v2');

  test('addTransactions simply adds transactions', async () => {
    const { id: acctId } = await prepareDatabase();

    const payeeId = await db.insertPayee({ name: 'bakkerij-renamed' });

    // Make sure it still runs rules
    await insertRule({
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Bakkerij' }],
      actions: [{ op: 'set', field: 'payee', value: payeeId }],
    });

    const transactions = [
      {
        date: '2017-10-17',
        payee_name: 'BAKKerij',
        amount: -2947,
      },
      {
        date: '2017-10-18',
        payee_name: 'bakkERIj2',
        amount: -2947,
      },
      {
        date: '2017-10-19',
        payee_name: 'bakkerij3',
        amount: -2947,
      },
      {
        date: '2017-10-20',
        payee_name: 'BakkeriJ3',
        amount: -2947,
      },
    ];

    const added = await addTransactions(acctId, transactions);
    expect(added.length).toBe(transactions.length);

    const payees = await getAllPayees();
    expect(payees.length).toBe(3);

    const getName = id => payees.find(p => p.id === id).name;

    const allTransactions = await getAllTransactions();
    expect(allTransactions.length).toBe(4);
    expect(allTransactions.map(t => getName(t.payee))).toEqual([
      'bakkerij3',
      'bakkerij3',
      'bakkERIj2',
      'bakkerij-renamed',
    ]);
  });

  test("reconcile does not merge transactions with different 'imported_id' values", async () => {
    const { id } = await prepareDatabase();

    let payees = await getAllPayees();
    expect(payees.length).toBe(0);

    // Add first transaction
    await reconcileTransactions(id, [
      {
        date: '2024-04-05',
        amount: -1239,
        imported_payee: 'Acme Inc.',
        payee_name: 'Acme Inc.',
        imported_id: 'b85cdd57-5a1c-4ca5-bd54-12e5b56fa02c',
        notes: 'TEST TRANSACTION',
        cleared: true,
      },
    ]);

    payees = await getAllPayees();
    expect(payees.length).toBe(1);

    let transactions = await getAllTransactions();
    expect(transactions.length).toBe(1);

    // Add second transaction
    await reconcileTransactions(id, [
      {
        date: '2024-04-06',
        amount: -1239,
        imported_payee: 'Acme Inc.',
        payee_name: 'Acme Inc.',
        imported_id: 'ca1589b2-7bc3-4587-a157-476170b383a7',
        notes: 'TEST TRANSACTION',
        cleared: true,
      },
    ]);

    payees = await getAllPayees();
    expect(payees.length).toBe(1);

    transactions = await getAllTransactions();
    expect(transactions.length).toBe(2);

    expect(
      transactions.find(
        t => t.imported_id === 'b85cdd57-5a1c-4ca5-bd54-12e5b56fa02c',
      ).amount,
    ).toBe(-1239);
    expect(
      transactions.find(
        t => t.imported_id === 'ca1589b2-7bc3-4587-a157-476170b383a7',
      ).amount,
    ).toBe(-1239);
  });

  test(
    'given an imported tx with no imported_id, ' +
      'when using fuzzy search V2, existing transaction has an imported_id, matches amount, and is within 7 days of imported tx, ' +
      'then imported tx should reconcile with existing transaction from fuzzy match',
    async () => {
      const { id } = await prepareDatabase();

      let payees = await getAllPayees();
      expect(payees.length).toBe(0);

      const existingTx = {
        date: '2024-04-05',
        amount: -1239,
        imported_payee: 'Acme Inc.',
        payee_name: 'Acme Inc.',
        imported_id: 'b85cdd57-5a1c-4ca5-bd54-12e5b56fa02c',
        notes: 'TEST TRANSACTION',
        cleared: true,
      };

      // Add transaction to represent existing transaction with imoprted_id
      await reconcileTransactions(id, [existingTx]);

      payees = await getAllPayees();
      expect(payees.length).toBe(1);

      let transactions = await getAllTransactions();
      expect(transactions.length).toBe(1);

      // Import transaction similar to existing but with different date and no imported_id
      await reconcileTransactions(id, [
        {
          ...existingTx,
          date: '2024-04-06',
          imported_id: null,
        },
      ]);

      payees = await getAllPayees();
      expect(payees.length).toBe(1);

      transactions = await getAllTransactions();
      expect(transactions.length).toBe(1);

      expect(transactions[0].amount).toBe(-1239);
    },
  );

  test(
    'given an imported tx has an imported_id, ' +
      'when not using fuzzy search V2, existing transaction has an imported_id, matches amount, and is within 7 days of imported tx, ' +
      'then imported tx should reconcile with existing transaction from fuzzy match',
    async () => {
      const { id } = await prepareDatabase();

      let payees = await getAllPayees();
      expect(payees.length).toBe(0);

      const existingTx = {
        date: '2024-04-05',
        amount: -1239,
        imported_payee: 'Acme Inc.',
        payee_name: 'Acme Inc.',
        imported_id: 'b85cdd57-5a1c-4ca5-bd54-12e5b56fa02c',
        notes: 'TEST TRANSACTION',
        cleared: true,
      };

      // Add transaction to represent existing transaction with imoprted_id
      await reconcileTransactions(id, [existingTx]);

      payees = await getAllPayees();
      expect(payees.length).toBe(1);

      let transactions = await getAllTransactions();
      expect(transactions.length).toBe(1);

      // Import transaction similar to existing but with different date and imported_id
      await reconcileTransactions(
        id,
        [
          {
            ...existingTx,
            date: '2024-04-06',
            imported_id: 'something-else-entirely',
          },
        ],
        false,
        false,
      );

      payees = await getAllPayees();
      expect(payees.length).toBe(1);

      transactions = await getAllTransactions();
      expect(transactions.length).toBe(1);

      expect(transactions[0].amount).toBe(-1239);
    },
  );

  test('characterizes exact account-scoped stable-ID reruns and protected-field merging', async () => {
    const accountId = 'characterized-exact-account';
    await prepareLocalAccount(accountId);
    await db.insertCategoryGroup({
      id: 'characterized-category-group',
      name: 'Characterized categories',
    });
    const existingPayeeId = await db.insertPayee({ name: 'Existing payee' });
    const incomingPayeeId = await db.insertPayee({ name: 'Incoming payee' });
    const existingCategoryId = await db.insertCategory({
      name: 'Existing category',
      cat_group: 'characterized-category-group',
    });
    const incomingCategoryId = await db.insertCategory({
      name: 'Incoming category',
      cat_group: 'characterized-category-group',
    });

    await db.insertTransaction({
      id: 'exact-existing',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      imported_id: 'exact-stable-id',
      payee: existingPayeeId,
      category: existingCategoryId,
      notes: 'manual note',
      imported_payee: 'old provider text',
      raw_synced_data: '{"source":"existing"}',
      cleared: false,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -9_999,
        imported_id: 'exact-stable-id',
        payee: incomingPayeeId,
        category: incomingCategoryId,
        notes: 'incoming note',
        imported_payee: 'new provider text',
        raw_synced_data: '{"source":"incoming"}',
        cleared: true,
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['exact-existing']);

    const [transaction] = await getAllTransactions();
    expect(transaction).toMatchObject({
      id: 'exact-existing',
      account: accountId,
      imported_id: 'exact-stable-id',
      amount: -1_234,
      date: 20240405,
      payee: existingPayeeId,
      category: existingCategoryId,
      notes: 'manual note',
      imported_payee: 'new provider text',
      raw_synced_data: '{"source":"existing"}',
      cleared: 1,
    });
  });

  test('characterizes the same textual stable ID as separate identities in separate accounts', async () => {
    const firstAccountId = 'characterized-first-account';
    const secondAccountId = 'characterized-second-account';
    await prepareLocalAccount(firstAccountId);
    await prepareLocalAccount(secondAccountId);

    const firstResult = await reconcileTransactions(firstAccountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'shared-provider-id',
        payee_name: 'Account one merchant',
      },
    ]);
    const secondResult = await reconcileTransactions(secondAccountId, [
      {
        date: '2024-04-05',
        amount: -5_678,
        imported_id: 'shared-provider-id',
        payee_name: 'Account two merchant',
      },
    ]);

    expect(firstResult.added).toHaveLength(1);
    expect(secondResult.added).toHaveLength(1);
    const transactionsWithSharedId = (await getAllTransactions())
      .filter(transaction => transaction.imported_id === 'shared-provider-id')
      .sort((first, second) => first.account.localeCompare(second.account));
    expect(transactionsWithSharedId).toMatchObject([
      { account: firstAccountId, amount: -1_234 },
      { account: secondAccountId, amount: -5_678 },
    ]);

    const rerunResult = await reconcileTransactions(firstAccountId, [
      {
        date: '2024-04-06',
        amount: -9_999,
        imported_id: 'shared-provider-id',
        payee_name: 'Changed account one merchant',
      },
    ]);
    expect(rerunResult.added).toEqual([]);
    expect(rerunResult.updated).toEqual([firstResult.added[0]]);
    expect(
      (await getAllTransactions())
        .filter(transaction => transaction.imported_id === 'shared-provider-id')
        .sort((first, second) => first.account.localeCompare(second.account)),
    ).toMatchObject([
      { account: firstAccountId, amount: -1_234 },
      { account: secondAccountId, amount: -5_678 },
    ]);
  });

  test('characterizes strict changed stable IDs as separate transactions', async () => {
    const accountId = 'characterized-strict-account';
    await prepareLocalAccount(accountId);

    const firstResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'strict-original-id',
        payee_name: 'Strict merchant',
      },
    ]);
    const secondResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -1_234,
        imported_id: 'strict-changed-id',
        payee_name: 'Strict merchant',
      },
    ]);

    expect(firstResult.added).toHaveLength(1);
    expect(secondResult.added).toHaveLength(1);
    expect(secondResult.updated).toEqual([]);
    expect(
      (await getAllTransactions())
        .map(transaction => transaction.imported_id)
        .sort(),
    ).toEqual(['strict-changed-id', 'strict-original-id']);
  });

  test('characterizes stable IDs as case-sensitive in strict reconciliation', async () => {
    const accountId = 'characterized-case-sensitive-account';
    await prepareLocalAccount(accountId);

    const firstResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'Case-Sensitive-ID',
        payee_name: 'Case merchant',
      },
    ]);
    const secondResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'case-sensitive-id',
        payee_name: 'Case merchant',
      },
    ]);

    expect(firstResult.added).toHaveLength(1);
    expect(secondResult.added).toHaveLength(1);
    expect(secondResult.updated).toEqual([]);
    expect(
      (await getAllTransactions())
        .map(transaction => transaction.imported_id)
        .sort(),
    ).toEqual(['Case-Sensitive-ID', 'case-sensitive-id']);
  });

  test('characterizes no-ID fuzzy matching without creating a durable stable ID', async () => {
    const accountId = 'characterized-no-id-account';
    await prepareLocalAccount(accountId);
    const payeeId = await db.insertPayee({ name: 'No ID merchant' });
    await db.insertTransaction({
      id: 'manual-no-id-target',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      payee: payeeId,
      cleared: false,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -1_234,
        payee: payeeId,
        cleared: true,
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['manual-no-id-target']);
    expect(await getAllTransactions()).toMatchObject([
      { id: 'manual-no-id-target', imported_id: null, cleared: 1 },
    ]);
  });

  test('characterizes two same-day, same-amount, same-payee no-ID purchases as separate additions', async () => {
    const accountId = 'characterized-repeated-no-id-account';
    await prepareLocalAccount(accountId);

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        payee_name: 'Repeated merchant',
      },
      {
        date: '2024-04-05',
        amount: -1_234,
        payee_name: 'Repeated merchant',
      },
    ]);

    expect(result.added).toHaveLength(2);
    expect(result.updated).toEqual([]);
    expect(await getAllTransactions()).toMatchObject([
      { account: accountId, amount: -1_234, imported_id: null },
      { account: accountId, amount: -1_234, imported_id: null },
    ]);
  });

  test('characterizes same-ID cleared promotion without cleared demotion', async () => {
    const accountId = 'characterized-cleared-account';
    await prepareLocalAccount(accountId);

    const firstResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'cleared-stable-id',
        payee_name: 'Cleared merchant',
        cleared: false,
      },
    ]);
    const promotionResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -1_234,
        imported_id: 'cleared-stable-id',
        payee_name: 'Cleared merchant',
        cleared: true,
      },
    ]);
    const demotionResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-07',
        amount: -1_234,
        imported_id: 'cleared-stable-id',
        payee_name: 'Cleared merchant',
        cleared: false,
      },
    ]);

    expect(firstResult.added).toHaveLength(1);
    expect(promotionResult.updated).toEqual([firstResult.added[0]]);
    expect(demotionResult.added).toEqual([]);
    expect(demotionResult.updated).toEqual([]);
    expect(await getAllTransactions()).toMatchObject([
      { imported_id: 'cleared-stable-id', cleared: 1 },
    ]);
  });

  test('characterizes a reconciled exact target as ignored without mutation or addition', async () => {
    const accountId = 'characterized-reconciled-account';
    await prepareLocalAccount(accountId);
    await db.insertTransaction({
      id: 'reconciled-target',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      imported_id: 'reconciled-stable-id',
      notes: 'locked note',
      cleared: false,
      reconciled: true,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -9_999,
        imported_id: 'reconciled-stable-id',
        notes: 'incoming note',
        cleared: true,
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.updatedPreview).toEqual([
      expect.objectContaining({ ignored: true }),
    ]);
    expect(await getAllTransactions()).toMatchObject([
      {
        id: 'reconciled-target',
        amount: -1_234,
        date: 20240405,
        notes: 'locked note',
        cleared: 0,
        reconciled: 1,
      },
    ]);
  });

  test('characterizes real preview and commit agreement without preview mutation', async () => {
    const accountId = 'characterized-preview-account';
    await prepareLocalAccount(accountId);
    await db.insertTransaction({
      id: 'preview-update-target',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      imported_id: 'preview-update-id',
      cleared: false,
    });
    await db.insertTransaction({
      id: 'preview-ignored-target',
      account: accountId,
      amount: -2_345,
      date: '2024-04-05',
      imported_id: 'preview-ignored-id',
      cleared: false,
    });
    await db.insertTransaction({
      id: 'preview-locked-target',
      account: accountId,
      amount: -3_456,
      date: '2024-04-05',
      imported_id: 'preview-locked-id',
      cleared: false,
      reconciled: true,
    });

    const addedPreview = await reconcileTransactions(
      accountId,
      [
        {
          date: '2024-04-06',
          amount: -4_567,
          imported_id: 'preview-added-id',
        },
      ],
      false,
      true,
      true,
    );
    const updatedPreview = await reconcileTransactions(
      accountId,
      [
        {
          date: '2024-04-06',
          amount: -1_234,
          imported_id: 'preview-update-id',
          cleared: true,
        },
      ],
      false,
      true,
      true,
    );
    const ignoredPreview = await reconcileTransactions(
      accountId,
      [
        {
          date: '2024-04-05',
          amount: -2_345,
          imported_id: 'preview-ignored-id',
          cleared: false,
        },
      ],
      false,
      true,
      true,
    );
    const lockedPreview = await reconcileTransactions(
      accountId,
      [
        {
          date: '2024-04-06',
          amount: -3_456,
          imported_id: 'preview-locked-id',
          cleared: true,
        },
      ],
      false,
      true,
      true,
    );

    expect(addedPreview.added).toHaveLength(1);
    expect(addedPreview.updated).toEqual([]);
    expect(updatedPreview.added).toEqual([]);
    expect(updatedPreview.updated).toEqual(['preview-update-target']);
    expect(ignoredPreview.added).toEqual([]);
    expect(ignoredPreview.updated).toEqual([]);
    expect(ignoredPreview.updatedPreview).toEqual([
      expect.objectContaining({ ignored: true }),
    ]);
    expect(lockedPreview.added).toEqual([]);
    expect(lockedPreview.updated).toEqual([]);
    expect(lockedPreview.updatedPreview).toEqual([
      expect.objectContaining({ ignored: true }),
    ]);
    const transactionsAfterPreviews = await getAllTransactions();
    expect(transactionsAfterPreviews).toHaveLength(3);
    expect(
      transactionsAfterPreviews.find(
        transaction => transaction.id === 'preview-update-target',
      ),
    ).toMatchObject({ id: 'preview-update-target', cleared: 0, reconciled: 0 });
    expect(
      transactionsAfterPreviews.find(
        transaction => transaction.id === 'preview-ignored-target',
      ),
    ).toMatchObject({
      id: 'preview-ignored-target',
      cleared: 0,
      reconciled: 0,
    });
    expect(
      transactionsAfterPreviews.find(
        transaction => transaction.id === 'preview-locked-target',
      ),
    ).toMatchObject({ id: 'preview-locked-target', cleared: 0, reconciled: 1 });

    const addedCommit = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -4_567,
        imported_id: 'preview-added-id',
      },
    ]);
    const updatedCommit = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -1_234,
        imported_id: 'preview-update-id',
        cleared: true,
      },
    ]);
    const ignoredCommit = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -2_345,
        imported_id: 'preview-ignored-id',
        cleared: false,
      },
    ]);
    const lockedCommit = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -3_456,
        imported_id: 'preview-locked-id',
        cleared: true,
      },
    ]);

    expect(addedCommit.added).toHaveLength(1);
    expect(updatedCommit.updated).toEqual(['preview-update-target']);
    expect(ignoredCommit.updated).toEqual([]);
    expect(ignoredCommit.updatedPreview).toEqual([
      expect.objectContaining({ ignored: true }),
    ]);
    expect(lockedCommit.updated).toEqual([]);
    expect(lockedCommit.updatedPreview).toEqual([
      expect.objectContaining({ ignored: true }),
    ]);
    const transactionsAfterCommits = await getAllTransactions();
    expect(transactionsAfterCommits).toHaveLength(4);
    expect(
      transactionsAfterCommits.find(
        transaction => transaction.imported_id === 'preview-added-id',
      ),
    ).toMatchObject({ imported_id: 'preview-added-id', amount: -4_567 });
    expect(
      transactionsAfterCommits.find(
        transaction => transaction.id === 'preview-update-target',
      ),
    ).toMatchObject({ id: 'preview-update-target', cleared: 1, reconciled: 0 });
    expect(
      transactionsAfterCommits.find(
        transaction => transaction.id === 'preview-ignored-target',
      ),
    ).toMatchObject({
      id: 'preview-ignored-target',
      cleared: 0,
      reconciled: 0,
    });
    expect(
      transactionsAfterCommits.find(
        transaction => transaction.id === 'preview-locked-target',
      ),
    ).toMatchObject({ id: 'preview-locked-target', cleared: 0, reconciled: 1 });
  });

  test('characterizes a manual top-level target preserving fields while acquiring a stable ID', async () => {
    const accountId = 'characterized-manual-account';
    await prepareLocalAccount(accountId);
    await db.insertCategoryGroup({
      id: 'characterized-category-group',
      name: 'Characterized categories',
    });
    const manualPayeeId = await db.insertPayee({ name: 'Manual payee' });
    const incomingPayeeId = await db.insertPayee({ name: 'Incoming payee' });
    const manualCategoryId = await db.insertCategory({
      name: 'Manual category',
      cat_group: 'characterized-category-group',
    });
    const incomingCategoryId = await db.insertCategory({
      name: 'Incoming category',
      cat_group: 'characterized-category-group',
    });
    await db.insertTransaction({
      id: 'manual-top-level-target',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      payee: manualPayeeId,
      category: manualCategoryId,
      notes: 'manual note',
      cleared: false,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -1_234,
        imported_id: 'manual-acquired-id',
        payee: incomingPayeeId,
        category: incomingCategoryId,
        notes: 'incoming note',
        cleared: true,
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['manual-top-level-target']);
    expect(await getAllTransactions()).toMatchObject([
      {
        id: 'manual-top-level-target',
        imported_id: 'manual-acquired-id',
        amount: -1_234,
        payee: manualPayeeId,
        category: manualCategoryId,
        notes: 'manual note',
        cleared: 1,
      },
    ]);
  });

  test('characterizes split-parent matching as preserving children while propagating cleared state', async () => {
    const accountId = 'characterized-split-account';
    await prepareLocalAccount(accountId);
    await db.insertCategoryGroup({
      id: 'characterized-category-group',
      name: 'Characterized categories',
    });
    const firstPayeeId = await db.insertPayee({
      name: 'Split child one payee',
    });
    const secondPayeeId = await db.insertPayee({
      name: 'Split child two payee',
    });
    const firstCategoryId = await db.insertCategory({
      name: 'Split child one category',
      cat_group: 'characterized-category-group',
    });
    const secondCategoryId = await db.insertCategory({
      name: 'Split child two category',
      cat_group: 'characterized-category-group',
    });
    await db.insertTransaction({
      id: 'split-parent-target',
      account: accountId,
      amount: -10_000,
      date: '2024-04-05',
      imported_id: 'split-parent-id',
      is_parent: true,
      cleared: false,
    });
    await db.insertTransaction({
      id: 'split-child-one',
      account: accountId,
      amount: -6_000,
      date: '2024-04-05',
      parent_id: 'split-parent-target',
      is_child: true,
      payee: firstPayeeId,
      category: firstCategoryId,
      notes: 'first child note',
      cleared: false,
    });
    await db.insertTransaction({
      id: 'split-child-two',
      account: accountId,
      amount: -4_000,
      date: '2024-04-05',
      parent_id: 'split-parent-target',
      is_child: true,
      payee: secondPayeeId,
      category: secondCategoryId,
      notes: 'second child note',
      cleared: false,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -9_999,
        imported_id: 'split-parent-id',
        cleared: true,
        subtransactions: [
          { amount: -9_999, notes: 'incoming replacement child' },
        ],
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([
      'split-parent-target',
      'split-child-one',
      'split-child-two',
    ]);
    const children = (await getAllTransactions()).filter(
      transaction => transaction.parent_id === 'split-parent-target',
    );
    expect(
      children.find(transaction => transaction.id === 'split-child-one'),
    ).toMatchObject({
      id: 'split-child-one',
      amount: -6_000,
      payee: firstPayeeId,
      category: firstCategoryId,
      notes: 'first child note',
      cleared: 1,
      date: 20240405,
    });
    expect(
      children.find(transaction => transaction.id === 'split-child-two'),
    ).toMatchObject({
      id: 'split-child-two',
      amount: -4_000,
      payee: secondPayeeId,
      category: secondCategoryId,
      notes: 'second child note',
      cleared: 1,
      date: 20240405,
    });
    expect(
      children.reduce((sum, transaction) => sum + transaction.amount, 0),
    ).toBe(-10_000);
  });

  test('characterizes current FIN-17 baseline: fuzzy matching can select a split child directly', async () => {
    const accountId = 'characterized-split-child-account';
    await prepareLocalAccount(accountId);
    const payeeId = await db.insertPayee({
      name: 'Split child baseline payee',
    });
    await db.insertTransaction({
      id: 'split-child-baseline-parent',
      account: accountId,
      amount: -10_000,
      date: '2024-04-05',
      is_parent: true,
      cleared: false,
    });
    await db.insertTransaction({
      id: 'split-child-baseline-target',
      account: accountId,
      amount: -5_000,
      date: '2024-04-05',
      parent_id: 'split-child-baseline-parent',
      is_child: true,
      payee: payeeId,
      cleared: false,
    });

    const result = await reconcileTransactions(accountId, [
      {
        date: '2024-04-05',
        amount: -5_000,
        payee: payeeId,
        cleared: true,
      },
    ]);

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(['split-child-baseline-target']);
    const splitChildBaselineTransactions = await getAllTransactions();
    expect(
      splitChildBaselineTransactions.find(
        transaction => transaction.id === 'split-child-baseline-parent',
      ),
    ).toMatchObject({ id: 'split-child-baseline-parent', cleared: 0 });
    expect(
      splitChildBaselineTransactions.find(
        transaction => transaction.id === 'split-child-baseline-target',
      ),
    ).toMatchObject({ id: 'split-child-baseline-target', cleared: 1 });
  });

  test('characterizes updateDates for a normal exact match and a split parent', async () => {
    const accountId = 'characterized-update-dates-account';
    await prepareLocalAccount(accountId);
    await db.insertTransaction({
      id: 'normal-date-target',
      account: accountId,
      amount: -1_234,
      date: '2024-04-05',
      imported_id: 'normal-date-id',
    });
    await db.insertTransaction({
      id: 'split-date-parent',
      account: accountId,
      amount: -2_000,
      date: '2024-04-05',
      imported_id: 'split-date-id',
      is_parent: true,
    });
    await db.insertTransaction({
      id: 'split-date-child',
      account: accountId,
      amount: -2_000,
      date: '2024-04-05',
      parent_id: 'split-date-parent',
      is_child: true,
    });

    const defaultResult = await reconcileTransactions(accountId, [
      {
        date: '2024-04-06',
        amount: -1_234,
        imported_id: 'normal-date-id',
      },
    ]);
    const updateResult = await reconcileTransactions(
      accountId,
      [
        {
          date: '2024-04-07',
          amount: -1_234,
          imported_id: 'normal-date-id',
        },
        {
          date: '2024-04-07',
          amount: -2_000,
          imported_id: 'split-date-id',
        },
      ],
      false,
      true,
      false,
      true,
      true,
    );

    expect(defaultResult.updated).toEqual([]);
    expect(updateResult.updated).toEqual([
      'normal-date-target',
      'split-date-parent',
      'split-date-child',
    ]);
    const transactionsWithUpdatedDates = await getAllTransactions();
    expect(
      transactionsWithUpdatedDates.find(
        transaction => transaction.id === 'normal-date-target',
      ),
    ).toMatchObject({ id: 'normal-date-target', date: 20240407 });
    expect(
      transactionsWithUpdatedDates.find(
        transaction => transaction.id === 'split-date-parent',
      ),
    ).toMatchObject({ id: 'split-date-parent', date: 20240407 });
    expect(
      transactionsWithUpdatedDates.find(
        transaction => transaction.id === 'split-date-child',
      ),
    ).toMatchObject({ id: 'split-date-child', date: 20240407 });
  });
});

describe('SimpleFin batch sync', () => {
  function mockSimpleFinTransactions(response) {
    vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token');
    handlers['/simplefin/transactions'] = () => response;
  }

  afterEach(() => {
    delete handlers['/simplefin/transactions'];
  });

  test('does not emit transaction CRDT messages when provider category appears later', async () => {
    const providerAccountId = 'sf-account-1';
    const acctId = await db.insertAccount({
      id: 'acct-1',
      account_id: providerAccountId,
      name: 'Account 1',
      account_sync_source: 'simpleFin',
    });

    const syncTransaction = category => {
      mockSimpleFinTransactions({
        [providerAccountId]: {
          transactions: {
            all: [
              {
                booked: true,
                ...(category ? { category } : {}),
                date: '2017-10-02',
                payeeName: 'Coffee Shop',
                transactionAmount: {
                  amount: '-12.34',
                },
                transactionId: 'provider-tx-1',
              },
            ],
            booked: [],
            pending: [],
          },
          balances: [],
          startingBalance: 0,
        },
        errors: {},
      });

      return accountsApp.handlers['simplefin-batch-sync']({ ids: [acctId] });
    };

    setSyncingMode('offline');
    try {
      const firstResult = await syncTransaction(null);
      expect(firstResult[0].res.errors).toHaveLength(0);
      expect(firstResult[0].res.newTransactions).toHaveLength(2);

      const { count: crdtMessageCount } = await db.first<{ count: number }>(
        'SELECT COUNT(*) as count FROM messages_crdt',
      );
      expect(crdtMessageCount).toBeGreaterThan(0);

      global.stepForwardInTime();
      const secondResult = await syncTransaction('provider-category');
      expect(secondResult[0].res.errors).toHaveLength(0);
      expect(secondResult[0].res.newTransactions).toHaveLength(0);
      expect(secondResult[0].res.matchedTransactions).toHaveLength(0);

      const secondSyncMessages = await db.all<db.DbCrdtMessage>(
        'SELECT * FROM messages_crdt WHERE id > ? ORDER BY id',
        [crdtMessageCount],
      );

      expect(secondSyncMessages).toHaveLength(3);
      expect(secondSyncMessages.map(message => message.dataset)).toEqual([
        'accounts',
        'accounts',
        'accounts',
      ]);
      expect(secondSyncMessages.map(message => message.column).sort()).toEqual([
        'balance_current',
        'bank_sync_status',
        'last_sync',
      ]);
      expect(
        secondSyncMessages.some(message => message.dataset === 'transactions'),
      ).toBe(false);

      const transactions = await getAllTransactions();
      const syncedTransaction = transactions.find(
        transaction => transaction.imported_id === 'provider-tx-1',
      );
      expect(syncedTransaction).toBeDefined();
      expect(syncedTransaction.category).toBeNull();
    } finally {
      setSyncingMode('disabled');
    }
  });

  test('characterizes configured SimpleFin sync matching a changed provider ID non-strictly', async () => {
    const providerAccountId = 'sf-changed-id-account';
    const accountId = await db.insertAccount({
      id: 'sf-changed-id-local-account',
      account_id: providerAccountId,
      name: 'Changed ID account',
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      id: `transfer-${accountId}`,
      name: '',
      transfer_acct: accountId,
    });

    const syncTransaction = transactionId => {
      mockSimpleFinTransactions({
        [providerAccountId]: {
          transactions: {
            all: [
              {
                booked: true,
                date: '2017-10-02',
                payeeName: 'Changed ID merchant',
                transactionAmount: { amount: '-12.34' },
                transactionId,
              },
            ],
            booked: [],
            pending: [],
          },
          balances: [],
          startingBalance: 0,
        },
        errors: {},
      });

      return accountsApp.handlers['simplefin-batch-sync']({
        ids: [accountId],
      });
    };

    setSyncingMode('offline');
    try {
      const firstResult = await syncTransaction('simplefin-original-id');
      const [firstTransaction] = (await getAllTransactions()).filter(
        transaction => transaction.imported_id === 'simplefin-original-id',
      );

      const secondResult = await syncTransaction('simplefin-changed-id');
      const matchedTransaction = secondResult[0].res.matchedTransactions;
      const importedTransactions = (await getAllTransactions()).filter(
        transaction => transaction.imported_id?.startsWith('simplefin-'),
      );

      expect(firstResult[0].res.errors).toHaveLength(0);
      expect(firstTransaction).toMatchObject({ amount: -1_234 });
      expect(secondResult[0].res.errors).toHaveLength(0);
      expect(secondResult[0].res.newTransactions).toEqual([]);
      expect(matchedTransaction).toEqual([firstTransaction.id]);
      expect(importedTransactions).toMatchObject([
        {
          id: firstTransaction.id,
          imported_id: 'simplefin-changed-id',
          amount: -1_234,
        },
      ]);
    } finally {
      setSyncingMode('disabled');
    }
  });

  test('returns ACCOUNT_MISSING error when an account is not in the response', async () => {
    const presentAccountId = 'sf-account-1';
    const missingAccountId = 'sf-account-2';

    // Mock SimpleFin response that only returns data for one of two accounts
    mockSimpleFinTransactions({
      [presentAccountId]: {
        transactions: { all: [], booked: [], pending: [] },
        balances: [],
        startingBalance: 0,
      },
      errors: {},
    });

    // Insert two accounts linked to SimpleFin
    const acct1Id = await db.insertAccount({
      id: 'acct-1',
      account_id: presentAccountId,
      name: 'Account 1',
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      id: 'transfer-' + acct1Id,
      name: '',
      transfer_acct: acct1Id,
    });

    const acct2Id = await db.insertAccount({
      id: 'acct-2',
      account_id: missingAccountId,
      name: 'Account 2',
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      id: 'transfer-' + acct2Id,
      name: '',
      transfer_acct: acct2Id,
    });

    const results = await simpleFinBatchSync([
      { id: 'acct-1', account_id: presentAccountId },
      { id: 'acct-2', account_id: missingAccountId },
    ]);

    // The present account should succeed (no error_code)
    const presentResult = results.find(r => r.accountId === 'acct-1');
    expect(presentResult).toBeDefined();
    expect(presentResult.res.error_code).toBeUndefined();

    // The missing account should have ACCOUNT_MISSING error
    const missingResult = results.find(r => r.accountId === 'acct-2');
    expect(missingResult).toBeDefined();
    expect(missingResult.res.error_code).toBe('ACCOUNT_MISSING');
    expect(missingResult.res.error_type).toBe('ACCOUNT_MISSING');
  });

  test('propagates ACCOUNT_MISSING error from SimpleFin response errors', async () => {
    const presentAccountId = 'sf-account-1';
    const missingAccountId = 'sf-account-2';

    // Mock SimpleFin response with error entry for missing account
    mockSimpleFinTransactions({
      [presentAccountId]: {
        transactions: { all: [], booked: [], pending: [] },
        balances: [],
        startingBalance: 0,
      },
      errors: {
        [missingAccountId]: [
          {
            error_type: 'ACCOUNT_MISSING',
            error_code: 'ACCOUNT_MISSING',
            reason: 'Account not found',
          },
        ],
      },
    });

    const acct1Id = await db.insertAccount({
      id: 'acct-1',
      account_id: presentAccountId,
      name: 'Account 1',
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      id: 'transfer-' + acct1Id,
      name: '',
      transfer_acct: acct1Id,
    });

    const acct2Id = await db.insertAccount({
      id: 'acct-2',
      account_id: missingAccountId,
      name: 'Account 2',
      account_sync_source: 'simpleFin',
    });
    await db.insertPayee({
      id: 'transfer-' + acct2Id,
      name: '',
      transfer_acct: acct2Id,
    });

    const results = await simpleFinBatchSync([
      { id: 'acct-1', account_id: presentAccountId },
      { id: 'acct-2', account_id: missingAccountId },
    ]);

    // The missing account should get the ACCOUNT_MISSING error from the errors map
    const missingResult = results.find(r => r.accountId === 'acct-2');
    expect(missingResult).toBeDefined();
    expect(missingResult.res.error_code).toBe('ACCOUNT_MISSING');
    expect(missingResult.res.error_type).toBe('ACCOUNT_MISSING');
  });
});
