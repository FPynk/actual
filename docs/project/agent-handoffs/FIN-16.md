# FIN-16 Handoff

- Agent/model: GPT-5.6 Terra
- Ticket: FIN-16 - Characterize existing import and reconciliation behavior
- Branch: `test/FIN-16-characterize-reconciliation`
- Start commit: `3260a2e84db196d67c208712c8e9a0489b7ca359`
- End commit: pending lead
- Pull request: pending lead

## Files changed

- `packages/loot-core/src/server/accounts/sync.test.ts`
- `packages/loot-core/src/server/transactions/import/parse-file.test.ts`
- `packages/loot-core/src/mocks/files/fin16-synthetic-stable-id.ofx`
- `docs/project/agent-handoffs/FIN-16.md`

## Tests added or made explicit

- Exact `(account, imported_id)` reruns update one known target and preserve
  amount, date, existing payee/category/note, and existing raw sync data while
  refreshing imported payee and promoting cleared.
- The same stable-ID text in two accounts remains account-scoped.
- Strict file/API changed IDs add a separate transaction.
- Strict reconciliation treats stable IDs as case-sensitive.
- The configured SimpleFin batch-sync handler keeps its current non-strict
  changed-ID fuzzy behavior and updates the original transaction ID.
- No-ID fuzzy matching does not attach an ID, and two same-day, same-amount,
  same-payee no-ID rows are both added.
- A matching ID promotes cleared from false to true and does not demote true to
  false.
- Reconciled exact targets are ignored without an update or addition.
- The real `isPreview` reconciliation API reports representative added,
  updated, ignored, and locked outcomes without durable mutation; the following
  commit returns the corresponding add/update/ignore target result.
- A manual top-level target acquires a stable ID while retaining its amount,
  payee, category, and note.
- Exact split-parent matching retains child membership, amounts, payees,
  categories, notes, and balanced sum while propagating cleared state.
- `characterizes current FIN-17 baseline: fuzzy matching can select a split
  child directly` documents the current behavior for FIN-17 to invert.
- `updateDates` is off by default and, when enabled, updates a normal exact
  target plus the selected split parent and child date.
- Deleted-row preference and both explicit overrides assert active/tombstoned
  view counts: excluded rows remain one active plus one tombstone; eligible
  rows become two active plus one tombstone.
- A purpose-built synthetic OFX fixture preserves its synthetic `FITID` into
  reconciliation unchanged.

## Validation

Passed after formatting:

```text
yarn workspace @actual-app/core vitest run src/server/accounts/sync.test.ts src/server/transactions/import/parse-file.test.ts
44 tests passed in 2 files
```

The worktree did not contain its own `node_modules`. A temporary local junction
to the existing sibling checkout dependency directory was used only to run the
focused commands; no dependency installation was performed.

## Assumptions and limitations

- Tests use synthetic account IDs, merchant names, provider IDs, and OFX mock
  data only. The stable-ID test uses the purpose-built
  `fin16-synthetic-stable-id.ofx` fixture, not a copied provider-like ID.
- No production behavior, schema, result type, handler shape, snapshot, fuzzy
  threshold, or broad fixture was changed.
- The deleted-row active count is `v_transactions_internal`; tombstoned count
  is the underlying `transactions` tombstone rows. This matches the observed
  configured reconciliation views.
- Equal-distance fuzzy candidate selection is intentionally not asserted.
- Generated transaction IDs are asserted only where they are returned by the
  current reconciliation call, never by fixed generated value.

## Follow-ups for FIN-17

- Filter split children from fuzzy eligibility. The named baseline test proves
  that a current no-ID fuzzy import can select and mutate a split child directly.
- Implement the contract's same-batch stable-ID collision, ambiguity, and
  identity-result behavior. FIN-16 intentionally adds no failing future tests
  for those unimplemented guarantees.
