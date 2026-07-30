# Personal Finance App data model

## Status and scope

This document defines the minimum data model implied by
`docs/project/architecture.md`. It distinguishes:

- existing Actual entities that remain authoritative;
- companion entities approved for derived/review metadata; and
- a gated Actual provenance model that is explicitly not approved for
  implementation without a separate migration design.

Deleting the companion database never deletes or rewrites an Actual
transaction. Before any ledger-write capability is enabled, the database is
fully disposable. After ledger writes are enabled, issued intents, application
receipts, allocation holds/reservations, and unresolved write quarantines
become durable safety metadata: loss or an unpaired restore forces the
companion into read-only recovery mode. No companion table is an accounting
ledger.

## Modeling rules

1. Money is an integer in the smallest currency unit.
2. Dates are ISO `YYYY-MM-DD`; timestamps are UTC ISO-8601.
3. Actual IDs are opaque strings and are never derived or reformatted.
4. Statement transaction source IDs are unique only inside an explicit source
   namespace and Actual account.
5. A transaction fingerprint is non-unique evidence.
6. Date, amount, and merchant never form a permanent unique constraint.
7. Raw secrets are not database fields.
8. Raw email bodies and source archives are transient by default.
9. Source observations are immutable; canonical source state and review
   decisions change only through explicit transitions.
10. A target-version hash invalidates a stale decision. It becomes a
    compare-and-set guard only when the server-owned conditional mutator
    validates it inside the ledger mutation.
11. All destructive companion cleanup is scoped by a verified entity ID or
    project-local data directory.
12. Every schema change is versioned and tested against upgrade and backup
    restore.

## Reused Actual entities

| Requirement concept             | Existing Actual entity                 | Decision                                                   |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Financial account               | `AccountEntity`                        | Reuse; companion stores only opaque account ID references  |
| Ledger transaction              | `TransactionEntity`                    | Reuse; Actual is authoritative                             |
| Stable imported identifier      | `TransactionEntity.imported_id`        | Reuse for initial hardening; keep account-scoped semantics |
| Cleared and reconciled state    | Transaction fields                     | Reuse; reconciled remains an automatic-mutation lock       |
| Merchant                        | Payee plus `imported_payee`            | Reuse; do not create a second canonical merchant catalog   |
| Merchant alias rule             | Imported-payee rename rule             | Reuse after its tested write-capability gate               |
| Classification                  | Category plus rules                    | Reuse after the applicable write-capability gate           |
| Recurring ledger behavior       | `ScheduleEntity`                       | Reuse; companion candidates may link to a schedule         |
| Item/category allocation        | Split transaction                      | Reuse only after the conditional-mutator gate              |
| Arbitrary report selection      | Report options and AQL filters         | Reuse                                                      |
| Provider connection/credentials | Sync-server provider state and secrets | Reuse; companion never copies provider credentials         |

The first implementation tickets do not change these schemas.

## Companion schema

The proposed database is a project-local SQLite file managed by
`packages/finance-companion`. One database is bound to exactly one Actual
budget. A process that is configured for a different budget refuses to open
it. This avoids repeating a budget discriminator on every table while still
scoping every Actual ID and uniqueness constraint. Table names use
`snake_case`; application types use descriptive TypeScript names. All foreign
keys are enabled.

### Schema metadata

#### `schema_migrations`

| Column       | Type    | Constraint  | Purpose                              |
| ------------ | ------- | ----------- | ------------------------------------ |
| `version`    | integer | primary key | Monotonic migration number           |
| `name`       | text    | not null    | Human-readable migration name        |
| `applied_at` | text    | not null    | UTC timestamp                        |
| `checksum`   | text    | not null    | Detect changed historical migrations |

Historical migration files are immutable after merge.

#### `companion_instance`

One row binds the database to a budget; its binding fields are immutable.

| Column                        | Type    | Constraint                  | Purpose                                                |
| ----------------------------- | ------- | --------------------------- | ------------------------------------------------------ |
| `singleton_key`               | text    | primary key, value `main`   | Enforces one binding row                               |
| `instance_id`                 | text    | not null, unique            | Immutable lowercase canonical companion UUID           |
| `budget_key_hash`             | text    | not null, unique            | Non-reversible configured budget scope                 |
| `budget_currency_code`        | text    | not null                    | Verified single-budget ISO currency                    |
| `write_capability_state`      | text    | not null, enum              | `disabled`, `enabled`, or `recovery_required`          |
| `write_capability_generation` | integer | not null, safe, nonnegative | Durable value that must equal the authenticated anchor |
| `write_capability_event_hash` | text    | nullable                    | Null at generation zero; otherwise current chain hash  |
| `created_at`                  | text    | not null                    | UTC timestamp                                          |

`instance_id` is generated once during first initialization and is the
authoritative identity used by the Actual API-root and operation ownership
markers. The hash is derived from the configured Actual server and budget
identity with a versioned, domain-separated hash. It is not a credential.
Changing the instance identity or binding requires creating a different
companion database. A fresh database always starts with writes `disabled`. The
only supported write-era restore workflow sets `recovery_required` and may
re-enable writes only after verifying a paired Actual export/snapshot and the
complete receipt/hold/reservation chain plus any unresolved write quarantine. A
generation-zero companion-only restore remains write-disabled and reconstructs
a verified generation-zero anchor. Missing write-era metadata has no automatic
reset path in this design.

Schema checks require generation zero to have a null event hash and state
`disabled` or `recovery_required`; a positive generation requires a
64-character lowercase hexadecimal event hash and state `enabled` or
`recovery_required`.

The generation starts at zero with a null event hash and never decreases.
Generation zero requires no `write_capability_events` rows. Enabling the first
or a later versioned write capability requires maintenance, the companion queue
and lock, the remote fence, a verified paired backup, and the paired-restore
release gate. One SQLite transaction inserts the next event, increments
`write_capability_generation`, copies its hash into
`write_capability_event_hash`, and records the enabled state. The command then
advances the authenticated anchor to that exact generation/hash before any
write is exposed.

A crash may leave the database exactly one valid event ahead. Startup may
finish only that extension after authenticating the event's referenced paired
backup and recomputing its chain hash from the still-current anchor. An anchor
ahead of the database, a gap greater than one, a decrease, a missing/extra
event, or divergent event hash sets `recovery_required`. Every startup,
migration, backup, restore, integrity check, and pre-write check requires exact
database/anchor generation and event-hash equality.

#### `write_capability_events`

One immutable row records every approved capability transition.

| Column                        | Type    | Constraint                  | Purpose                                                   |
| ----------------------------- | ------- | --------------------------- | --------------------------------------------------------- |
| `generation`                  | integer | primary key, positive, safe | Contiguous capability generation                          |
| `previous_event_hash`         | text    | nullable                    | Null only for generation one                              |
| `capability_contract_id`      | text    | not null                    | Versioned, release-allowlisted capability gate            |
| `paired_backup_manifest_hash` | text    | not null                    | Authenticated published backup required before enablement |
| `event_hash`                  | text    | not null, unique            | Domain-separated chain hash                               |
| `enabled_at`                  | text    | not null                    | UTC timestamp                                             |

The event hash is lowercase hexadecimal for:

```text
SHA-256(
  UTF8("finance-companion/write-capability-event/v1") ||
  0x00 ||
  UTF8(
    RFC8785({
      generation,
      previousEventHash,
      capabilityContractId,
      pairedBackupManifestHash
    })
  )
)
```

`capability_contract_id` is compiled release metadata, never caller input.
Events are append-only and contiguous. Their final generation/hash must equal
the `companion_instance` row and authenticated anchor.

#### `local_principals`

The first release has one stable local owner principal. Browser sessions are
ephemeral authentication instances of this principal, not new principals.

| Column            | Type | Constraint  | Purpose                                      |
| ----------------- | ---- | ----------- | -------------------------------------------- |
| `id`              | text | primary key | Stable principal UUID used by receipts       |
| `credential_hash` | text | not null    | Slow password-hash of the out-of-band secret |
| `created_at`      | text | not null    | UTC timestamp                                |
| `rotated_at`      | text | nullable    | Last credential rotation                     |

