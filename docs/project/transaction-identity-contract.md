# Native Transaction Identity and Reconciliation Contract

- Status: frozen design for FIN-15
- Applies to: native Actual imports and bank synchronization
- Implementation gates: FIN-16 characterization, then FIN-17 hardening

This contract fixes the initial transaction identity and reconciliation
semantics for the personal-finance project. It narrows existing Actual behavior
where ambiguity could change financial history, while preserving documented
upstream behavior that is required by current import and bank-sync paths.

The authoritative ledger remains Actual. This contract does not approve a
schema migration, a companion-owned identity, a fingerprint uniqueness rule, or
an automatic cross-source merge.

## Terms

| Term                       | Meaning                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Native identity            | The exact pair `(Actual account ID, imported_id)`                                           |
| Stable ID                  | A non-empty `imported_id` supplied by an import or bank provider                            |
| Identity group             | Incoming rows in one reconciliation call that have the same native identity                 |
| Exact existing row         | An Actual row whose account and `imported_id` equal the incoming native identity            |
| Ledger intent              | The normalized, rule-evaluated fields that can affect an Actual transaction                 |
| Normalized-identical group | An identity group whose rows have the same ledger intent                                    |
| Conflicting group          | An identity group with two or more different ledger intents                                 |
| Fuzzy evidence             | Similar account, amount, payee, or date data that is not native identity                    |
| Eligible target            | One unreconciled top-level transaction that the selected upstream path is allowed to update |
| Review                     | A non-mutating result that needs user or later companion evaluation                         |

`imported_id` comparison is exact and case-sensitive. It is not trimmed,
case-folded, Unicode-normalized, prefixed with a source, or inferred from a
fingerprint by this project. `null`, `undefined`, and the empty string mean that
the row has no native stable ID.

## Invariants

1. Actual account equality is a hard gate for every exact or fuzzy match.
2. A native stable ID is meaningful only inside one Actual account.
3. One reconciliation call may select an existing Actual row at most once.
4. A reconciled transaction is never changed by automatic reconciliation.
5. Cleared state may move from false to true and never from true to false.
6. A split child is not an independent automatic reconciliation target.
7. An identified incoming row cannot fuzzily match an existing row with a
   different stable ID in the strict file/API path.
8. A fingerprint or fuzzy score is evidence only and never creates durable
   identity or uniqueness.
9. Conflicting or ambiguous native identity fails closed for that identity
   group. It does not select a convenient first row.
10. Failure of one identity group does not prevent independent, valid groups in
    the same batch from being evaluated.
11. Two legitimate purchases may have identical dates, amounts, and merchants.
    Those fields alone never justify collapsing them.
12. Companion source namespaces do not strengthen native Actual identity.

## Incoming normalization boundary

Collision evaluation happens after the existing input normalizer and rules have
resolved the account, payee, category, imported payee, integer amount, and
split children, but before any existing-row lookup, payee creation, preview
mutation, or ledger mutation.

The identity group key is:

```text
account ID + U+0000 + exact non-empty imported_id
```

Rows without a stable ID do not enter an identity group and are never collapsed
by the FIN-17 guard.

### Ledger-intent projection

Two rows in an identity group are normalized-identical only when the following
explicit projection is equal:

```ts
type NativeImportLedgerIntent = {
  account: string;
  imported_id: string;
  date: string;
  amount: number;
  payee: string | null;
  category: string | null;
  notes: string | null;
  imported_payee: string | null;
  cleared: boolean;
  starting_balance_flag: boolean;
  forceUpcoming: boolean;
  schedule: string | null;
  transfer_id: string | null;
  tombstone: boolean;
  forceAddTransaction: boolean;
  subtransactions: Array<{
    account: string;
    amount: number;
    payee: string | null;
    category: string | null;
    notes: string | null;
    cleared: boolean;
    transfer_id: string | null;
  }> | null;
};
```