The raw credential exists only in an environment variable or
permission-restricted file and is never placed in a URL, log, browser storage,
fixture, or database. Sessions are in memory, expire, and are invalidated on
restart.

### External integrity freshness anchor

Every instance maintains a small authenticated anchor outside the companion
`/data` volume and its ordinary database restore domain. A fresh instance starts
with the generation-zero anchor described below. Its
permission-restricted host path and MAC key are configured separately. The
anchor contains only:

- budget binding hash;
- anchor format version;
- write-capability generation and current event-chain hash;
- highest issued write-intent sequence and chain hash;
- highest applied receipt sequence and chain hash; and
- last verified paired-backup manifest hash.

Before the first Actual write call for a logical receipt, one companion
transaction persists the `applying` receipt, exact action, holds, and next
issued-intent sequence/hash. The service then atomically advances and verifies
the external anchor's issued chain. It must not call Actual until the database
and anchor agree. A retry after authoritative no-commit proof reuses and
reverifies the same receipt/intent hash; it never consumes another issued
sequence. A changed action requires a new receipt. After an applied receipt
transaction commits, the applied chain advances through the same protocol.

Because writes are serialized and another write cannot start during anchor
repair, startup may finish exactly one valid database-chain extension that is
ahead after a crash. If either anchor chain is ahead of the database, missing
after prior writes/intents, bound to another budget, or divergent, the instance
enters `recovery_required`. This detects a companion restore to before an
unresolved attempt even when the Actual call committed and its response was
lost. A new database cannot ignore an existing anchor. After its separate
release gate lands, only the paired restore command may roll a write-era anchor
back, after verifying the bound Actual export/snapshot and encrypted backup
manifest.

Backup uses a two-phase anchor transition. The authenticated pre-backup anchor
artifact, but never its MAC key, is copied into the encrypted backup set. The
finalized manifest binds that artifact's hash, companion backup hash, Actual
export/snapshot hashes, schema version, capability generation/event chain,
issued-intent/applied-receipt chains, and quarantine/account-operation
bindings. After that manifest and the backup set are encrypted and verified, the
live anchor atomically advances its
`last_verified_paired_backup_manifest_hash` to the manifest hash. The manifest
does not embed the resulting post-finalization anchor. Restore verifies the
pre-backup anchor and manifest and then deterministically reconstructs that one
anchor advance. The MAC key is a separate read-only secret and is never
captured with either the database or anchor mount.

### Source namespaces

#### `source_namespaces`

Represents an immutable user-selected provenance namespace, not a connector or
credential.

| Column         | Type | Constraint     | Purpose                                             |
| -------------- | ---- | -------------- | --------------------------------------------------- |
| `id`           | text | primary key    | Companion UUID                                      |
| `kind`         | text | not null, enum | `statement` or `amazon_profile` initially           |
| `namespace`    | text | not null       | Stable namespace inside this single-budget database |
| `display_name` | text | not null       | Sanitized human-readable label                      |
| `created_at`   | text | not null       | UTC timestamp                                       |

`namespace` is unique and immutable. A statement source record additionally
requires an Actual account ID on the receipt and normalized transaction. An
Amazon profile may span several payment accounts, so account scope is applied
when matching Actual charges rather than when normalizing the order.

The initial schema deliberately has no email-folder adapter, enabled flag, or
secret reference. Actual bank-provider connections are not copied here;
scheduled bank sync invokes Actual's existing configured provider. A future
companion-owned connector requires a separate security and schema design.

### Import receipts

#### `import_batches`

Records a companion-assisted source parse. It does not claim that Actual's
native import UI passed through the companion.

| Column                | Type    | Constraint           | Purpose                                               |
| --------------------- | ------- | -------------------- | ----------------------------------------------------- |
| `id`                  | text    | primary key          | Companion UUID                                        |
| `source_namespace_id` | text    | not null foreign key | Immutable source namespace                            |
| `actual_account_id`   | text    | nullable             | Required for statement imports; absent for Amazon     |
| `source_kind`         | text    | not null             | Adapter kind                                          |
| `content_sha256`      | text    | not null             | Idempotency hash of the original bytes                |
| `parser_name`         | text    | not null             | Versioned adapter name                                |
| `parser_version`      | integer | not null             | Parser schema/behavior version                        |
| `source_display_name` | text    | nullable             | Sanitized file label without local path               |
| `started_at`          | text    | not null             | UTC timestamp                                         |
| `completed_at`        | text    | nullable             | UTC timestamp                                         |
| `status`              | text    | not null, enum       | `parsing`, `parsed`, `applied`, `failed`, `discarded` |
| `row_count`           | integer | not null default 0   | Parsed records                                        |
| `accepted_count`      | integer | not null default 0   | Approved/applied records                              |
| `rejected_count`      | integer | not null default 0   | Rejected records                                      |
| `error_code`          | text    | nullable             | Redacted stable code                                  |

Constraints and indexes:

- an expression unique index on
  `(source_namespace_id, ifnull(actual_account_id, ''), content_sha256,
parser_name, parser_version)`;
- `actual_account_id` is required when `source_kind=statement` and must be null
  when `source_kind` is an Amazon enrichment input;
- retrying the same bytes and parser returns the existing receipt;
- a new parser version may intentionally reparse the same bytes;
- no original file path, archive, or mail body is stored; and
- `status=applied` requires `completed_at`.

Import persistence is resumable without retaining raw input:

1. Validate limits, stream a content hash, and insert or resolve the `parsing`
   receipt.
2. Parse the supplied bytes in memory.
3. In one SQLite transaction, upsert compatible canonical entities, append
   immutable observations, record counts, and transition the receipt to
   `parsed`.
4. Remove the raw bytes on success or failure.

A crash before step 3 leaves a `parsing` receipt with no normalized children.
A crash during step 3 rolls back all normalized rows. Resubmitting the same
bytes can resume that receipt; without resubmission it becomes a redacted
incomplete/failed receipt. A committed normalization transaction is replayed,
not applied again.

### Source transactions

#### `source_transactions`

Stores the canonical identity and latest accepted state for a
companion-assisted statement row. It is not an Actual transaction.

| Column                    | Type    | Constraint           | Purpose                                       |
| ------------------------- | ------- | -------------------- | --------------------------------------------- |
| `id`                      | text    | primary key          | Companion UUID                                |
| `source_namespace_id`     | text    | not null foreign key | Immutable statement namespace                 |
| `actual_account_id`       | text    | not null             | Opaque Actual account                         |
| `actual_transaction_id`   | text    | nullable             | Linked Actual row after an approved operation |
| `external_transaction_id` | text    | nullable             | Stable source ID when supplied                |
| `currency_code`           | text    | not null             | ISO currency verified against the budget      |
| `amount`                  | integer | not null             | Latest observed minor-unit amount             |
| `transaction_date`        | text    | not null             | Latest source transaction date                |
| `posted_date`             | text    | nullable             | Posted date if separately supplied            |
| `booking_status`          | text    | not null, enum       | `unknown`, `pending`, `posted`                |
| `imported_payee`          | text    | nullable             | Latest normalized source payee text           |
| `normalized_payee_key`    | text    | nullable             | Versioned comparison key, not canonical payee |
| `fingerprint_version`     | integer | not null             | Fingerprint algorithm version                 |
| `fingerprint`             | text    | not null             | Non-unique evidence hash                      |
| `state`                   | text    | not null, enum       | `unmatched`, `candidate`, `linked`, `ignored` |
| `first_observed_at`       | text    | not null             | First UTC observation                         |
| `last_observed_at`        | text    | not null             | Latest UTC observation                        |

Constraints and indexes:

- partial unique
  `(actual_account_id, source_namespace_id, external_transaction_id)` when an
  external ID is present;
- index `(actual_account_id, amount, transaction_date)`;
- index `fingerprint`;
- index `actual_transaction_id`;
- the fingerprint is never unique; and
- `state=linked` requires `actual_transaction_id`.

The source namespace protects only this companion registry. Native Actual
matching initially remains limited to `(account, imported_id)` and does not
gain cross-source identity from this table.

A row without an external transaction ID is created for one immutable
observation only. It is never upserted or automatically merged across batches;
its fingerprint can only produce review evidence.

#### `source_transaction_observations`

Every parsed occurrence is immutable evidence.

| Column                  | Type    | Constraint           | Purpose                                |
| ----------------------- | ------- | -------------------- | -------------------------------------- |
| `id`                    | text    | primary key          | Observation UUID                       |
| `source_transaction_id` | text    | not null foreign key | Canonical source identity              |
| `import_batch_id`       | text    | not null foreign key | Parse receipt                          |
| `source_row_index`      | integer | not null             | Deterministic occurrence in the batch  |
| `currency_code`         | text    | not null             | Observed ISO currency                  |
| `amount`                | integer | not null             | Observed minor-unit amount             |
| `transaction_date`      | text    | not null             | Observed transaction date              |
| `posted_date`           | text    | nullable             | Observed posted date                   |
| `booking_status`        | text    | not null, enum       | `unknown`, `pending`, `posted`         |
| `imported_payee`        | text    | nullable             | Observed normalized payee              |
| `source_payload_hash`   | text    | not null             | Provenance hash, never the raw payload |
| `observed_at`           | text    | not null             | UTC timestamp                          |

Unique `(import_batch_id, source_row_index)`.

An observation with the same stable external ID may promote canonical
`pending` to `posted`. It cannot demote `posted`, and incompatible amount,
currency, or account data invalidates candidates and requires review. A changed
external ID is a different source identity and is always review-only; the
companion does not infer continuity from a fingerprint. Linking or posting may
promote an eligible Actual transaction to cleared only through the future
conditional mutator, never demote cleared state, and never change a reconciled
transaction.

The initial project supports one Actual budget currency. Statement parsers must
produce an explicit currency or use an institution adapter whose fixed
currency is configured and tested. A value that differs from
`companion_instance.budget_currency_code` is rejected before candidate
generation.

### Reconciliation candidates

#### `reconciliation_candidates`

| Column                  | Type    | Constraint           | Purpose                                                  |
| ----------------------- | ------- | -------------------- | -------------------------------------------------------- |
| `id`                    | text    | primary key          | Companion UUID                                           |
| `source_transaction_id` | text    | not null foreign key | Incoming source evidence                                 |
| `actual_transaction_id` | text    | not null             | Candidate ledger row                                     |
| `actual_target_version` | text    | not null             | Hash of fields used when scoring                         |
| `score`                 | integer | not null, 0–100      | Ranking aid                                              |
| `reason_codes_json`     | text    | not null             | Versioned allowlisted reason codes                       |
| `matcher_version`       | integer | not null             | Reproducible algorithm version                           |
| `status`                | text    | not null, enum       | `pending`, `approved`, `rejected`, `stale`, `superseded` |
| `decision_note`         | text    | nullable             | Short user note, not source payload                      |
| `decided_at`            | text    | nullable             | UTC timestamp                                            |
| `created_at`            | text    | not null             | UTC timestamp                                            |

Constraints and indexes:

- unique `(source_transaction_id, actual_transaction_id, matcher_version)`;
- index `(status, score)`;
- `approved` or `rejected` requires `decided_at`;
- candidate creation rejects a reconciled Actual target;
- an approval with a changed target hash becomes `stale`; and
- no score alone authorizes mutation.

In the first release, approval records the user's decision and provides
instructions for completing the edit in Actual. It does not mutate the ledger.
Automatic application remains disabled until the conditional mutator described
under target-version hashing exists.

### Merchant normalization proposals

#### `merchant_normalization_proposals`

| Column                      | Type    | Constraint      | Purpose                                               |
| --------------------------- | ------- | --------------- | ----------------------------------------------------- |
| `id`                        | text    | primary key     | Companion UUID                                        |
| `imported_payee`            | text    | not null        | Source alias                                          |
| `normalized_imported_payee` | text    | not null        | Versioned comparison value                            |
| `proposed_actual_payee_id`  | text    | not null        | Existing canonical Actual payee                       |
| `evidence_count`            | integer | not null        | Supporting transactions                               |
| `confidence`                | integer | not null, 0–100 | Review ordering                                       |
| `reason_codes_json`         | text    | not null        | Explainable evidence                                  |
| `status`                    | text    | not null, enum  | `pending`, `approved`, `rejected`, `stale`, `applied` |
| `created_at`                | text    | not null        | UTC timestamp                                         |
| `decided_at`                | text    | nullable        | UTC timestamp                                         |

Constraints:

- unique pending proposal
  `(normalized_imported_payee, proposed_actual_payee_id)`;
- initial approval records a decision and guidance without changing Actual;
- a later write-capability gate may create or extend an Actual
  imported-payee rename rule and must verify that the payee still exists; and
- the proposal never becomes a second canonical merchant record.

### Classification reviews

#### `classification_reviews`

| Column                  | Type    | Constraint      | Purpose                                               |
| ----------------------- | ------- | --------------- | ----------------------------------------------------- |
| `id`                    | text    | primary key     | Companion UUID                                        |
| `actual_transaction_id` | text    | not null        | Target transaction                                    |
| `actual_target_version` | text    | not null        | Stale-write guard                                     |
| `proposed_category_id`  | text    | not null        | Existing Actual category                              |
| `proposed_action`       | text    | not null, enum  | `categorize_once` or `create_rule`                    |
| `confidence`            | integer | not null, 0–100 | Review ordering                                       |
| `reason_codes_json`     | text    | not null        | Explainable evidence                                  |
| `status`                | text    | not null, enum  | `pending`, `approved`, `rejected`, `stale`, `applied` |
| `created_at`            | text    | not null        | UTC timestamp                                         |
| `decided_at`            | text    | nullable        | UTC timestamp                                         |

Only explicit `create_rule` approval changes future behavior. A
`categorize_once` decision must not create or update a rule.

Candidate generation and any eventual direct transaction application both
reject a reconciled target. Rule creation may not be used as an indirect
retroactive edit of reconciled transactions; if the supported rule operation
would apply immediately to history, the companion records guidance only.

### Subscription candidates

#### `subscription_candidates`

| Column                             | Type    | Constraint         | Purpose                                                           |
| ---------------------------------- | ------- | ------------------ | ----------------------------------------------------------------- |
| `id`                               | text    | primary key        | Companion UUID                                                    |
| `actual_payee_id`                  | text    | not null           | Canonical Actual payee                                            |
| `actual_account_id`                | text    | nullable           | Account-specific candidate when needed                            |
| `signature`                        | text    | not null           | Payee/account/cadence detector signature                          |
| `detector_version`                 | integer | not null           | Reproducible algorithm                                            |
| `cadence`                          | text    | not null, enum     | `weekly`, `monthly`, `quarterly`, `annual`, `unknown`             |
| `cadence_interval`                 | integer | not null default 1 | Recurrence multiplier                                             |
| `occurrence_count`                 | integer | not null           | Eligible history count                                            |
| `first_date`                       | text    | not null           | First observation                                                 |
| `last_date`                        | text    | not null           | Last observation                                                  |
| `median_amount`                    | integer | not null           | Robust central amount                                             |
| `amount_variance_basis_points`     | integer | not null           | Integer variance measure                                          |
| `date_variance_days`               | integer | not null           | Billing-date dispersion                                           |
| `recent_price_change_basis_points` | integer | nullable           | Explainable price change                                          |
| `candidate_type`                   | text    | not null, enum     | `subscription`, `household_bill`, `financial_bill`, `unknown`     |
| `confidence`                       | integer | not null, 0–100    | Review ordering                                                   |
| `reason_codes_json`                | text    | not null           | Explainable evidence                                              |
| `status`                           | text    | not null, enum     | `pending`, `approved`, `rejected`, `deferred`, `stale`, `applied` |
| `actual_schedule_id`               | text    | nullable           | Linked/created schedule                                           |
| `evaluated_at`                     | text    | not null           | UTC timestamp                                                     |
| `decided_at`                       | text    | nullable           | UTC timestamp                                                     |