Missing optional scalar values are canonicalized to the null or boolean values
shown above. Split children remain in normalized input order because that order
affects the generated split rows. Object property order does not affect
equality.

Projection field names are the post-normalization native transaction field
names. Missing booleans canonicalize to false and other optional fields to
null. A missing amount canonicalizes to `0`, matching existing reconciliation
and storage behavior. An empty `subtransactions` array canonicalizes to `null`.

The following diagnostic or generated fields are not part of ledger-intent
equality:

- generated transaction, payee, and sort-order identifiers;
- `raw_synced_data`;
- transient rule errors;
- preview-only flags; and
- source payload ordering outside the normalized transaction list.

For a normalized-identical group, the lowest incoming index is the canonical
row. Its diagnostic payload is retained. Later group members are reported as
duplicates and are not matched, previewed as additions, or written. This
first-index rule makes the result deterministic without treating diagnostic
payload differences as financial conflicts.

`forceAddTransaction` does not bypass stable-ID safety. A forced row with a
stable ID still participates in collision and exact-existing-row checks. A
caller that deliberately wants a separate transaction must provide no stable ID
or a genuinely distinct stable ID.

## Required result shape

FIN-17 extends the reconciliation result with deterministic identity results:

```ts
type ReconcileIdentityResult =
  | {
      code: 'duplicate_incoming_identity';
      accountId: string;
      importedId: string;
      incomingIndexes: number[];
      canonicalIncomingIndex: number;
      existingTransactionIds: [];
    }
  | {
      code: 'conflicting_incoming_identity';
      accountId: string;
      importedId: string;
      incomingIndexes: number[];
      canonicalIncomingIndex: null;
      existingTransactionIds: [];
    }
  | {
      code: 'ambiguous_existing_identity';
      accountId: string;
      importedId: string;
      incomingIndexes: number[];
      canonicalIncomingIndex: number;
      existingTransactionIds: string[];
    };

type ReconcileTransactionsResult = {
  added: string[];
  updated: string[];
  updatedPreview: ReconcilePreviewResult[];
  identityResults: ReconcileIdentityResult[];
};
```

Rules for this result:

- Results are ordered by the lowest incoming index in each group.
- `incomingIndexes` and `existingTransactionIds` are ascending.
- Each account-plus-stable-ID group produces at most one identity result, so
  result ordering never needs a same-group code tie-breaker.
- `incomingIndexes` are zero-based positions in the original `transactions`
  argument. Normalizers retain that source index for every emitted row; rows
  skipped by normalization produce no identity result.
- A single incoming row with one or zero exact existing rows produces no
  identity result.
- A conflicting group produces one `conflicting_incoming_identity` result and
  no exact-existing lookup, mutation, or previewed add/update for any member.
- A normalized-identical group first selects its lowest-index canonical row and
  performs the exact-existing lookup for that identity. With zero or one exact
  existing row, it produces one `duplicate_incoming_identity` result containing
  every group index and continues only with the canonical row.
- More than one exact existing row takes precedence over
  `duplicate_incoming_identity`: the normalized-identical group produces only
  one `ambiguous_existing_identity` result containing every incoming index and
  every exact existing transaction ID. It performs no exact or fuzzy mutation
  for the incoming group or any of those existing rows.
- Preview and commit calls return the same identity results for the same
  starting state.
- The import API must pass `identityResults` through unchanged. When the
  existing import API returns a validation-error result before reconciliation,
  it includes `identityResults: []`; errors that the existing API throws remain
  thrown.

These codes are machine-readable. User-facing copy is English and must not
include raw provider payloads.

## Existing-row decision table

The table is evaluated after incoming collision handling.