Constraints and indexes:

- unique `(signature, detector_version)`;
- index `(status, confidence)`;
- initial approval records a decision and guidance without changing Actual;
- a later schedule-write capability may link an existing Actual schedule or
  explicitly create one;
- a type is user-confirmed and is not inferred permanently from confidence; and
- transaction history is re-queried before application; and
- a candidate derived from a reconciled target may be reviewed but cannot
  authorize a companion-led transaction edit.

### Amazon normalized model

Amazon identifiers are source identifiers, not Actual transaction identifiers.
Amounts retain their source currency. A currency mismatch with the configured
Actual budget blocks application. Purchase totals are stored as positive source
magnitudes; refund magnitudes are also positive. Match allocations use Actual's
signed ledger convention.

#### `amazon_orders`

| Column                | Type    | Constraint           | Purpose                   |
| --------------------- | ------- | -------------------- | ------------------------- |
| `id`                  | text    | primary key          | Companion UUID            |
| `source_namespace_id` | text    | not null foreign key | Amazon profile namespace  |
| `marketplace`         | text    | not null             | Marketplace domain/region |
| `external_order_id`   | text    | not null             | Amazon order identifier   |
| `order_date`          | text    | not null             | Purchase date             |
| `currency_code`       | text    | not null             | ISO currency              |
| `item_subtotal`       | integer | not null             | Minor units               |
| `tax_total`           | integer | not null             | Minor units               |
| `shipping_total`      | integer | not null             | Minor units               |
| `discount_total`      | integer | not null             | Minor units               |
| `gift_card_total`     | integer | not null             | Minor units               |
| `refund_total`        | integer | not null             | Minor units               |
| `order_total`         | integer | not null             | Minor units               |
| `first_observed_at`   | text    | not null             | First UTC observation     |
| `last_observed_at`    | text    | not null             | Latest UTC observation    |

Unique `(source_namespace_id, marketplace, external_order_id)`.

#### `amazon_shipments`

| Column                 | Type    | Constraint           | Purpose                            |
| ---------------------- | ------- | -------------------- | ---------------------------------- |
| `id`                   | text    | primary key          | Companion UUID                     |
| `amazon_order_id`      | text    | not null foreign key | Parent order                       |
| `source_shipment_key`  | text    | not null             | Stable external or adapter key     |
| `external_shipment_id` | text    | nullable             | Original identifier when supplied  |
| `shipment_date`        | text    | nullable             | Ship date                          |
| `shipment_total`       | integer | nullable             | Charge-relevant shipment magnitude |

Unique `(amazon_order_id, source_shipment_key)`. When Amazon supplies no
shipment ID, the versioned adapter creates a stable occurrence key from
source-defined structure, never from date and total alone.

#### `amazon_items`

| Column               | Type    | Constraint           | Purpose                               |
| -------------------- | ------- | -------------------- | ------------------------------------- |
| `id`                 | text    | primary key          | Companion UUID                        |
| `amazon_order_id`    | text    | not null foreign key | Parent order                          |
| `amazon_shipment_id` | text    | nullable foreign key | Shipment when known                   |
| `source_item_key`    | text    | not null             | Stable external or adapter key        |
| `external_item_id`   | text    | nullable             | Original identifier when supplied     |
| `title`              | text    | not null             | Sensitive normalized item description |
| `quantity`           | integer | not null             | Positive quantity                     |
| `unit_amount`        | integer | not null             | Minor units                           |
| `tax_amount`         | integer | not null             | Minor units                           |
| `shipping_amount`    | integer | not null             | Minor units                           |
| `discount_amount`    | integer | not null             | Minor units                           |
| `refund_amount`      | integer | not null             | Minor units                           |

Unique `(amazon_order_id, source_item_key)`. The fallback occurrence key is
derived from source-defined line identity and occurrence order, not title and
amount alone.

An item title is retained only because it is the requested enrichment. It is
excluded from ordinary logs, error telemetry, and ticket/PR fixtures.

#### `amazon_refunds`

| Column               | Type    | Constraint           | Purpose                           |
| -------------------- | ------- | -------------------- | --------------------------------- |
| `id`                 | text    | primary key          | Companion UUID                    |
| `amazon_order_id`    | text    | not null foreign key | Parent order                      |
| `amazon_item_id`     | text    | nullable foreign key | Refunded item when known          |
| `source_refund_key`  | text    | not null             | Stable external or adapter key    |
| `external_refund_id` | text    | nullable             | Original identifier when supplied |
| `refund_date`        | text    | not null             | Refund date                       |
| `amount`             | integer | not null             | Positive refund magnitude         |

Unique `(amazon_order_id, source_refund_key)`.

#### `amazon_source_observations`

Preserves parser and input-channel provenance separately from canonical
entities.

| Column                | Type | Constraint           | Purpose                                      |
| --------------------- | ---- | -------------------- | -------------------------------------------- |
| `id`                  | text | primary key          | Observation UUID                             |
| `import_batch_id`     | text | not null foreign key | Parse receipt                                |
| `source_row_key`      | text | not null             | Stable row/record key inside the input       |
| `amazon_order_id`     | text | nullable foreign key | Observed order                               |
| `amazon_shipment_id`  | text | nullable foreign key | Observed shipment                            |
| `amazon_item_id`      | text | nullable foreign key | Observed item                                |
| `amazon_refund_id`    | text | nullable foreign key | Observed refund                              |
| `source_payload_hash` | text | not null             | Hash of normalized evidence, not raw content |
| `observed_at`         | text | not null             | UTC timestamp                                |

A check constraint requires exactly one Amazon entity foreign key. Unique
`(import_batch_id, source_row_key)`.

Export and email adapters for the same Amazon profile resolve compatible
source keys to the same canonical entity and append observations. A parser
version reparse may append observations but cannot duplicate canonical
children. Conflicting values for an immutable identity field, currency, or
parent relationship produce a review/error outcome and no silent overwrite.

### Amazon many-to-many charge matching

#### `amazon_charge_matches`

| Column              | Type    | Constraint      | Purpose                                                                    |
| ------------------- | ------- | --------------- | -------------------------------------------------------------------------- |
| `id`                | text    | primary key     | Candidate group                                                            |
| `matcher_version`   | integer | not null        | Reproducible algorithm                                                     |
| `currency_code`     | text    | not null        | Required common currency                                                   |
| `score`             | integer | not null, 0–100 | Review ordering                                                            |
| `reason_codes_json` | text    | not null        | Explainable evidence                                                       |
| `status`            | text    | not null, enum  | `pending`, `approved`, `rejected`, `stale`, `partially_applied`, `applied` |
| `created_at`        | text    | not null        | UTC timestamp                                                              |
| `decided_at`        | text    | nullable        | UTC timestamp                                                              |

#### `amazon_match_transactions`

| Column                   | Type    | Constraint                         | Purpose                                                  |
| ------------------------ | ------- | ---------------------------------- | -------------------------------------------------------- |
| `match_id`               | text    | foreign key, composite primary key | Candidate group                                          |
| `actual_transaction_id`  | text    | composite primary key              | Charge/refund transaction                                |
| `actual_target_version`  | text    | not null                           | Stale-write guard                                        |
| `allocated_amount`       | integer | not null                           | Portion explained by this match                          |
| `application_status`     | text    | not null, enum                     | `pending`, `applying`, `applied`, `stale`, or `conflict` |
| `application_receipt_id` | text    | nullable foreign key               | Per-parent application receipt                           |

Each Actual target must be unreconciled when the candidate is created and when
it is applied. A match group may explain several Actual parents, but one
application request and receipt can mutate only one parent/split graph. Group
status is `partially_applied` until every selected parent is applied; an error
on one parent does not make another parent's receipt ambiguous.

#### `amazon_transaction_item_allocations`

| Column                        | Type    | Constraint                         | Purpose                                      |
| ----------------------------- | ------- | ---------------------------------- | -------------------------------------------- |
| `match_id`                    | text    | foreign key, composite primary key | Candidate group                              |
| `actual_transaction_id`       | text    | composite primary key              | Actual parent charge/refund                  |
| `amazon_item_id`              | text    | foreign key, composite primary key | Canonical item                               |
| `component_kind`              | text    | composite primary key, enum        | `merchandise`, `tax`, `shipping`, `discount` |
| `allocated_amount`            | integer | not null                           | Signed amount assigned to this Actual parent |
| `proposed_actual_category_id` | text    | nullable                           | Suggested split category                     |

#### `amazon_transaction_refund_allocations`

| Column                        | Type    | Constraint                         | Purpose                                      |
| ----------------------------- | ------- | ---------------------------------- | -------------------------------------------- |
| `match_id`                    | text    | foreign key, composite primary key | Candidate group                              |
| `actual_transaction_id`       | text    | composite primary key              | Actual refund transaction                    |
| `amazon_refund_id`            | text    | foreign key, composite primary key | Canonical refund                             |
| `allocated_amount`            | integer | not null                           | Signed amount assigned to this Actual parent |
| `proposed_actual_category_id` | text    | nullable                           | Suggested split category                     |

#### `amazon_transaction_order_adjustments`

| Column                  | Type    | Constraint                         | Purpose                                       |
| ----------------------- | ------- | ---------------------------------- | --------------------------------------------- |
| `match_id`              | text    | foreign key, composite primary key | Candidate group                               |
| `actual_transaction_id` | text    | composite primary key              | Actual parent charge/refund                   |
| `amazon_order_id`       | text    | foreign key, composite primary key | Canonical order                               |
| `adjustment_kind`       | text    | composite primary key, enum        | `gift_card`, `tax`, `shipping`, or `rounding` |
| `allocated_amount`      | integer | not null                           | Explicit signed adjustment                    |

#### `amazon_applied_allocation_reservations`

Minimal non-sensitive tombstones survive normalized Amazon-data purges and
prevent a later re-import from applying the same capacity twice.

| Column                   | Type    | Constraint           | Purpose                                              |
| ------------------------ | ------- | -------------------- | ---------------------------------------------------- |
| `id`                     | text    | primary key          | Reservation UUID                                     |
| `source_identity_hash`   | text    | not null             | Versioned hash of namespace and canonical source key |
| `source_component_kind`  | text    | not null             | Item component, refund, or order adjustment          |
| `actual_transaction_id`  | text    | not null             | Applied Actual parent                                |
| `allocated_amount`       | integer | not null             | Signed amount reserved                               |
| `application_receipt_id` | text    | not null foreign key | Successful application evidence                      |
| `created_at`             | text    | not null             | UTC timestamp                                        |

Unique
`(source_identity_hash, source_component_kind, actual_transaction_id)`. A
receipt can own several distinct reservations, but the same source-component
edge cannot be applied to the same Actual parent twice. Capacity queries sum
all reservations for the source identity, not only allocations in the current
candidate.

#### `amazon_allocation_holds`

Before an Amazon mutation call, the companion persists the intended
reservation edges as holds in the same transaction as the `applying` receipt.
They prevent capacity reuse while the authoritative mutation outcome is
unknown.

| Column                   | Type    | Constraint                         | Purpose                                       |
| ------------------------ | ------- | ---------------------------------- | --------------------------------------------- |
| `application_receipt_id` | text    | foreign key, composite primary key | Unresolved one-parent receipt                 |
| `source_identity_hash`   | text    | composite primary key              | Versioned namespace/canonical-source-key hash |
| `source_component_kind`  | text    | composite primary key              | Item component, refund, or order adjustment   |
| `actual_transaction_id`  | text    | composite primary key              | Intended Actual parent                        |
| `allocated_amount`       | integer | not null                           | Signed amount held                            |
| `created_at`             | text    | not null                           | UTC timestamp                                 |

Capacity queries subtract both applied reservations and every hold whose
receipt is `applying` or `outcome_unknown`. A matching authoritative committed
outcome converts the holds to applied reservations in the receipt-finalization
transaction. A hold is released only after Actual definitively proves that no
mutation committed and the receipt enters a terminal no-commit state. Timeout,
lost response, current target state, or elapsed time cannot release it.

Candidate validation requires:

- signed item, refund, and order-adjustment allocations sum exactly to each
  included Actual parent amount;
- every source component allocation fits its normalized capacity after
  subtracting reservations from all applied match groups and unresolved holds;
- every Actual transaction capacity fits after prior applied groups;
- all rows use the same currency as the Actual budget;
- every Actual target is unreconciled at candidate creation and application;
- all Actual target-version hashes remain current; and
- approved split values sum exactly to the Actual parent transaction.

No approximate total can be applied. Rounding remainder is visible and must be
assigned explicitly. Pending candidates may overlap for review, but application
rechecks capacity for one Actual parent and writes that parent's holds in the
same companion transaction as the receipt. An existing reservation or an
`applying`/`outcome_unknown` hold blocks another application. Remaining parents
in the match group stay pending after a partial success.

The first Amazon release is read-only and creates no reservations. Application
is enabled only after the server-owned conditional mutator can apply one
balanced parent/split change atomically and reject stale or reconciled targets.

### Request replay

#### `request_replays`

Stores idempotency state for authenticated mutating companion endpoints that
do not yet own an Actual application receipt. Job execution remains in
`job_runs`; gated Actual writes move to `application_receipts`.

| Column               | Type    | Constraint           | Purpose                                                           |
| -------------------- | ------- | -------------------- | ----------------------------------------------------------------- |
| `id`                 | text    | primary key          | Companion UUID                                                    |
| `budget_key_hash`    | text    | not null             | Immutable single-budget scope                                     |
| `principal_id`       | text    | not null foreign key | Stable owner principal, never a session ID                        |
| `invocation_kind`    | text    | not null, enum       | `local_http`, `local_cli`, or `scheduler`                         |
| `operation_id`       | text    | not null             | Versioned endpoint or command identity                            |
| `idempotency_key`    | text    | not null             | Caller-provided duplicate request guard                           |
| `request_hash`       | text    | not null             | Exactly 64 lowercase hexadecimal characters                       |
| `status`             | text    | not null, enum       | `in_progress`, `completed`, `failed_retryable`, or `failed_final` |
| `attempt`            | integer | not null, minimum 1  | Same-row retry/takeover number                                    |
| `response_status`    | integer | nullable             | Allowlisted replay HTTP/result status                             |
| `response_json`      | text    | nullable             | Route-specific allowlisted replay response                        |
| `domain_record_kind` | text    | nullable             | Closed enum: `job_run`, `review_decision`, or `import_batch`      |
| `domain_record_id`   | text    | nullable             | Durable owning record when one was committed                      |
| `error_code`         | text    | nullable             | Redacted stable code                                              |
| `created_at`         | text    | not null             | UTC timestamp                                                     |
| `completed_at`       | text    | nullable             | UTC timestamp                                                     |
| `expires_at`         | text    | nullable             | Retention boundary for non-write endpoint replay                  |

Unique
`(budget_key_hash, principal_id, invocation_kind, operation_id,
idempotency_key)`. An exact completed replay returns the stored allowlisted
result. Reusing the key with another request hash is a conflict. Creation of a
replay row and its domain decision/job/import record is atomic. An
`in_progress` row is not guessed successful from current Actual state; startup
resolves the companion transaction first, and gated Actual writes use the
stronger application-receipt protocol.

Schema checks require domain kind and ID to be either both null or both
non-null. The state matrix is closed:

| Status             | Required                                               | Must be null                                     |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| `in_progress`      | attempt and optional paired domain reference           | response status/body, error code, completed time |
| `completed`        | response status/body and completed time                | error code                                       |
| `failed_retryable` | error code and completed time                          | response status/body                             |
| `failed_final`     | error code, allowlisted error JSON, and completed time | success response status                          |

The owning domain result and replay terminal state commit atomically.
`failed_retryable` can return to `in_progress` only through an atomic
compare-and-set that reuses the same replay and domain rows, clears terminal
fields, and increments `attempt`. A duplicate `failed_final` replays the stored
allowlisted error. An `in_progress` row is never taken over based only on age.
Its companion transaction boundary must be proven after restart; Actual writes
use application receipts instead.