| Incoming state      | Existing state                     | Path                         | Result                                                                                                                    |
| ------------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Stable ID           | No exact row                       | Strict file/API              | Continue to the existing strict fuzzy query; an existing row with a different stable ID is excluded                       |
| Stable ID           | No exact row                       | Current configured bank sync | Retain the upstream non-strict fuzzy behavior only as characterized by FIN-16; do not generalize it to companion identity |
| Stable ID           | Exactly one unreconciled exact row | Either                       | Exact match; apply only the field merge contract below                                                                    |
| Stable ID           | Exactly one reconciled exact row   | Either                       | No mutation and no duplicate add; return the existing ignored/locked preview result                                       |
| Stable ID           | More than one exact row            | Either                       | `ambiguous_existing_identity`; no exact or fuzzy fallback and no mutation                                                 |
| No stable ID        | Any                                | Either                       | Use the characterized upstream fuzzy path; never create permanent identity from the fuzzy result                          |
| Any                 | Candidate in a different account   | Either                       | Never match                                                                                                               |
| Different stable ID | Existing identified row            | Strict file/API              | Never fuzzy-match; add separately if no other eligible target exists                                                      |
| Different stable ID | Existing identified row            | Companion-assisted flow      | Review only; never infer continuity                                                                                       |

The current configured bank-sync path deliberately passes non-strict ID
checking because some supported providers change identifiers between pending
and posted observations. FIN-16 records that upstream behavior. The project
does not reclassify that heuristic as exact identity, expose it to new callers,
or use it for cross-source reconciliation. Companion-assisted changed-ID
continuity remains review-only until a separate provider-neutral design is
approved.

## Exact-match field merge

When exactly one unreconciled existing row has the native identity, the
existing Actual row remains authoritative for user-authored fields.

| Field                     | Required behavior                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `account`, transaction ID | Never change                                                                                  |
| `imported_id`             | Keep/set the exact incoming stable ID                                                         |
| `amount`                  | Preserve the existing amount in the initial contract                                          |
| `date`                    | Preserve unless the existing caller explicitly enables the characterized `updateDates` option |
| `payee`                   | Preserve an existing payee; otherwise use the normalized incoming payee                       |
| `category`                | Preserve an existing category; otherwise use the normalized incoming category                 |
| `notes`                   | Preserve existing non-empty notes; otherwise use normalized incoming notes                    |
| `imported_payee`          | Refresh from the normalized incoming value                                                    |
| `cleared`                 | Logical OR of existing and incoming values                                                    |
| `reconciled`              | Never changed by reconciliation                                                               |
| `raw_synced_data`         | Preserve the existing value when present; otherwise accept the incoming diagnostic value      |
| split children            | Preserve membership, amounts, categories, payees, and notes                                   |

If cleared state promotes on a split parent, the promotion is propagated to its
children. If the explicitly enabled date-update path changes a split parent's
date, the date is propagated to its children. No other incoming split shape
replaces an existing split during automatic reconciliation.

An amount change under the same stable ID is not silently adopted. FIN-16 must
record the current behavior, and a later amount-revision design is required
before Actual may mutate that financial value automatically.

## Pending, posted, cleared, and reconciled state

Actual's current public transaction model does not store the companion's
canonical `booking_status`. Native bank normalization maps a booked observation
to `cleared: true` and a pending observation to `cleared: false`.

For the same stable ID and one eligible existing row:

- pending then posted may promote `cleared` from false to true;
- posted then pending leaves `cleared` true;
- an exact rerun with the same state is idempotent;
- the existing amount and user-authored fields remain protected by the merge
  table;
- a reconciled row is locked even if the new observation is posted; and
- a changed stable ID is not same-ID promotion.

The companion may later store pending-to-posted observations under its own
source namespace, but that record does not authorize a native ledger merge.

## Manual and split targets

### Manual top-level transaction

An incoming identified row may use the existing strict fuzzy path to match one
unidentified manual top-level transaction when account, amount, date window,
and the characterized payee passes allow it. On that match:

- the incoming stable ID may be attached;
- existing payee, category, and notes win;
- cleared state may promote but not demote;
- amount remains unchanged;
- date changes only under the explicit `updateDates` option; and
- reconciled state blocks the match from mutating.

If more than one eligible manual row competes, existing upstream selection is
characterized in FIN-16 and remains fuzzy evidence. The project must not call it
permanent identity or enforce it with a unique constraint.

### Existing split parent

Only the top-level split parent may be selected. An exact or characterized
fuzzy match preserves all children and the balanced sum. Cleared/date
propagation follows the exact-match merge table. Incoming split children do not
replace existing children.

A split child must never be selected directly. FIN-16 includes an explicit
regression characterization; if current upstream behavior permits a child
selection, the hardening implementation must filter children before enabling
the project flow.

## Incoming batch decision table

| Scenario                                                 | Mutation for that identity group                  | Report                                                 |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| One stable-ID row                                        | Continue to existing-row decision                 | None unless existing identity is ambiguous             |
| Same stable ID, normalized-identical rows                | Evaluate the first row once                       | One `duplicate_incoming_identity` result               |
| Same stable ID, different ledger intent                  | None                                              | One `conflicting_incoming_identity` result             |
| Same stable ID, identical intent, one exact existing row | Update/ignore the existing row once               | Duplicate result plus normal preview                   |
| Same stable ID, more than one exact existing row         | None                                              | One `ambiguous_existing_identity` result               |
| Conflict group plus independent valid groups             | Conflict group does nothing; valid groups proceed | Ordered results for affected groups                    |
| Repeated rows with no stable ID                          | No collision collapse                             | Existing fuzzy/add behavior                            |
| Same date/amount/merchant, distinct stable IDs           | Treat as distinct identities in strict mode       | No collision result                                    |
| Same identity in different accounts                      | Treat as two account-scoped identities            | No cross-account match                                 |
| `forceAddTransaction` repeats a stable ID                | Do not bypass the guard                           | Duplicate, conflict, or ambiguity result as applicable |

The pre-scan is complete before any payee or transaction write. A conflicting
group therefore cannot leave a payee created solely for one of its discarded
rows.

## Deleted rows

FIN-15 does not change the existing `sync-reimport-deleted-{accountId}`
preference or its explicit call override:

- when deleted rows are eligible for matching, retain the characterized
  upstream behavior;
- when they are excluded, a new row may be imported; and
- collision and existing-ambiguity checks use the same selected view as the
  reconciliation call.

FIN-16 keeps the existing deleted-row tests and records the resulting active and
tombstoned row counts. FIN-17 must not weaken those cases.

## Source boundaries

The initial project has three deliberately different boundaries:

| Boundary                      | Identity rule                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Native file/API import        | Strict account plus stable ID; changed existing IDs are not fuzzy targets                                         |
| Existing configured bank sync | Upstream non-strict heuristic is retained only for existing callers and covered by characterization tests         |
| Companion observations        | Namespaced immutable observations may produce review candidates, but do not strengthen or replace native identity |

A statement ID and a bank-provider ID that happen to have the same text can
collide in native Actual because `imported_id` has no namespace. The companion
must not claim that this is a safe cross-source match. Users must import into
the intended account and review uncertain cross-source cases.

## `transaction_sources` migration gate

No `transaction_sources` table is approved by FIN-15. Native
`(account, imported_id)` remains the only Actual ledger identity.

A later lead-owned proposal may request the table only when all of these
conditions are satisfied:

1. FIN-16 and FIN-17 are complete and show a required workflow that cannot be
   represented safely by native identity plus companion observations.
2. The proposal defines the authoritative Actual-owned schema, partial unique
   constraint, foreign keys, tombstone behavior, and account consistency check.
3. It explains how existing `imported_id` values remain readable and writable
   during upgrade, rollback, sync, and mixed-version clients.
4. It defines whether and how source links synchronize through supported Actual
   mechanisms; companion-only linkage is not represented as ledger truth.