Indexes cover `(status, created_at)` and `(expires_at)`. Completed non-write
replays are retained for 30 days unless their owning domain record requires a
longer suppression period. Rows associated with unresolved work are never
purged by age.

### Job runs and application receipts

#### `job_runs`

| Column               | Type    | Constraint     | Purpose                                                                                            |
| -------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `id`                 | text    | primary key    | Run UUID                                                                                           |
| `job_kind`           | text    | not null       | `bank_sync`, `subscription_scan`, `amazon_parse`, or approved job                                  |
| `budget_key_hash`    | text    | not null       | Non-reversible budget discriminator                                                                |
| `invocation_kind`    | text    | not null       | `scheduler`, `local_http`, or `local_cli`                                                          |
| `operation_id`       | text    | not null       | Versioned endpoint or command identity                                                             |
| `principal_id`       | text    | not null       | Stable local owner or scheduler principal                                                          |
| `idempotency_key`    | text    | not null       | Caller-provided duplicate invocation guard                                                         |
| `request_hash`       | text    | not null       | Canonical action and parameter fingerprint                                                         |
| `account_scope_hash` | text    | nullable       | Ordered linked-account scope once bank-sync enumeration commits                                    |
| `status`             | text    | not null, enum | `queued`, `running`, `succeeded`, `partial`, `failed`, `skipped`, `canceled`, or `outcome_unknown` |
| `attempt`            | integer | not null       | Retry number                                                                                       |
| `started_at`         | text    | nullable       | UTC timestamp                                                                                      |
| `completed_at`       | text    | nullable       | UTC timestamp                                                                                      |
| `error_code`         | text    | nullable       | Redacted stable code                                                                               |
| `summary_json`       | text    | not null       | Allowlisted per-account results/counts/durations only                                              |
| `resolution_code`    | text    | nullable       | Explicit unknown-outcome resolution, never inferred provider result                                |
| `resolved_at`        | text    | nullable       | UTC resolution timestamp                                                                           |

Unique
`(budget_key_hash, principal_id, invocation_kind, operation_id,
idempotency_key)`. The operation ID is the versioned HTTP endpoint or CLI job
contract and the request hash includes `job_kind`. A repeat with the same
request hash returns the stored allowlisted summary; the same key with a
different request hash is a conflict.

For bank sync, `account_scope_hash` is null only while linked-account
enumeration has not committed. It becomes the lowercase hash:

```text
SHA-256(
  UTF8("finance-companion/bank-sync-account-scope/v1") ||
  0x00 ||
  UTF8(RFC8785(orderedAccountIds))
)
```

The ordered IDs exactly match contiguous child ordinals and never change for
that run.

Current public Actual bank sync exposes no trustworthy added/updated counts, so
schema-v1 summaries store `transactionCounts: null`. If a bank-sync worker is
hard-killed or explicit final sync/shutdown is unproven after provider work
starts, its account-operation row and the parent run become `outcome_unknown`;
the child row binds the operation quarantine, and neither is automatically
retried or purged. The quarantine blocks companion-only backup and migration.
Explicit offline resolution performs and proves a fresh authoritative sync;
success changes the run to `failed`, keeps the per-account `outcome-unknown`
evidence, and records `authoritative-sync-completed-effects-unknown`. Any later
provider retry uses a new idempotency key.

#### `job_run_account_operations`

Bank-sync worker identity and account scope are normalized rather than hidden
inside `summary_json`.

| Column                     | Type    | Constraint                  | Purpose                                                                                 |
| -------------------------- | ------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `worker_operation_id`      | text    | primary key, canonical UUID | One dedicated adapter-worker invocation                                                 |
| `job_run_id`               | text    | not null foreign key        | Owning bank-sync run                                                                    |
| `account_id`               | text    | not null                    | Exact Actual account scope                                                              |
| `ordinal`                  | integer | not null, nonnegative       | Deterministic sequential order                                                          |
| `expected_quarantine_root` | text    | not null, unique            | Exact `bank-sync-<run UUID>-<worker-operation UUID>` leaf                               |
| `status`                   | text    | not null, enum              | `queued`, `running`, `succeeded`, `failed`, `skipped`, `canceled`, or `outcome_unknown` |
| `quarantine_bundle_hash`   | text    | nullable                    | Stable logical-name-independent canonical bundle hash after quarantine                  |
| `started_at`               | text    | nullable                    | UTC timestamp                                                                           |
| `completed_at`             | text    | nullable                    | UTC timestamp                                                                           |
| `resolution_code`          | text    | nullable                    | Explicit authoritative-sync/unknown-effects resolution                                  |
| `resolved_at`              | text    | nullable                    | UTC resolution timestamp                                                                |

Unique `(job_run_id, account_id)` and `(job_run_id, ordinal)`. For every
enumerated account, the companion creates this row with its canonical random
worker operation ID, exact account ID, ordinal, and derived expected quarantine
root before the worker starts. In that same transaction, the parent
`account_scope_hash` commits to the ordered account-ID list. The worker ownership
marker and IPC request must match the row.

A hard kill changes that account operation and the parent run to
`outcome_unknown`. Recovery accepts a quarantine only when its exact root name,
strict `operation-owner.json`, job-run ID, worker-operation ID, account ID, and
logical-name-independent `quarantine_bundle_hash` agree with this row and the
durable companion instance/budget binding. The marker's closed schema and
canonical bytes are frozen in the companion contract. The hash uses the
canonical `FCQTR001` bundle-byte formula there, never the backup artifact formula
that includes a positional archive name. A missing expected quarantine,
unregistered lookalike root, duplicate account/ordinal, or substituted bundle is
fail-closed. `job_runs.summary_json` is rebuilt only from these child rows.

One process-global queue serializes every use of the module-global Actual API,
not only jobs. A cross-process lock protects the companion-owned API data
directory root. Each operation runs in a dedicated worker. The worker acquires
the lock before initialization and, normally, calls `shutdown` before it exits;
the service releases the queue only after worker exit. The atomic local-filesystem
lock owner record carries PID, verified process-start identity, and a random
nonce. Stale recovery requires proof that the owner is absent. A hard deadline
terminates and joins the worker, quarantines its operation directory, and only
then reclaims the verified stale lock. A second participating companion is
refused.

The CLI and arbitrary raw API processes do not understand this lock, so
exclusive ownership of the directory is an operational invariant reinforced by
a companion ownership marker and configuration checks rather than claimed as
universal enforcement. Network filesystems are unsupported.

#### `application_receipts`

| Column                        | Type    | Constraint           | Purpose                                                                                  |
| ----------------------------- | ------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `id`                          | text    | primary key          | Receipt UUID                                                                             |
| `budget_key_hash`             | text    | not null             | Immutable single-budget scope                                                            |
| `principal_id`                | text    | not null foreign key | Stable local owner principal, not a session ID                                           |
| `endpoint`                    | text    | not null             | Versioned HTTP/command endpoint                                                          |
| `action_kind`                 | text    | not null             | Constrained operation name                                                               |
| `action_schema_version`       | integer | not null             | Canonical action/hash contract version                                                   |
| `idempotency_key`             | text    | not null             | Caller-provided replay key                                                               |
| `canonical_request_hash`      | text    | not null             | Canonical action payload fingerprint                                                     |
| `canonical_action_json`       | text    | nullable             | Exact allowlisted retry action while outcome is unresolved                               |
| `issued_sequence`             | integer | not null, unique     | Monotonic pre-call write-intent sequence                                                 |
| `previous_intent_hash`        | text    | nullable             | Prior issued-intent chain hash                                                           |
| `intent_hash`                 | text    | not null, unique     | Hash of immutable operation identity/action/holds and prior intent hash                  |
| `review_kind`                 | text    | not null             | Reconciliation, classification, subscription, or Amazon                                  |
| `review_id`                   | text    | not null             | Companion candidate ID                                                                   |
| `actual_target_kind`          | text    | not null, enum       | `transaction`, `rule`, or `schedule`                                                     |
| `actual_target_id`            | text    | not null             | Existing target ID or deterministic receipt-derived create ID                            |
| `before_version_hash`         | text    | not null             | Expected authoritative state                                                             |
| `expected_after_version_hash` | text    | not null             | Expected successful state                                                                |
| `observed_after_version_hash` | text    | nullable             | State returned or found during recovery                                                  |
| `actual_outcome_hash`         | text    | nullable unique      | Verified durable Actual-side operation-outcome hash                                      |
| `worker_quarantine_id`        | text    | nullable unique      | Opaque receipt-derived directory ID after an interrupted write worker                    |
| `status`                      | text    | not null, enum       | `applying`, `outcome_unknown`, `applied`, `conflict`, `failed_retryable`, `failed_final` |
| `response_status`             | integer | nullable             | Stored replay HTTP/result status                                                         |
| `response_json`               | text    | nullable             | Allowlisted replay result without sensitive payloads                                     |
| `applied_sequence`            | integer | nullable unique      | Monotonic successful-application sequence                                                |
| `previous_receipt_hash`       | text    | nullable             | Prior successful receipt-chain hash                                                      |
| `receipt_hash`                | text    | nullable unique      | Hash of immutable action/result/reservation evidence and prior hash                      |
| `error_code`                  | text    | nullable             | Redacted code                                                                            |
| `created_at`                  | text    | not null             | UTC timestamp                                                                            |
| `completed_at`                | text    | nullable             | UTC timestamp                                                                            |

Unique `(budget_key_hash, principal_id, endpoint, idempotency_key)`. Reusing a
key with another action or request hash returns a conflict and never replays a
different result.

The post-gate apply protocol is:

1. Validate one target and build a deterministic constrained action. The
   receipt ID determines any new split child, rule, or schedule IDs. A shared
   versioned canonicalizer derives the action-specific expected before and
   after hashes before mutation. An Amazon action always has target kind
   `transaction` and covers exactly one parent/split graph. A create-rule or
   create-schedule action hashes a versioned absent-target sentinel for its
   deterministic new target ID.
2. In one companion transaction, persist the immutable canonical action, action
   version/hash, both target hashes, an `applying` receipt, any Amazon allocation
   holds, and the next issued sequence/intent-chain hash.
3. Atomically advance the authenticated external anchor to that issued intent
   and verify it matches the database. A crash with the database exactly one
   valid intent ahead may finish this update on restart. Actual must not be
   called before both copies agree. Every later retry of this exact logical
   operation reverifies and reuses the same intent; it does not add an
   attempt-level chain entry.
4. Invoke exactly one server-owned conditional mutation with the receipt ID and
   canonical action hash. The server re-reads the target, re-derives both hashes
   and deterministic IDs, and rejects any mismatch before applying. In the same
   Actual transaction as a successful mutation, it records a durable operation
   outcome keyed by receipt ID and action hash.
5. Accept `committed` only from that matching durable Actual-side outcome.
   Persist the outcome hash and allowlisted result, convert holds to allocation
   reservations, advance the applied sequence/receipt chain, and mark the
   receipt `applied` in one companion transaction.
6. On restart, resolve every `applying` or `outcome_unknown` receipt before
   accepting another mutation. Reacquire the queue, lock, and approved remote
   fence, then query the authoritative outcome by receipt ID. A matching
   committed outcome finalizes the receipt. A definitive no-commit result may
   retry the identical idempotent operation under the already anchored intent
   or enter a terminal conflict. An unavailable, mismatched, or otherwise
   unprovable outcome becomes
   `outcome_unknown`; it retains its canonical action and holds and blocks the
   affected target/capacities.

Current target state is supporting validation evidence only. Neither a match to
the expected-after hash nor a match to the before hash proves the operation
outcome because another client can edit or exactly revert the transaction.
`conflict` is terminal only for pre-call validation failure or an authoritative
result that proves no mutation committed.

The write worker uses the receipt ID for its operation-directory identity. If
it is hard-killed, restart discovers the permission-restricted quarantine even
when the companion row was not updated and records its opaque ID. A quarantine
containing a possible local Actual commit is retained and included in paired
backup while the receipt is `applying`, `outcome_unknown`, or
`failed_retryable`. Recovery must inspect or preserve it under the queue, lock,
and remote fence until the outcome record is synchronized authoritatively or a
no-commit result is proven.

No multi-step companion compensation is treated as ledger atomicity.
Application stays disabled unless the core mutator proves all-or-nothing
behavior. Receipts do not store full before/after transaction payloads. Actual
remains the place to inspect the financial record.

A timeout, lost response, process termination, or other unknown post-call
outcome remains `applying` or becomes `outcome_unknown`; it is never changed to
retryable by elapsed time. `failed_retryable` is allowed only when the server
proves that no ledger mutation committed. `failed_final` likewise requires
authoritative no-commit proof plus a non-retryable validation, authorization,
or supported-operation failure.

`canonical_action_json` contains only the closed action schema, but it may
contain sensitive note/split text and receives the same encrypted-volume and
log-redaction protection as normalized Amazon detail. It is immutable and
required while a receipt is `applying`, `outcome_unknown`, or
`failed_retryable`. After a terminal `applied`, proven-no-commit `conflict`, or
`failed_final` result, it is removed while its versioned hash, deterministic
IDs, response, and receipt-chain evidence remain.

## Target-version hashing

A target-version hash detects a stale review. The client-provided hash is only
an echo of the reviewed state; the server re-reads the authoritative graph and
derives the hash itself. Before the conditional mutator exists, the hash can
invalidate companion guidance but cannot protect a read-then-write update.
After the gate, the server compares it inside the same serialized local
mutation.

The frozen algorithm is the full `CanonicalActualTransactionGraphV1`
projection in `finance-companion-v1-contract.md`: every transaction DTO field
is present, nullable fields are explicit nulls, booleans are explicit, children
are sorted by UTF-8 byte order of opaque ID, and duplicate child IDs are
rejected. `targetVersionHash` itself is not an input. No timestamp, action,
request, session, or review field is included. The stored value is exactly 64
lowercase hexadecimal characters:

```text
SHA-256(
  UTF8("finance-companion/actual-transaction-graph/v1") ||
  0x00 ||
  UTF8(RFC8785(canonicalGraph))
)
```

A hash is not a secret or identity, and it must not be used to infer that two
transactions are duplicates.

The hash and companion lock do not fence another synced Actual client. Phase
9 may enable ledger writes only after its design proves pre/post-sync and
remote-client conflict behavior or adds an approved distributed fence. If that
cannot be proven, `write_capability_state` stays `disabled`.

## Reason codes

Reasons are versioned allowlisted strings, not arbitrary source data. Examples:

- `EXACT_EXTERNAL_ID`
- `SAME_ACCOUNT`
- `SAME_INTEGER_AMOUNT`
- `PAYEE_ALIAS_MATCH`
- `DATE_DISTANCE_0_TO_2_DAYS`
- `PENDING_TO_POSTED`
- `MANUAL_TRANSACTION_CANDIDATE`
- `COMPETING_CANDIDATES`
- `RECONCILED_TARGET`
- `MONTHLY_CADENCE`
- `ANNUAL_CADENCE`
- `LOW_AMOUNT_VARIANCE`
- `PRICE_INCREASE`
- `AMAZON_TOTAL_EXACT`
- `AMAZON_GIFT_CARD_ALLOCATION`
- `AMAZON_PARTIAL_REFUND`

UI copy maps these codes to human language. Logs may include codes but not raw
merchant names, item titles, emails, or provider payloads.

## API transfer objects

Database rows are never returned directly. Review APIs expose:

- opaque review ID and kind;
- human-readable source label;
- redacted account/payee display values;
- integer amounts plus explicit currency;
- relevant dates;
- confidence/score and reason codes;
- candidate choices;
- status and stale flag; and
- allowed actions.