5. It includes a no-automatic-backfill default. Any backfill or merge is
   separately reviewed and reversible.
6. It proves reconciled rows cannot be changed indirectly.
7. It covers paired backup, restore, export, retention, and migration failure.
8. Independent financial-integrity and migration review approves the design.

Failure of any gate leaves the table deferred.

## Exact test ownership

### FIN-16 characterization

Primary file:
`packages/loot-core/src/server/accounts/sync.test.ts`.

FIN-16 adds or makes explicit tests for:

1. exact stable-ID rerun with one existing row;
2. account-scoped identity with the same ID in two accounts;
3. strict changed-ID rows remaining separate;
4. current configured bank-sync non-strict changed-ID behavior;
5. no-ID fuzzy matching without durable identity claims;
6. two legitimate same-day, same-amount, same-payee no-ID purchases;
7. pending-to-posted same-ID cleared promotion;
8. cleared monotonicity on posted-to-pending replay;
9. a reconciled exact row producing no mutation or duplicate add;
10. manual target field preservation;
11. split-parent child preservation and balanced sum;
12. direct split-child exclusion/characterization;
13. `updateDates` behavior for a normal row and split parent;
14. deleted-row preference and override behavior; and
15. preview/commit agreement for added, updated, ignored, and locked results.

Integration seams:

- `packages/loot-core/src/server/accounts/sync.test.ts` exercises a configured
  bank-sync download and asserts its non-strict changed-ID behavior.
- `packages/loot-core/src/server/accounts/app-bank-sync.test.ts` covers only
  handler/result forwarding if FIN-17 changes handler shapes.
- `packages/loot-core/src/server/transactions/import/parse-file.test.ts`
  confirms parsed stable IDs reach reconciliation unchanged.

FIN-16 changes no production semantics. If a required invariant currently
fails, the failing baseline is recorded and the assertion is added with the
smallest appropriate hardening ticket rather than being silently normalized
away.

### FIN-17 hardening

Primary implementation and test files:

- `packages/loot-core/src/server/accounts/sync.ts`;
- `packages/loot-core/src/server/accounts/sync.test.ts`; and
- `packages/loot-core/src/server/accounts/app.ts` only as needed to pass
  `identityResults` through the import API.

FIN-17 regression tests must first fail against the characterized baseline and
then pass for:

1. two normalized-identical rows in one batch;
2. three normalized-identical rows with deterministic canonical index;
3. a normalized-identical incoming group with more than one exact existing row
   returning only `ambiguous_existing_identity`, with all incoming and existing
   IDs in deterministic order;
4. same ID with different amount;
5. same ID with different date;
6. same ID with different payee/category/notes;
7. same ID with a different split shape;
8. same ID with differing `forceAddTransaction`;
9. more than one exact existing row for a single incoming row;
10. a conflicting group beside a valid add group and a valid update group;
11. the same textual ID in two accounts;
12. repeated no-ID legitimate purchases;
13. preview and commit returning identical ordered identity results;
14. no payee created solely for a quarantined group, including when a
    `payee_name` rule would otherwise create a new payee;
15. a reconciled exact match staying locked; and
16. existing deleted-row and bank-sync behavior remaining green.

Every case asserts transaction counts, added and updated IDs, identity result
codes and ordering, protected fields, cleared/reconciled state, and idempotent
rerun.

## Approval boundaries

FIN-15 approves only this contract and its test plan. It does not approve:

- direct companion writes to Actual;
- cross-source exact identity;
- an Actual schema migration;
- fingerprint uniqueness;
- automatic changed-ID companion merges;
- replacement of existing split children;
- automatic mutation of reconciled history; or
- a generic reconciliation endpoint.

FIN-16 may characterize but not widen these boundaries. FIN-17 may implement
the collision, ambiguity, result-shape, and directly required target-safety
guards described here. Any broader financial mutation requires a new
lead-reviewed contract.