Approval input contains the review ID, selected candidate/action, echoed
target-version hash, idempotency key, session, and CSRF proof. The server
derives the principal, endpoint, budget scope, action, and canonical request
hash used for idempotency. Clients cannot supply an arbitrary Actual
transaction patch.

## Gated Actual mutation outcome

Phase 9 ledger writes require a durable operation outcome inside Actual's
authoritative mutation domain. This is a logical contract, not approval to add
a migration before P9.1. Its minimum information is:

| Field                 | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `operation_id`        | Companion receipt UUID and immutable operation identity                |
| `action_hash`         | Versioned canonical constrained-action hash                            |
| `target_kind`         | Transaction, rule, or schedule                                         |
| `target_id`           | Opaque Actual target ID                                                |
| `before_version_hash` | State accepted by the conditional operation                            |
| `after_version_hash`  | State committed by the operation                                       |
| `outcome_hash`        | Integrity hash returned to and retained by the companion               |
| `committed_at`        | Authoritative commit timestamp used only for audit and troubleshooting |

The committed outcome is inserted atomically with the Actual write. Replaying
the same operation ID and action hash returns that outcome without another
write; reusing the ID with a different hash is rejected. An absent outcome may
authorize an identical retry only if P9.1 proves that every committed operation
would have a durable, authoritative, synchronized record. Current target state
alone is never that proof.

P9.1 must define the Actual schema or equivalent server-owned persistence, AQL
or API lookup, sync behavior across clients, remote-write fence, retention,
backup/export, rollback, and compatibility with upstream. Outcomes cannot be
pruned while any paired companion receipt or write capability depends on them.
If the design cannot make the outcome authoritative across the supported
multi-client topology, every companion write capability remains disabled.

## Gated Actual provenance option

The existing `imported_id` cannot represent several source observations linked
to one Actual transaction. If Phase 3 tests prove that the companion registry
cannot satisfy required native-import and bank-sync reconciliation, a separate
lead-owned design may add an Actual table conceptually named
`transaction_sources`.

Potential minimum fields:

| Field                 | Purpose                             |
| --------------------- | ----------------------------------- |
| `id`                  | Source-link UUID                    |
| `transaction_id`      | Actual transaction foreign key      |
| `account_id`          | Denormalized hard gate/index        |
| `source_namespace`    | Provider/statement/legacy namespace |
| `external_id`         | Stable source identifier            |
| `booking_status`      | Pending/posted when known           |
| `observed_at`         | Source observation time             |
| `source_payload_hash` | Troubleshooting hash only           |

Potential partial unique constraint:

`(account_id, source_namespace, external_id)` where `external_id` is not null.

This would allow several source rows to point to one Actual transaction. It
would not make a fingerprint unique.

The migration gate requires:

- a written compatibility plan for `imported_id`;
- AQL/model/API changes;
- import and bank-provider writers;
- sync mutation semantics;
- a no-dedup backfill that labels existing identifiers `legacy` without
  inferring their source;
- database upgrade/backup/restore tests;
- rollback behavior after new source links exist;
- upstream issue/PR re-evaluation; and
- lead approval.

Until that gate passes, implementation agents must not add this table.

## Retention and deletion

Defaults are conservative and configurable:

| Data                                             | Default retention                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Uploaded export/archive or raw email body        | Parse in memory; remove immediately after success or failure       |
| Redacted failed-import receipt                   | 30 days                                                            |
| Completed request replays                        | 30 days unless an owning suppression/audit record lasts longer     |
| Job runs                                         | 30 days                                                            |
| Pending review candidates                        | Until decision or source invalidation                              |
| Rejected reconciliation/classification proposals | 180 days to prevent immediate reproposal                           |
| Subscription suppressions                        | Until user removes them or detector version is deliberately reset  |
| Amazon normalized detail and observations        | 365 days after the source entity's last observation                |
| Application receipts                             | Retain with companion backup for audit/idempotency                 |
| Unresolved Amazon allocation holds               | Until a durable authoritative outcome resolves the receipt         |
| Unresolved bank-sync quarantines                 | Until explicit unknown-effects resolution and verified backup      |
| Unresolved write-operation quarantines           | Until the associated receipt has an authoritative terminal outcome |
| Applied Amazon allocation reservations           | Retain as non-sensitive tombstones while the budget binding exists |

The purge job runs under the companion lock and one SQLite transaction. It
previews row counts and dependencies before deletion. A receipt in `applying`,
`outcome_unknown`, or `failed_retryable`, or an approved-but-unapplied
candidate, blocks purge of its action, target, source data, and allocation
holds. Rejected, stale, and unapproved dependent candidates may cascade with
their expired observations. For an applied match, the sensitive title and
normalized detail may expire, but the application receipt and hashed allocation
reservations remain. Re-import checks those tombstones before proposing or
applying another allocation.

Deleting normalized Amazon data never changes notes or splits already applied
in Actual; the UI must say so. A failed dependency or foreign-key check aborts
the entire purge. Deleting the entire write-enabled companion database also
removes these tombstones, so a replacement database starts with ledger writes
disabled and cannot silently resume application.

SQLite secure deletion is not treated as guaranteed media erasure. Host
full-disk or encrypted-volume protection is required for sensitive normalized
Amazon data and backups.

## Migration and rollback

Companion migrations:

1. Pause scheduling, stop accepting requests, and drain the operation queue.
2. Acquire the exclusive companion process/data-directory lock.
3. Inspect the authenticated write generation and anchor. If writes have never
   been enabled, generation is zero with zero/null issued and applied chains,
   and no receipt, write marker, or unresolved bank-sync/write quarantine
   exists, create a
   checkpoint-consistent companion-only backup using the SQLite online backup
   API or `VACUUM INTO`, checksum it, and verify it opens while the lock is held.
   Otherwise complete the full remotely fenced paired
   Actual/companion/anchor upgrade-backup protocol and verify its finalized
   manifest before continuing.

   The generation-zero anchor created for every fresh database is required
   integrity state, not write-era metadata by itself.

4. Start one SQLite transaction.
5. Validate the migration checksum/history.
6. Apply schema/data changes.
7. Run foreign-key and integrity checks.
8. Insert the `schema_migrations` row and commit in the same transaction.
9. Start the service, pass its health check, release the lock, and resume
   scheduling.

On failure, roll back the transaction and keep the prior application version.
If a migration is not backward compatible, a never-write-enabled instance may
restore its verified companion-only backup with the prior application. A
write-enabled instance remains fail-closed until the remotely fenced protocol
for paired restore lands; after that gate it may restore only the paired
Actual/companion/anchor set and prior images. A companion-only write-era
rollback is rejected and sets `recovery_required`. Down migrations are not the
default. Crash tests cover backup creation, pre-commit migration work,
post-commit startup, generation-zero restore, and the paired-mode fail-closed
gate. A raw copy of the SQLite main file while WAL writes can occur is not a
backup.

Actual mutations already applied through approved reviews are not rolled back
by restoring the companion database. User-visible rollback guidance must use
Actual's own transaction/rule/schedule editing or a separately tested
compensating action. A write-enabled restore becomes supported only after the
paired-restore gate, and then only with its paired Actual snapshot/export and
bound manifest. Any companion-only write-era, older, or mismatched restore
enters `recovery_required`.

## Data-model acceptance criteria

- Actual remains the sole ledger.
- Every new entity has one owner and purpose.
- No secret field exists.
- Raw source retention is minimized.
- Companion source identity is single-budget, account-scoped, and namespaced;
  native Actual identity remains `(account, imported_id)` initially.
- Fingerprints and fuzzy fields are non-unique.
- Reconciled and stale targets cannot be changed by a companion-led
  transaction action.
- Amazon many-to-many allocations balance exactly and reserve capacity across
  applied groups; unresolved outcomes retain capacity holds.
- Review decisions are auditable; mutation is constrained and idempotent only
  after the conditional-mutator gate passes.
- Every companion-initiated Actual write has a durable authoritative operation
  outcome before it can be enabled; current target state never substitutes for
  that outcome.
- Companion deletion cannot delete Actual data and disables later
  companion-led ledger writes.
- The optional Actual provenance table remains gated behind a separate design.
