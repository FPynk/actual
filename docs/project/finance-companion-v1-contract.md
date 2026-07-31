# Finance companion v1 implementation contract

## Status and authority

This document is the frozen implementation contract for FIN-9. It refines the
approved architecture, data model, and test strategy without replacing them.
If a later implementation discovers a contradiction, the implementation stops
and the lead updates this contract through a reviewed design change before code
continues.

Contract version 1 has these invariants:

- one companion instance is bound to one Actual server, budget, and ISO
  currency;
- Actual remains authoritative for accounts, transactions, payees, categories,
  rules, schedules, splits, provider state, and provider credentials;
- the companion never opens Actual SQLite or sync files directly;
- every Actual API use enters one process-global queue and one cross-process
  lock, then runs in a dedicated child process;
- the initial adapter is read-only except for supported account-scoped bank
  sync and the final Actual `sync` required by that operation;
- review decisions never mutate Actual before their separately gated Phase 9
  operation exists;
- the HTTP service binds only to `127.0.0.1` and authenticates a stable local
  owner principal;
- no generic AQL, transaction patch, rule patch, schedule patch, filesystem
  path, or process command crosses an HTTP or adapter DTO boundary; and
- missing, divergent, or rolled-back write-integrity state fails closed.

Remote binding, reverse-proxy trust, provider implementation, email mailbox
access, browser credential scraping, and a generic Actual mutation API are not
part of contract version 1.

## Package identity and scripts

The package is `packages/finance-companion` with package name
`@actual-app/finance-companion`. It is private and is discovered by the existing
`packages/*` workspace.

Its `package.json` exposes these scripts:

| Script             | Contract                                                                |
| ------------------ | ----------------------------------------------------------------------- |
| `build`            | Build the Node service, child worker, and same-origin static UI         |
| `typecheck`        | Type-check all service, worker, contract, UI, and test source           |
| `test`             | Run deterministic unit and component tests once                         |
| `test:db`          | Run migrations, constraints, backup, anchor, and recovery tests         |
| `test:adapter`     | Run isolated synthetic-budget adapter lifecycle tests                   |
| `test:e2e`         | Exercise the production service/UI build with synthetic data            |
| `start`            | Start the loopback service and static UI                                |
| `job:bank-sync`    | Run one idempotent scheduled bank-sync invocation and exit              |
| `db:migrate`       | Apply verified forward-only migrations while the service is stopped     |
| `owner:rotate`     | Rotate the local owner credential through a permission-restricted input |
| `backup:create`    | Create and verify an allowed companion-only or paired backup            |
| `backup:verify`    | Verify hashes, schema, binding, anchor, and manifest without restoring  |
| `backup:restore`   | Restore only while the service and scheduler are stopped                |
| `integrity:verify` | Verify database chains, external anchor, binding, and quarantines       |
| `smoke:container`  | Verify non-root image, volumes, health, and graceful shutdown           |

Root `yarn build`, `yarn typecheck`, and `yarn test` discover only the matching
`build`, `typecheck`, and `test` tasks through Lage. The specialized scripts are
explicit release gates. Every script accepts paths containing spaces and runs
from PowerShell and Git Bash. No script changes the current directory before
resolving its own package path.

Until the ticket that owns a specialized command is complete, its scaffold
must stop before reading credentials, opening a database, creating a directory,
starting a listener, or invoking the Actual adapter. It writes exactly one
single-line JSON object to standard error and exits with status `78`:

```ts
type FeatureNotImplementedCommandResult = Readonly<{
  ok: false;
  code: 'feature_not_implemented';
  message: 'This command is not implemented yet.';
  command:
    | 'test:db'
    | 'test:adapter'
    | 'test:e2e'
    | 'job:bank-sync'
    | 'db:migrate'
    | 'owner:rotate'
    | 'backup:create'
    | 'backup:verify'
    | 'backup:restore'
    | 'integrity:verify'
    | 'smoke:container';
}>;
```

The JSON contains no configuration value or local path. Specialized test
scripts may run their implemented test subset; they must not report a
not-yet-implemented release gate as passing. The scaffold mounts no placeholder
domain HTTP route. A route becomes public only with its owning implementation
ticket, authentication, authorization, validation, and tests.

## Frozen package map

No implementation ticket may invent another cross-layer entry point. A ticket
may add private files inside its owning directory while preserving these
boundaries.

```text
packages/finance-companion/
  package.json
  tsconfig.json
  vite.config.mts
  vitest.config.ts
  migrations/
    001-instance-and-principal.sql
    002-request-replay-and-job-runs.sql
    003-source-ingestion.sql
    004-review-candidates.sql
    005-amazon-enrichment.sql
    006-application-receipts.sql
  src/
    cli.ts
    config.ts
    contracts/
      adapter.ts
      api.ts
      backup.ts
      common.ts
      errors.ts
      reviews.ts
    actual/
      adapter-queue.ts
      adapter-worker-entry.ts
      adapter-worker-protocol.ts
      adapter.ts
      directory-owner.ts
      operation-lock.ts
      process-identity.ts
    database/
      backup.ts
      connection.ts
      migrate.ts
      restore.ts
      schema.ts
    integrity/
      anchor.ts
      canonical-hash.ts
      verify.ts
    security/
      credential.ts
      csrf.ts
      redaction.ts
      session-store.ts
    http/
      authentication.ts
      request-validation.ts
      routes.ts
      server.ts
    jobs/
      bank-sync.ts
    reviews/
      decisions.ts
      repository.ts
    service/
      create-service.ts
      health.ts
      shutdown.ts
    ui/
      App.tsx
      api-client.ts
      main.tsx
      routes/
    tests/
      fixtures/
      integration/
```

Ownership is:

- `contracts` contains serializable types and pure runtime validation only;
- `actual` is the only directory allowed to import `@actual-app/api`;
- `database` is the only directory allowed to open companion SQLite;
- `integrity` is the only directory allowed to read or replace the external
  anchor;
- `security` owns credentials, sessions, CSRF, and redaction;
- `http` translates the closed HTTP contract into service calls and contains no
  database or Actual queries;
- `jobs` coordinates existing service interfaces and contains no provider
  credential;
- `reviews` owns derived review decisions and never writes Actual directly;
- `service` composes dependencies and owns health/shutdown state; and
- `ui` imports `@actual-app/components` and public contract types, but no Node
  module.

The runtime may depend on public exports from `@actual-app/api`,
`@actual-app/components`, Express 5, `express-rate-limit`, `better-sqlite3`, and
the repository's existing Argon2 package. It may not import `@actual-app/core`
internal paths, sync-server internal paths, Electron modules, or generated
Actual database files. Adding another production dependency requires evidence
that the existing workspace dependencies cannot safely provide the behavior.

## Configuration contract

Configuration is loaded once before opening the database, listening on a
socket, or starting a child worker. Unknown `FINANCE_COMPANION_*` keys are
reported by name only and rejected, so a misspelled security setting cannot be
silently ignored.

| Key                                                        | Required                                                      | Validation and use                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `FINANCE_COMPANION_BIND_ADDRESS`                           | No; defaults to `127.0.0.1`                                   | The only accepted value is exactly `127.0.0.1`                                                                                        |
| `FINANCE_COMPANION_PORT`                                   | No; defaults to `4100`                                        | Integer `1024..65535`                                                                                                                 |
| `FINANCE_COMPANION_ORIGIN`                                 | No; derived from address and port                             | If supplied, must equal `http://127.0.0.1:<port>` exactly                                                                             |
| `FINANCE_COMPANION_DATA_DIR`                               | Yes                                                           | Companion SQLite and service-owned data; existing real directory, not a symlink/reparse point                                         |
| `FINANCE_COMPANION_ACTUAL_API_DIR`                         | Yes                                                           | Dedicated Actual API root; distinct from and not nested under any other configured root                                               |
| `FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH`                  | Yes                                                           | Anchor file outside the data and Actual API roots and their restore domain                                                            |
| `FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE`                 | Yes, except Windows development                               | POSIX 0400/0600 single-link file owned by the service identity containing at least 32 random bytes; never captured in a backup        |
| `FINANCE_COMPANION_INTEGRITY_MAC_KEY`                      | Windows development only; mutually exclusive with the file    | Exactly 32 random bytes as canonical unpadded base64url; removed from `process.env` after loading and never used in production/Ubuntu |
| `FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE`             | Required for backup create, verify, and restore               | Permission-restricted file containing exactly 32 random bytes; never captured in a backup                                             |
| `FINANCE_COMPANION_ACTUAL_SERVER_URL`                      | Yes                                                           | Absolute `http` or `https` URL; credentials and fragments rejected                                                                    |
| `FINANCE_COMPANION_ACTUAL_BUDGET_ID`                       | Yes                                                           | Non-empty opaque Actual budget identifier; logged only through its domain-separated hash                                              |
| `FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`                 | Yes                                                           | Three uppercase ASCII letters; must match the opened budget                                                                           |
| `FINANCE_COMPANION_ACTUAL_PASSWORD_FILE`                   | Exactly one password source                                   | Preferred permission-restricted file; contents never stored in companion SQLite                                                       |
| `FINANCE_COMPANION_ACTUAL_PASSWORD`                        | Exactly one password source                                   | Development-only alternative; value is redacted and removed from `process.env` after loading                                          |
| `FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE` | Optional; mutually exclusive with the environment alternative | Preferred permission-restricted file for the budget's separate end-to-end encryption password                                         |
| `FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD`      | Optional development alternative                              | Removed from `process.env` after loading; absence means the configured budget must be unencrypted                                     |
| `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE`        | Required only before the first principal                      | Preferred permission-restricted file with 32 or more random bytes                                                                     |
| `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL`             | Development-only bootstrap alternative                        | Mutually exclusive with the file; removed from `process.env` after hashing                                                            |
| `FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS`                | No; defaults to `120000`                                      | Positive integer smaller than the hard deadline                                                                                       |
| `FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS`                | No; defaults to `180000`                                      | Positive integer; reaching it starts child termination                                                                                |
| `FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS`                 | No; defaults to `30000`                                       | Maximum time to prove child exit after termination                                                                                    |
| `FINANCE_COMPANION_LOG_LEVEL`                              | No; defaults to `info`                                        | `error`, `warn`, `info`, or `debug`; debug still uses the same allowlist                                                              |

The service does not accept a configuration key that enables review writes.
`write_capability_state` is durable database and anchor state changed only by a
future gated integrity command. The package never accepts provider credentials.

The Actual server password and budget end-to-end encryption password are
different credentials. A fresh adapter worker passes the optional budget
encryption password only to `downloadBudget(syncId, { password })` through the
one-time secret IPC message. It is never placed in child arguments, the
sanitized child environment, SQLite, the ownership marker, a backup, or a log.
An encrypted budget without the configured secret fails with
`actual_budget_encryption_password_required`; a supplied secret that cannot
decrypt the budget fails with `actual_budget_decryption_failed`. Neither failure
falls back to an unencrypted open.

Bootstrap credential file/environment values use the same unpadded base64url
encoding and 32–64 decoded-byte rule as owner rotation. A credential file
allows at most one terminal LF or CRLF; no other whitespace is trimmed. Secret
files must be permission-restricted regular files without a symlink/reparse
point. Because Node cannot prove the required Windows DACL and alternate-data-
stream contract, `FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE` fails closed on
Windows. Native Windows development may instead use the mutually exclusive
`FINANCE_COMPANION_INTEGRITY_MAC_KEY` direct source; production and Ubuntu
deployments require the file source.

All configured roots are resolved and compared using canonical existing parent
paths. The service rejects overlaps, directory symlinks/reparse points, a MAC
key inside a backup root, and a data or adapter root whose ownership marker is
bound to another companion instance.

## Stable binding and capability state

The budget binding hash is:

```text
SHA-256(
  UTF8("finance-companion/budget-binding/v1") ||
  0x00 ||
  UTF8(normalizedActualServerOrigin) ||
  0x00 ||
  UTF8(actualBudgetId)
)
```

The stored binding hash is exactly 64 lowercase hexadecimal characters.

The normalized origin lowercases the scheme and host, removes default ports,
requires an empty path or `/`, and contains no credential, query, or fragment.
The raw budget ID and server URL are never persisted in candidate tables or
ordinary logs.

At first initialization, one transaction creates:

- the `companion_instance` row with a newly generated immutable lowercase
  canonical instance UUID, binding hash, configured currency,
  `write_capability_state = disabled`, generation zero, and null capability
  event hash;
- one stable owner UUID in `local_principals`;
- an Argon2id hash of the bootstrap credential; and
- schema migration records with verified checksums.

The worker derives the opened budget's effective currency only from public
`getPreferences()` output. Actual returns flat `SyncedPrefs` keys. When
`preferences['flags.currency'] === 'true'`,
`preferences.defaultCurrencyCode` must be a supported three-letter uppercase
currency and is the effective value. Otherwise the effective currency is `USD`,
matching Actual's current fallback. The worker compares that value with
`FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`. A binding, invalid explicit
currency, or effective-currency mismatch closes the adapter and refuses service
startup. Changing server, budget, or currency requires a new data directory.

Capability states have these effects:

| State               | Actual reads | Account-scoped bank sync | Review writes | Migration/backup rule                                             |
| ------------------- | ------------ | ------------------------ | ------------- | ----------------------------------------------------------------- |
| `disabled`          | Allowed      | Allowed                  | Blocked       | Companion-only backup is allowed before migration                 |
| `enabled`           | Allowed      | Allowed                  | Gated only    | Every migration/rollback requires a remotely fenced paired backup |
| `recovery_required` | Allowed      | Blocked                  | Blocked       | Verification and, after its release gate, paired restore may run  |

“Gated only” means the operation-specific ticket, conditional Actual mutator,
durable Actual outcome, remote fence, receipt recovery, and all named tests are
complete. No route infers permission merely from the string `enabled`.

A generation-zero anchor is created for every fresh database and does not by
itself make the instance write-era. Companion-only migration/backup is allowed
only when database and anchor `writeCapabilityGeneration` are zero, both
capability event hashes are null, `write_capability_events` is empty, both
issued/applied sequences are zero with null hashes, no application receipt or
other write-era marker exists, and no unresolved bank-sync or write quarantine
exists. Any contrary evidence requires paired mode or `recovery_required`.

The transition from `disabled` to `enabled` is forbidden until paired backup
and the separately gated paired-restore protocol both pass their release tests.

## Schema-v1 migration ownership

`docs/project/data-model.md` remains authoritative for columns, constraints,
indexes, retention, and state transitions. Contract v1 freezes these migration
files and table owners:

| Migration | Tables                                                                                                                                                                                                                                                                                                                                                 | Implemented by       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `001`     | `schema_migrations`, `companion_instance`, `write_capability_events`, `local_principals`                                                                                                                                                                                                                                                               | FIN-11               |
| `002`     | `request_replays`, `job_runs`, `job_run_account_operations`                                                                                                                                                                                                                                                                                            | FIN-13/FIN-28        |
| `003`     | `source_namespaces`, `import_batches`, `source_transactions`, `source_transaction_observations`                                                                                                                                                                                                                                                        | FIN-18/FIN-19        |
| `004`     | `reconciliation_candidates`, `merchant_normalization_proposals`, `classification_reviews`, `subscription_candidates`                                                                                                                                                                                                                                   | FIN-20/FIN-23/FIN-34 |
| `005`     | `amazon_orders`, `amazon_shipments`, `amazon_items`, `amazon_refunds`, `amazon_source_observations`, `amazon_charge_matches`, `amazon_match_transactions`, `amazon_transaction_item_allocations`, `amazon_transaction_refund_allocations`, `amazon_transaction_order_adjustments`, `amazon_applied_allocation_reservations`, `amazon_allocation_holds` | FIN-38–FIN-40        |
| `006`     | `application_receipts`                                                                                                                                                                                                                                                                                                                                 | FIN-44               |

The filenames and logical table grouping are frozen; later owning tickets fill
their reviewed SQL before the migration is released. An unreleased migration
may be amended on its ticket branch. After a migration reaches
`integration/finance-app`, its bytes and checksum are immutable and corrections
use a new monotonically numbered migration.

The migration runner:

1. acquires the service queue and companion lock while no adapter child exists;
2. verifies every already-applied name/checksum pair;
3. refuses a database newer than the executable;
4. creates the required backup for the current write era;
5. enables SQLite foreign keys and uses an immediate transaction per migration;
6. records the migration only in the same transaction as its schema change;
7. runs `foreign_key_check`, `integrity_check`, binding, and anchor verification;
8. deletes no backup automatically; and
9. never performs a down migration.

## External integrity anchor

The anchor is an authenticated JSON envelope:

```ts
export type IntegrityAnchorV1 = Readonly<{
  formatVersion: 1;
  budgetKeyHash: string;
  writeCapabilityGeneration: number;
  writeCapabilityEventHash: string | null;
  highestIssuedIntentSequence: number;
  highestIssuedIntentHash: string | null;
  highestAppliedReceiptSequence: number;
  highestAppliedReceiptHash: string | null;
  lastVerifiedPairedBackupManifestHash: string | null;
}>;

export type AuthenticatedIntegrityAnchorV1 = Readonly<{
  payload: IntegrityAnchorV1;
  mac: Readonly<{
    algorithm: 'hmac-sha256';
    keyId: string;
    value: string;
  }>;
}>;
```

The MAC input is
`UTF8("finance-companion/integrity-anchor/v1") || 0x00 ||
UTF8(RFC8785(payload))`. The stored MAC is exactly 64 lowercase hexadecimal
characters. `keyId` is the first 16 lowercase hexadecimal characters of
`SHA-256(UTF8("finance-companion/integrity-key-id/v1") || 0x00 || keyBytes)`
and is not secret. The MAC key is never stored beside the anchor.

An update writes a permission-restricted temporary sibling, flushes it, closes
it, atomically replaces the anchor, and flushes the containing directory where
the platform supports that operation. Startup verifies the envelope before any
adapter operation. A missing generation-zero anchor may be initialized only
for a new database that has never enabled writes and has no pre-existing anchor
path. Any anchor ahead of, divergent from, or bound differently than durable
database state sets `recovery_required`.

`writeCapabilityGeneration` and `writeCapabilityEventHash` must equal
`companion_instance.write_capability_generation` and
`write_capability_event_hash`. The immutable
`write_capability_events` chain and hash formula are defined in
`data-model.md`. A database exactly one valid event ahead may be completed only
after the referenced paired manifest authenticates, the event chains from the
current anchor, and all enablement gates are rechecked. Every other mismatch
fails closed. The generation and event hash never decrease.

The issued-intent and applied-receipt protocols are exactly those in
`data-model.md`: one intent per logical receipt, exact retry reuse, no
attempt-level chain entry, and no Actual call before database and anchor agree.

## Public primitive contracts

Serialized amounts are signed integer minor units and always carry one ISO
currency code. Dates are `YYYY-MM-DD`; timestamps are UTC RFC 3339 strings with
milliseconds. Runtime validators reject floats, unsafe integers, unknown
fields, invalid dates, and unsupported currencies.

```ts
export type Money = Readonly<{
  minorUnits: number;
  currencyCode: string;
}>;

export type PageRequest = Readonly<{
  cursor?: string;
  limit?: number;
}>;

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;

export type ProblemCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'host_rejected'
  | 'origin_rejected'
  | 'rate_limited'
  | 'not_found'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'idempotency_conflict'
  | 'operation_in_progress'
  | 'budget_binding_mismatch'
  | 'currency_mismatch'
  | 'actual_budget_encryption_password_required'
  | 'actual_budget_decryption_failed'
  | 'feature_not_implemented'
  | 'adapter_timeout'
  | 'adapter_unhealthy'
  | 'write_disabled'
  | 'recovery_required'
  | 'stale_review'
  | 'actual_conflict'
  | 'outcome_unknown'
  | 'internal_error';

export type ProblemDetails = Readonly<{
  code: ProblemCode;
  requestId: string;
  message: string;
  retryable: boolean;
}>;

export type PublicHealthResponse = Readonly<{
  status: 'healthy' | 'not-healthy';
  version: string;
}>;

export type CreateSessionRequest = Readonly<{
  credential: string;
}>;

export type CreateSessionResponse = Readonly<{
  csrfToken: string;
  expiresAt: string;
  principal: Readonly<{
    id: string;
    role: 'owner';
  }>;
}>;

export type JobRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'outcome_unknown';

export type AccountBankSyncOutcomeCode =
  | 'succeeded'
  | 'authentication-required'
  | 'rate-limited'
  | 'timed-out'
  | 'configuration-error'
  | 'provider-error'
  | 'final-sync-failed'
  | 'skipped'
  | 'canceled'
  | 'outcome-unknown';

export type JobRunSummary = Readonly<{
  id: string;
  kind: 'bank-sync';
  status: JobRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  accountResults: readonly Readonly<{
    accountId: string;
    outcomeCode: AccountBankSyncOutcomeCode;
    transactionCounts: null;
  }>[];
  retryable: boolean;
}>;

export type ReviewRejectionReason =
  | 'not-a-match'
  | 'incorrect-category'
  | 'not-recurring'
  | 'not-this-order'
  | 'other';

export type AmazonImportResponse = Readonly<{
  importBatchId: string;
  status: 'completed' | 'completed-with-conflicts' | 'failed';
  orderCount: number;
  shipmentCount: number;
  itemCount: number;
  refundCount: number;
  conflictCount: number;
}>;
```

`message` is selected from an allowlist and contains no exception text, path,
SQL, statement content, item title, account number, token, or credential.

The HTTP mapping is closed:

| Problem code                                 | HTTP | Retryable | Default English message                                   |
| -------------------------------------------- | ---: | --------- | --------------------------------------------------------- |
| `invalid_request`                            |  400 | no        | The request is invalid.                                   |
| `unauthenticated`                            |  401 | no        | Authentication is required.                               |
| `forbidden`                                  |  403 | no        | This operation is not allowed.                            |
| `host_rejected`                              |  400 | no        | The request host is not allowed.                          |
| `origin_rejected`                            |  403 | no        | The request origin is not allowed.                        |
| `rate_limited`                               |  429 | yes       | Too many requests. Try again later.                       |
| `not_found`                                  |  404 | no        | The requested resource was not found.                     |
| `payload_too_large`                          |  413 | no        | The request payload is too large.                         |
| `unsupported_media_type`                     |  415 | no        | The request media type is not supported.                  |
| `idempotency_conflict`                       |  409 | no        | The idempotency key was reused for a different request.   |
| `operation_in_progress`                      |  409 | yes       | The operation is already in progress.                     |
| `budget_binding_mismatch`                    |  409 | no        | The configured budget does not match this companion data. |
| `currency_mismatch`                          |  409 | no        | The configured budget currency does not match.            |
| `actual_budget_encryption_password_required` |  424 | no        | The Actual budget encryption password is required.        |
| `actual_budget_decryption_failed`            |  424 | no        | The Actual budget could not be decrypted.                 |
| `feature_not_implemented`                    |  501 | no        | This feature is not implemented yet.                      |
| `adapter_timeout`                            |  504 | yes       | The Actual operation timed out.                           |
| `adapter_unhealthy`                          |  503 | no        | The Actual adapter is unhealthy.                          |
| `write_disabled`                             |  409 | no        | Write capability is disabled.                             |
| `recovery_required`                          |  503 | no        | Integrity recovery is required.                           |
| `stale_review`                               |  409 | no        | The review is stale.                                      |
| `actual_conflict`                            |  409 | no        | Actual changed before this operation completed.           |
| `outcome_unknown`                            |  503 | no        | The operation outcome is unknown and requires review.     |
| `internal_error`                             |  500 | no        | The operation failed.                                     |

The scaffold does not mount placeholder routes, so an unimplemented route is
normally `not_found`. `feature_not_implemented` is used only by an explicitly
declared command or route whose contract exists but whose owner has not landed.

## Actual adapter contract

### Caller-visible requests

The only caller-visible operation union before Phase 9 is:

```ts
export type ActualAdapterRequest =
  | ReadBudgetSnapshotRequest
  | ReadActualTargetRequest
  | RunAccountBankSyncRequest;

export type ReadBudgetSnapshotRequest = Readonly<{
  kind: 'read-budget-snapshot';
  sections: readonly ('accounts' | 'payees' | 'categories')[];
  transactionRange?: Readonly<{
    startDate: string;
    endDateExclusive: string;
    accountIds?: readonly string[];
  }>;
}>;

export type ReadActualTargetRequest = Readonly<{
  kind: 'read-actual-target';
  target: Readonly<{ kind: 'transaction'; id: string }>;
}>;

export type RunAccountBankSyncRequest = Readonly<{
  kind: 'run-account-bank-sync';
  accountId: string;
}>;

export type ActualAccountV1 = Readonly<{
  id: string;
  name: string;
  offBudget: boolean;
  closed: boolean;
  syncSource:
    'goCardless' | 'simpleFin' | 'pluggyai' | 'enableBanking' | 'akahu' | null;
  lastSync: string | null;
  syncStatus:
    | 'ok'
    | 'pending'
    | 'sync-requested'
    | 'failed'
    | 'reauth-required'
    | 'attention-required'
    | 'rate-limit-exceeded'
    | 'timed-out'
    | 'account-missing'
    | null;
}>;

export type ActualPayeeV1 = Readonly<{
  id: string;
  name: string;
  transferAccountId: string | null;
}>;

export type ActualCategoryGroupV1 = Readonly<{
  id: string;
  name: string;
  isIncome: boolean;
  hidden: boolean;
}>;

export type ActualCategoryV1 = Readonly<{
  id: string;
  name: string;
  groupId: string;
  isIncome: boolean;
  hidden: boolean;
}>;

export type ActualTransactionV1 = Readonly<{
  id: string;
  accountId: string;
  parentId: string | null;
  transferId: string | null;
  date: string;
  amountMinorUnits: number;
  payeeId: string | null;
  categoryId: string | null;
  notes: string | null;
  importedId: string | null;
  importedPayee: string | null;
  cleared: boolean;
  reconciled: boolean;
  isParent: boolean;
  isChild: boolean;
  isStartingBalance: boolean;
  tombstone: boolean;
}>;

export type ActualBudgetSnapshotV1 = Readonly<{
  contractVersion: 1;
  budget: Readonly<{
    budgetKeyHash: string;
    currencyCode: string;
    capturedAt: string;
  }>;
  accounts?: readonly ActualAccountV1[];
  payees?: readonly ActualPayeeV1[];
  categoryGroups?: readonly ActualCategoryGroupV1[];
  categories?: readonly ActualCategoryV1[];
  transactions?: readonly ActualTransactionV1[];
}>;

export type ActualTransactionGraphV1 = Readonly<{
  contractVersion: 1;
  parent: ActualTransactionV1;
  children: readonly ActualTransactionV1[];
  targetVersionHash: string;
}>;

export type AccountBankSyncResultV1 = Readonly<{
  contractVersion: 1;
  accountId: string;
  startedAt: string;
  completedAt: string;
  outcomeCode: AccountBankSyncOutcomeCode;
  transactionCounts: null;
  finalSyncCode: 'succeeded' | 'failed' | 'not-attempted' | 'outcome-unknown';
}>;

export type ActualAdapterResponse =
  | Readonly<{
      kind: 'read-budget-snapshot';
      snapshot: ActualBudgetSnapshotV1;
    }>
  | Readonly<{
      kind: 'read-actual-target';
      target: ActualTransactionGraphV1;
    }>
  | Readonly<{
      kind: 'run-account-bank-sync';
      result: AccountBankSyncResultV1;
    }>;
```

`targetVersionHash` is exactly 64 lowercase hexadecimal characters. The worker
first projects every transaction to all fields of `ActualTransactionV1`,
writing every nullable field as explicit `null` and every boolean explicitly.
It sorts children by UTF-8 byte order of `id`, rejects duplicate child IDs, and
canonicalizes this object:

```ts
type CanonicalActualTransactionGraphV1 = Readonly<{
  contractVersion: 1;
  parent: ActualTransactionV1;
  children: readonly ActualTransactionV1[];
}>;
```

The hash is:

```text
SHA-256(
  UTF8("finance-companion/actual-transaction-graph/v1") ||
  0x00 ||
  UTF8(RFC8785(canonicalGraph))
)
```

No timestamp, action, session, request ID, or companion review field enters the
hash. FIN-14 emits this evidence hash; the later server-owned conditional
mutator must recompute the identical algorithm inside its authoritative
compare-and-set boundary. Until that mutator exists, the hash authorizes no
write.

Transactions are requested only by the presence of `transactionRange`;
`sections` does not accept a `transactions` value. The half-open range must span
1-90 days. `accountIds`, when present, contains 1-100 unique non-empty IDs. A
snapshot may contain at most 10,000 transactions and its canonical serialized
IPC response may contain at most 16 MiB. The worker measures bytes before send;
the parent independently enforces the same IPC-frame cap before parsing.
Exceeding either result cap fails with `payload_too_large` and returns no partial
snapshot.

The adapter also rejects duplicate/unknown sections, an empty account ID, an
unsupported target kind, and any unknown property. It owns AQL construction;
callers cannot submit AQL, SQL, field lists, file paths, API method names, or
arbitrary JSON patches.

### Allowlisted result fields

The adapter converts Actual objects to companion-owned DTOs before worker IPC.
Only these fields may cross:

| DTO              | Fields                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget metadata  | binding hash, ISO currency, snapshot timestamp                                                                                                                 |
| Account          | ID, name, on/off-budget, closed, sync source, last sync, redacted sync status                                                                                  |
| Payee            | ID, name, transfer-account ID                                                                                                                                  |
| Category/group   | ID, name, group ID, income/hidden flags                                                                                                                        |
| Transaction      | ID, account/parent/transfer IDs, date, integer amount, payee/category IDs, notes, imported ID/payee, cleared/reconciled/split/starting-balance/tombstone flags |
| Target graph     | target plus required split children and the frozen canonical graph hash                                                                                        |
| Bank-sync result | account ID, started/completed timestamps, stable outcome code, explicit unavailable transaction counts, final sync code                                        |

Notes and merchant/item text are sensitive and are never logged. Raw provider
responses, credentials, account numbers, bank IDs, SQL errors, and Actual
working-directory paths never cross worker IPC.

Current public `runBankSync({ accountId })` returns no added/updated summary, and
the underlying handler does not expose its internal counts. Contract v1
therefore returns `transactionCounts: null`; it never derives counts from a
before/after query or maps success to `no-new-transactions`. Exposing counts
requires a separately reviewed sanitized public Actual API result and a new
contract version.

Rule and schedule reads are intentionally absent from this first adapter union.
FIN-22 and FIN-33 must add separately reviewed, closed read DTOs before their
implementation tickets need those objects. They may not widen this contract to
raw API responses or caller-supplied queries.

### Operation ownership marker

Every adapter operation directory contains exactly one root-level regular file
named `operation-owner.json`. Its bytes are exactly the UTF-8 encoding, without
a BOM, newline, or other trailing byte, of RFC 8785 canonical JSON for one
member of this closed union:

```ts
export type OperationOwnerMarkerV1 =
  | Readonly<{
      formatVersion: 1;
      companionInstanceId: string;
      budgetBindingHash: string;
      ownershipNonce: string;
      rootKind: 'read';
      rootName: string;
      workerOperationId: string;
    }>
  | Readonly<{
      formatVersion: 1;
      companionInstanceId: string;
      budgetBindingHash: string;
      ownershipNonce: string;
      rootKind: 'bank-sync';
      rootName: string;
      jobRunId: string;
      workerOperationId: string;
      accountId: string;
    }>
  | Readonly<{
      formatVersion: 1;
      companionInstanceId: string;
      budgetBindingHash: string;
      ownershipNonce: string;
      rootKind: 'write';
      rootName: string;
      receiptId: string;
      workerOperationId: string;
    }>;
```

`companionInstanceId`, every job, worker-operation, and receipt ID are lowercase
canonical UUIDs. `budgetBindingHash` is the configured 64-character lowercase
hash. `ownershipNonce` is an independently generated 32-byte
unpadded-base64url value. `accountId` is the exact non-empty Actual account ID.
The derived root names are exactly:

- `read-<worker-operation UUID>`;
- `bank-sync-<job UUID>-<worker-operation UUID>`; or
- `write-<receipt UUID>-<worker-operation UUID>`.

The parser rejects invalid UTF-8, duplicate JSON member names before object
construction, unknown or missing properties, the wrong primitive type, a
noncanonical serialization, any version other than `1`, an invalid identifier
or nonce, and a root name not exactly derived from the typed IDs. The marker is
created exclusively with restrictive permissions by the parent, then the file
and operation directory are flushed before the worker starts. The worker
strictly parses it and compares every field with its validated IPC request,
configured instance/budget binding, and parent-supplied nonce before opening
Actual.

### Worker lifecycle

`adapter-queue.ts` implements a dependency-free FIFO promise queue with
concurrency one. Every HTTP read, review refresh, import lookup, detector,
scheduled job, backup adapter call, and future write uses it.

For each dequeued request the parent:

1. creates an opaque worker-operation ID, independent ownership nonce, unique
   child directory under `<ACTUAL_API_DIR>/operations`, and its durable
   `operation-owner.json`;
2. forks `adapter-worker-entry.ts` with an IPC channel and an explicit minimal
   environment allowlist rather than inheriting the service environment, exact
   `stdio: ['ignore', 'ignore', 'ignore', 'ipc']`, and no shell; secrets pass
   through one one-time IPC message rather than command-line arguments;
3. waits for the child to acquire the directory lock and verify ownership;
4. sends one validated `ActualAdapterRequest`;
5. accepts one validated terminal result;
6. waits for the worker's `shutdown-complete` message and process exit; and
7. releases the queue slot only after exit is proven.

The worker owns this closed lifecycle:

1. acquire the cross-process lock;
2. verify the root ownership marker;
3. initialize `@actual-app/api` with the operation directory and
   `verbose: false`, regardless of companion log level;
4. download/open only the configured budget, passing the separately configured
   optional budget encryption password to `downloadBudget`;
5. verify budget binding and currency;
6. perform the one allowlisted request;
7. for account bank sync, capture success or the stable allowlisted failure from
   account-scoped `runBankSync`, then—whether that call returned or threw while
   the worker remains alive—attempt explicit `sync` and retain its result before
   shutdown;
8. on every normal/error path, await `shutdown`, knowing that the current
   `@actual-app/api.shutdown()` performs another best-effort `sync`, suppresses
   that implicit sync error, closes the budget, and clears API state;
9. release the lock; and
10. exit.

`sync` and `shutdown` are lifecycle steps, not caller-selectable operations.
The worker handles no second request. The shutdown-time implicit sync is an
upstream compatibility fact, not an authoritative success signal. A workflow
that requires sync proof must call explicit `sync` first and fail if that call
fails. Read-only workers make no local ledger mutation before shutdown; tests
still assert the implicit shutdown sync and prove that its swallowed error
cannot be reported as a successful explicit sync. The lock and queue remain
owned until `shutdown` completes and the child exits.

Actual stdout and stderr are discarded at the operating-system descriptor, not
captured and redacted later. Only schema-validated companion response/error
codes cross IPC. The child cannot enable Actual verbose logging, including when
the companion uses debug logging.

After a proven child exit, the parent verifies that the operation directory is
the expected direct child, has the matching operation/ownership nonce, and is
not a symlink or reparse point. It then removes only that child. A normal or
error-path cleanup failure atomically renames that child into quarantine and
sets health to `degraded`; if the rename or ownership proof fails, health
becomes `unhealthy` and the queue closes. An operation directory is never
reused, and decrypted budget copies never remain as silent ordinary
directories.

At the soft deadline the parent reports a pending timeout state but does not
release any guard. At the hard deadline it requests graceful termination, then
terminates the child. It waits up to
`FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS` for process exit. Only after exit may
it rename the operation directory into quarantine and verify/reclaim a stale
lock. If exit, quarantine, or lock state cannot be proven, service health
becomes `unhealthy`, the queue closes permanently for that process, and no new
adapter operation starts.

Read-only quarantines receive a redacted manifest and may be removed by a
tested retention job after no write receipt references them.

Bank sync is mutating even before Phase 9. Before its worker starts, the
companion durably creates the parent `job_runs` row and one
`job_run_account_operations` row per ordered account. Each child row binds a
canonical worker-operation UUID, exact account ID, ordinal, and the expected
`bank-sync-<job-run UUID>-<worker-operation UUID>` quarantine root before that
worker starts. The same transaction stores the domain-separated
`account_scope_hash` defined in `data-model.md` for the ordered account-ID list.

The bank-sync marker's companion instance and budget binding must match
`companion_instance`; its job, worker, account, and derived root must equal the
child row and the validated IPC request. A hard kill, unproven explicit sync, or
unproven shutdown after `runBankSync` starts atomically sets that child and the
parent run to `outcome_unknown` and retains the exact expected quarantine. After
the quarantine rename is durable, the companion canonically encodes the
retained root, computes its `quarantineBundleHash` as defined below, and stores
it in the child row. If a crash occurs before that database update, startup may
compute and store the hash only after the exact expected root and its strictly
parsed marker, job, worker, account, instance, and binding pass in the same
recovery transaction. Recovery rejects any missing, unregistered, lookalike,
marker/account-mismatched, or content-hash-mismatched root. The same idempotency
key returns the stored state and never automatically invokes the provider again.
An unresolved bank-sync quarantine:

- is never removed by age;
- blocks account bank sync, companion-only backup, companion migration, and
  integrity-state reset;
- is included in a paired backup; and
- is distinct from future application-receipt quarantines.

Resolution is an explicit offline
`integrity:verify --resolve-bank-sync <job-run-id>
--acknowledge-unknown-provider-outcome` command. It owns maintenance, queue,
lock, and a fresh worker; verifies binding/currency; performs explicit `sync`;
and requires clean shutdown/exit. Success changes the existing job row from
`outcome_unknown` to `failed`, retains the original per-account
`outcome-unknown`, records only
`authoritative-sync-completed-effects-unknown` plus resolution time, and
requires a new idempotency key for any later retry. Failure preserves
`outcome_unknown` and the quarantine. The command never claims whether the
provider mutation occurred.

A future write quarantine is receipt-named and follows the durable retention
rules in `data-model.md`. Its strictly parsed marker must match
`companion_instance`, the `application_receipts` budget binding and receipt ID,
the worker-operation UUID embedded in both marker and root, and the exact
`worker_quarantine_id` root stored during recovery.

### Root ownership and lock

`<ACTUAL_API_DIR>/owner.json` contains format version, companion instance ID,
budget binding hash, and a random directory nonce. It is created once with
exclusive semantics and never silently rebound.

The lock is an atomically created
`<ACTUAL_API_DIR>/locks/actual-api.lock` directory containing an atomically
replaced `owner.json` with:

- lock format version;
- PID;
- platform process-start identity;
- service-instance nonce;
- operation ID;
- directory ownership nonce; and
- acquired UTC timestamp.

Windows process identity is PID plus the process creation time returned by
`Get-Process` through a fixed, non-interpolated PowerShell invocation. Linux
identity is PID plus boot ID and `/proc/<pid>/stat` start time. If the platform
inspector is unavailable or ambiguous, stale reclamation fails closed.

Reclamation is never age-only. It requires matching directory ownership, a
complete valid lock record, proof that the recorded process identity is absent,
and successful atomic quarantine of the stale lock directory. An incomplete
lock record is unhealthy and requires explicit integrity repair.

This lock coordinates only participating companions. Raw API/CLI processes do
not honor it. Therefore the Actual API directory is companion-owned, the CLI
uses another directory, and operators must stop all external API/CLI processes
before companion backup, migration, or review-write operations.

## HTTP, authentication, and CSRF contract

The service listens on IPv4 `127.0.0.1` only. It serves the login shell, static
UI, and API from the configured origin and emits no CORS headers.

Every request:

- must arrive from a loopback remote address;
- must have exactly `Host: 127.0.0.1:<configured-port>`;
- receives a random request ID generated by the server;
- receives `Cache-Control: no-store` for API and authentication responses; and
- is subject to explicit header/body limits before parsing.

Login and every mutating request must also have an `Origin` header exactly equal
to the configured origin. `localhost`, IPv6 spellings, forwarded hosts,
`X-Forwarded-*`, a missing origin, and multiple/comma-joined origins are
rejected. Express proxy trust remains disabled.

The stable owner credential is unpadded base64url ASCII that decodes to 32–64
random bytes. Its Argon2id hash covers the exact encoded ASCII bytes and uses at
least 64 MiB memory, three iterations, parallelism one, and a per-hash random
salt. Login is protected by one process-global token bucket: burst five, refill
one attempt per minute. Verification always runs against a real or fixed dummy
Argon2id hash to reduce account/state timing leakage.

Successful login rotates to a new 32-byte random session ID and 32-byte random
CSRF token. Sessions:

- represent the stable `local_principals.id`;
- exist only in memory;
- expire after 30 minutes idle or 12 hours absolute;
- are revoked on logout and all vanish on restart; and
- are never used as idempotency principals.

The cookie name is `finance_companion_session` with `HttpOnly`,
`SameSite=Strict`, `Path=/`, and no `Domain`. `Secure` is not set for the
contract's plain-HTTP loopback origin and becomes mandatory if a later reviewed
HTTPS contract exists. The CSRF token is returned in the login response, held
only in UI memory, and sent as `X-Finance-CSRF` on mutating requests. It is
never stored in browser local/session storage.

## Owner credential rotation

`owner:rotate` is an offline/exclusive-maintenance CLI command:

```ts
export type RotateOwnerCredentialRequest = Readonly<{
  credentialFile: string;
}>;

export type RotateOwnerCredentialResult = Readonly<{
  ok: true;
  code: 'owner_credential_rotated';
  principalId: string;
  rotatedAt: string;
}>;
```

The only secret input is `--credential-file <path>`; no credential value is
accepted in argv or an environment option. The canonical file must be a
permission-restricted regular file, not a symlink/reparse point. Its content is
ASCII unpadded base64url decoding to 32–64 bytes. The reader removes at most one
terminal LF or CRLF and rejects every other whitespace, padding, non-ASCII byte,
empty value, trailing record, or oversized value.

The command requires the service to be stopped or to have entered exclusive
maintenance with new requests refused and the queue drained. It computes and
verifies the new Argon2id hash before one SQLite transaction updates only the
existing owner's `credential_hash` and `rotated_at`; principal ID and
`created_at` never change. A validation, hash, or commit failure preserves the
old hash. Success revokes every in-memory session before leaving maintenance;
an offline process has no surviving sessions.

Success writes one single-line `RotateOwnerCredentialResult` to stdout and exits
`0`. Failures write one allowlisted single-line JSON object to stderr:

| Code                      | Message                               | Exit |
| ------------------------- | ------------------------------------- | ---: |
| `invalid_credential_file` | The owner credential file is invalid. |   64 |
| `maintenance_required`    | Exclusive maintenance is required.    |   69 |
| `owner_rotation_failed`   | The owner credential was not changed. |   70 |

No result contains the credential, its file path, hash, salt, or session ID.

## HTTP routes and DTOs

Unauthenticated access is limited to `GET /health`, `POST /api/v1/session`, and
the static login shell. Every other API route requires a session.

| Method and route                   | Request                                                       | Response and initial behavior                                            |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /health`                      | None                                                          | Minimal version/status; never paths, binding, schema detail, or errors   |
| `POST /api/v1/session`             | `{ credential: string }`                                      | `{ csrfToken, expiresAt, principal: { id, role: 'owner' } }` plus cookie |
| `DELETE /api/v1/session`           | Session + CSRF                                                | `204`; revokes the current session                                       |
| `GET /api/v1/runs`                 | Validated cursor/limit                                        | `Page<JobRunSummary>`                                                    |
| `POST /api/v1/jobs/bank-sync`      | `{ accountIds?: string[] }` + idempotency                     | Accepted or replayed `JobRunSummary`; account scope resolved server-side |
| `GET /api/v1/reviews`              | Kind/status/cursor/limit allowlist                            | `Page<ReviewSummary>`                                                    |
| `POST /api/v1/reviews/:id/approve` | `ReviewDecisionRequest` + idempotency + CSRF                  | Before a write gate, records decision and returns Actual UI guidance     |
| `POST /api/v1/reviews/:id/reject`  | `{ reasonCode?: ReviewRejectionReason }` + idempotency + CSRF | Records rejection/suppression only                                       |
| `POST /api/v1/imports/amazon`      | One authenticated multipart file + idempotency + CSRF         | Parser receipt/result; raw upload deleted after parse                    |

Upload accepts one file, a route-specific MIME/extension allowlist, and a
default maximum of 10 MiB. It rejects archives, paths, multiple parts, and
unknown fields. Multipart parsing permits one file part, no text parts, at most
32 headers, at most 8 KiB of header bytes, and no more than two boundary records
(one file and the closing boundary). The server requires complete request
headers within 10 seconds, allows at most 30 seconds without body progress, and
caps total upload time at 60 seconds. It aborts and deletes its owned temporary
file on any limit or disconnect. The request stream is bounded while streaming,
before any full-file buffering. General mutating routes accept only
`application/json; charset=utf-8` with a 256 KiB limit.

Review DTOs are:

```ts
export type ReviewKind =
  'reconciliation' | 'classification' | 'subscription' | 'amazon';

export type ReviewStatus =
  | 'pending'
  | 'deferred'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'applied'
  | 'outcome_unknown';

export type ReviewSummary = Readonly<{
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  title: string;
  reasonCodes: readonly string[];
  confidenceBasisPoints: number | null;
  targetVersionHash: string | null;
  allowedActions: readonly string[];
  createdAt: string;
  updatedAt: string;
}>;

export type ReviewDecisionRequest = Readonly<{
  action: string;
  candidateId?: string;
  targetVersionHash: string;
}>;

export type ReviewDecisionResponse = Readonly<{
  review: ReviewSummary;
  application:
    | Readonly<{
        mode: 'manual-in-actual';
        instructionsCode: string;
      }>
    | Readonly<{
        mode: 'applied';
        receiptId: string;
        targetVersionHash: string;
      }>
    | Readonly<{
        mode: 'outcome-unknown';
        receiptId: string;
      }>;
}>;
```

`allowedActions` and `action` are closed per review kind in the owning design
ticket. An HTTP client never supplies an Actual patch, rule object, schedule
object, note, split child ID, principal, budget hash, or canonical action hash.

## Request idempotency and canonicalization

All authenticated mutating endpoints except login/logout require
`Idempotency-Key`. It is 16–128 URL-safe ASCII characters and is bound to:

- budget binding hash;
- stable owner principal ID;
- invocation kind (`local_http`, `local_cli`, or `scheduler`);
- versioned endpoint/operation ID; and
- the following domain-separated SHA-256 hash of versioned RFC 8785 canonical
  JSON for the validated semantic request:

```text
SHA-256(
  UTF8("finance-companion/request-replay/semantic/v1") ||
  0x00 ||
  UTF8(RFC8785(validatedSemanticRequest))
)
```

`request_hash` stores exactly 64 lowercase hexadecimal characters.

Headers, session ID, CSRF token, timestamps, upload temporary path, and request
ID are excluded. For uploads, the semantic request includes parser/adapter
version, media kind, and SHA-256 of the raw bytes, never the bytes themselves.

`request_replays` owns non-ledger endpoint replay. `job_runs` owns job execution
and its result. `application_receipts` supersedes `request_replays` for a gated
Actual write. Creation of the replay row and the domain decision/job row occurs
in one companion transaction.

An exact completed replay returns the stored status and allowlisted response.
The same key with another semantic hash returns `idempotency_conflict`. A
duplicate while the first request is active returns `operation_in_progress`
and `Retry-After`. A crash leaves an inspectable in-progress row; recovery
proves whether its companion transaction committed before allowing retry. No
current target state is used to infer a lost Actual write outcome.

`domain_record_kind` is closed to `job_run`, `review_decision`, and
`import_batch` in schema v1. Kind and ID are either both null or both non-null.
The replay state matrix is:

| Status             | Required fields                                            | Forbidden fields                                 | Duplicate behavior                                                                      |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `in_progress`      | optional paired domain kind/ID                             | response status/body, error code, completed time | return `operation_in_progress`; never age-take over                                     |
| `completed`        | response status, allowlisted response JSON, completed time | error code                                       | replay the stored success                                                               |
| `failed_retryable` | stable error code, completed time                          | response status/body                             | an explicit retry atomically takes over this same row and reuses the same domain record |
| `failed_final`     | stable error code, allowlisted error JSON, completed time  | success response status/body                     | replay the stored final error                                                           |

The owning domain result and replay terminal state commit in one SQLite
transaction. A `failed_retryable` takeover clears terminal fields, increments a
stored attempt counter, and moves the same row back to `in_progress`; it never
creates a second domain record. Takeover requires a compare-and-set on the
exact prior status/request hash and is never based on elapsed time alone. An
`in_progress` row after restart remains blocked until recovery proves its
companion transaction boundary; gated Actual writes use the stronger receipt
protocol and never use replay takeover.

Stored response JSON is rebuilt from a route-specific allowlist and cannot
contain credentials, session/CSRF tokens, raw uploads, notes/item titles,
account numbers, exception text, SQL, or host paths.

## Backup, restore, and integrity interfaces

The service must be stopped or in an exclusive maintenance state. Scheduler
invocations and new HTTP work are refused during maintenance.

```ts
export type BackupMode = 'companion-only' | 'paired';

export type BackupArtifactKind =
  | 'companion-database'
  | 'integrity-anchor'
  | 'actual-export'
  | 'actual-snapshot'
  | 'operation-quarantine';

export type CreateBackupRequest = Readonly<{
  mode: BackupMode;
  destinationDirectory: string;
  actualArtifacts?: readonly Readonly<{
    kind: 'actual-export' | 'actual-snapshot';
    path: string;
  }>[];
}>;

export type CreateBackupResult = Readonly<{
  ok: true;
  backupId: string;
  mode: BackupMode;
  containerFileName: string;
  manifestHash: string;
  createdAt: string;
}>;

export type VerifyBackupRequest = Readonly<{
  sourceFile: string;
  expectedManifestHash?: string;
}>;

export type VerifyBackupResult = Readonly<{
  ok: true;
  backupId: string;
  mode: BackupMode;
  manifestHash: string;
  schemaVersion: number;
  artifactCount: number;
  createdAt: string;
}>;

export type RestoreBackupRequest = Readonly<{
  sourceFile: string;
  expectedManifestHash: string;
  expectedMode: BackupMode;
}>;

export type RestoreBackupResult = Readonly<{
  ok: true;
  restoreId: string;
  backupId: string;
  mode: 'companion-only';
  manifestHash: string;
  status: 'restored';
  writeCapabilityState: 'disabled';
  completedAt: string;
}>;

export type VerifiedBackupManifestV1 = Readonly<{
  formatVersion: 1;
  backupId: string;
  mode: BackupMode;
  budgetKeyHash: string;
  budgetCurrencyCode: string;
  schemaVersion: number;
  writeCapabilityGeneration: number;
  writeCapabilityEventHash: string | null;
  artifacts: readonly Readonly<{
    logicalName: string;
    kind: BackupArtifactKind;
    hash: string;
    byteLength: number;
  }>[];
  preBackupAnchorHash: string;
  highestIssuedIntentSequence: number;
  highestIssuedIntentHash: string | null;
  highestAppliedReceiptSequence: number;
  highestAppliedReceiptHash: string | null;
  unresolvedQuarantineHashes: readonly string[];
  createdAt: string;
}>;

export type AuthenticatedBackupManifestV1 = Readonly<{
  payload: VerifiedBackupManifestV1;
  mac: Readonly<{
    algorithm: 'hmac-sha256';
    keyId: string;
    value: string;
  }>;
}>;

export type BackupContainerHeaderV1 = Readonly<{
  magic: 'FINANCE-COMPANION-BACKUP';
  formatVersion: 1;
  backupId: string;
  manifestHash: string;
  encryption: Readonly<{
    algorithm: 'aes-256-gcm';
    keyId: string;
    salt: string;
    nonce: string;
  }>;
}>;

export type RestoreLocalTargetV1 = Readonly<{
  kind:
    'companion-database-set' | 'integrity-anchor' | 'operation-quarantine-set';
  livePathHash: string;
  previousHash: string | null;
  restoredHash: string;
  stagingNonce: string;
  rollbackNonce: string;
  phase:
    | 'preparing'
    | 'prepared'
    | 'live-moving'
    | 'live-moved'
    | 'staged-activating'
    | 'staged-activated'
    | 'verified'
    | 'cleaning'
    | 'cleaned'
    | 'canceled';
}>;

export type RestoreIntentJournalV1 = Readonly<{
  formatVersion: 1;
  restoreId: string;
  backupId: string;
  mode: 'companion-only';
  manifestHash: string;
  phase:
    | 'preparing'
    | 'prepared'
    | 'activating'
    | 'anchor-activated'
    | 'verified'
    | 'cleaning'
    | 'committed'
    | 'canceled';
  targets: readonly RestoreLocalTargetV1[];
  createdAt: string;
  updatedAt: string;
}>;

export type AuthenticatedRestoreIntentJournalV1 = Readonly<{
  payload: RestoreIntentJournalV1;
  mac: Readonly<{
    algorithm: 'hmac-sha256';
    keyId: string;
    value: string;
  }>;
}>;
```

Paths are local CLI inputs and never HTTP fields, logs, results, or manifest
values. Manifest logical names are fixed ASCII archive names, not host paths.
Every hash and MAC in these interfaces is exactly 64 lowercase hexadecimal
characters. The `artifacts` array excludes `backup-manifest.json` to avoid a
self-reference and is sorted by `logicalName`.
Every backup, restore, job-run, receipt, and worker-operation ID used by these
formats is a lowercase canonical RFC 4122 UUID string.
`writeCapabilityGeneration` is a safe nonnegative integer; its event hash is
null exactly at generation zero and otherwise is a 64-character hash matching
the database, anchor, and final immutable capability event.

Journal target kinds are unique and ordered
`operation-quarantine-set`, `companion-database-set`, then
`integrity-anchor`; absent optional quarantine state omits the first target.
Contract-v1 companion-only restore therefore contains exactly the database set
and anchor targets. The anchor is always the final activation target.
Each staging/rollback nonce is an independent 32-byte unpadded-base64url value
bound by the journal MAC. Its sibling directory contains a restricted
`restore-owner.json` with format version, restore ID, target kind, role, and
matching nonce. This marker is staging metadata and never becomes a live target
or backup record.

### Manifest authentication and encrypted container

For every non-manifest record, `artifact.hash` is lowercase hexadecimal for:

```text
SHA-256(
  UTF8("finance-companion/backup-artifact/v1") ||
  0x00 ||
  UINT32_BE(byteLength(UTF8(logicalName))) ||
  UTF8(logicalName) ||
  UINT64_BE(byteLength(contentBytes)) ||
  contentBytes
)
```

`artifact.byteLength` is the exact unsigned content-byte length.
`preBackupAnchorHash` equals the artifact hash for
`integrity-anchor.json`. `unresolvedQuarantineHashes` is the sorted list of
unique artifact hashes for every `operation-quarantine` record and no other
record.

A restore journal hashes each logical live target as a set of members. A member
is `{ logicalName, present, byteLength, contentSha256 }`, where
`contentSha256` is lowercase SHA-256 of the raw member bytes and is `null` only
when `present` is false. Members are sorted by UTF-8 byte order of
`logicalName`. The set hash is:

```text
SHA-256(
  UTF8("finance-companion/restore-target-set/v1") ||
  0x00 ||
  UTF8(targetKind) ||
  0x00 ||
  UTF8(RFC8785(members))
)
```

The `companion-database-set` members are exactly `companion.sqlite`,
`companion.sqlite-wal`, and `companion.sqlite-shm`; absent sidecars are explicit
members with `present: false`. A restored database set has a present main file
and absent sidecars. `integrity-anchor` has exactly one present
`integrity-anchor.json` member. `operation-quarantine-set` contains the
contiguous indexed `.fcq` bundle records described below, or is absent.
`previousHash` is null only when the complete target was absent; every
`restoredHash` is present.

For a live or staged quarantine directory tree, hashing streams each directory
through the canonical bundle encoder and treats the resulting indexed bundle
names/bytes as target-set members. `.fcq` files are an archive representation,
not files placed inside the live quarantine root.

The manifest MAC is:

```text
HMAC-SHA-256(
  integrityMacKey,
  UTF8("finance-companion/backup-manifest/v1") ||
  0x00 ||
  UTF8(RFC8785(manifestPayload))
)
```

`manifestHash` is:

```text
SHA-256(
  UTF8("finance-companion/backup-manifest-envelope/v1") ||
  0x00 ||
  UTF8(RFC8785(authenticatedManifest))
)
```

Every backup mode uses the separate 32-byte key from
`FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE`. `keyId` is the first 16
lowercase hexadecimal characters of
`SHA-256(UTF8("finance-companion/backup-key-id/v1") || 0x00 || keyBytes)`.
For each container, the creator generates a 32-byte salt and 12-byte nonce. Both
are unpadded base64url in the header. The AES key is:

```text
HKDF-SHA-256(
  inputKey = backupEncryptionKey,
  salt = decodedHeaderSalt,
  info =
    UTF8("finance-companion/backup-encryption/v1") ||
    0x00 ||
    UTF8(backupId),
  length = 32
)
```

The container is `FCBKP001`, a four-byte unsigned big-endian canonical-header
length, UTF-8 RFC 8785 `BackupContainerHeaderV1`, AES-256-GCM ciphertext, and
the final 16-byte authentication tag. The canonical header bytes are GCM
additional authenticated data.

Header decoding is strict: valid UTF-8, no duplicate or unknown property, and
the parsed object must re-encode byte-for-byte to the same RFC 8785 bytes. The
binary and JSON magic, format version, algorithm, and derived key ID must match
their literals. Salt and nonce must decode from canonical unpadded base64url to
exactly 32 and 12 bytes. After authenticating/decrypting the manifest, the
header `backupId` must equal `manifest.payload.backupId`; the header
`manifestHash` must equal the recomputed authenticated-manifest envelope hash;
and `expectedManifestHash`, when supplied, must equal that same value. Any
mismatch fails verification before extraction or live-state access.

Plaintext is a deterministic record stream sorted by logical name. Each record
is a four-byte unsigned big-endian UTF-8 name length, an eight-byte unsigned
big-endian content length, the name bytes, then content bytes. A zero name and
content length terminates the stream. The only valid record-name grammar is:

```text
backup-manifest.json
companion.sqlite
integrity-anchor.json
actual/000000.export
actual/000000.snapshot
quarantine/[0-9]{6}.fcq
```

A manifest artifact kind must match its name:

| Record name               | Artifact kind          |
| ------------------------- | ---------------------- |
| `companion.sqlite`        | `companion-database`   |
| `integrity-anchor.json`   | `integrity-anchor`     |
| `actual/000000.export`    | `actual-export`        |
| `actual/000000.snapshot`  | `actual-snapshot`      |
| `quarantine/[0-9]{6}.fcq` | `operation-quarantine` |

A name is ASCII, at most 128 bytes, contains `/` only as shown, and never
contains `\`, `:`, NUL, a drive/UNC prefix, an empty segment, or a `.`/`..`
segment. Quarantine indexes begin at `000000` and are contiguous. The
companion-only mode has exactly the first three records. Paired mode adds
exactly one of the two Actual records and zero or more quarantine records.

After decryption and before extraction, the implementation requires a bijection
between every non-manifest record and exactly one manifest artifact with the
same name, kind, byte length, and verified artifact hash. It rejects duplicate,
undeclared, missing, non-contiguous, wrong-kind, or wrong-mode records, a second
terminator, a zero name length paired with a nonzero content length or vice
versa, and any byte after the one terminator. The encryption key, MAC key,
credentials, host paths, and temporary names are never records.

All lengths are parsed with checked unsigned arithmetic before allocation. The
closed limits are:

| Item                             | Maximum                                           |
| -------------------------------- | ------------------------------------------------- |
| Canonical header                 | 16 KiB                                            |
| Manifest record                  | 8 MiB                                             |
| Record name                      | 128 bytes                                         |
| Records including manifest       | 10,004                                            |
| Companion database record        | 32 GiB                                            |
| Actual export/snapshot record    | 32 GiB                                            |
| One quarantine bundle            | 16 GiB                                            |
| Decrypted record stream in total | 68,719,476,704 bytes                              |
| Encrypted container in total     | stream maximum + 16 KiB header + 28 framing bytes |

The source must be a regular file whose measured length is within the container
limit and large enough for magic, length, header, and tag. Header length,
ciphertext length, every record length, cumulative plaintext length, and record
count are checked with integers that cannot wrap. Parsing and hashing stream
through fixed-size buffers; a declared length is never used for a single
allocation. The plaintext cap is below the per-key AES-GCM message limit.

### Canonical operation-quarantine bundles

Each unresolved operation directory is one deterministic `FCQTR001` bundle.
After the eight-byte magic, the bundle contains a two-byte unsigned big-endian
root-name length, the UTF-8 root name, a four-byte entry count, then entries in
UTF-8 byte order of relative path. A root name is exactly
`bank-sync-<job UUID>-<operation UUID>` or
`write-<receipt UUID>-<operation UUID>`, using lowercase canonical UUIDs.

Each entry is a one-byte type (`0` directory, `1` regular file), a four-byte
path length, an eight-byte content length, path bytes, then file bytes.
Directories have zero content length. Paths are valid UTF-8 normalized to NFC,
at most 1,024 bytes overall and 255 bytes per segment, with no duplicate,
empty, `.`, `..`, backslash, colon, NUL, control-character, absolute, drive, or
UNC form. Only ordinary directories and single-link regular files are accepted;
symlinks, reparse points, hard links, devices, sockets, and alternate streams
are rejected.

Every bundle contains exactly one `operation-owner.json` root-level entry. It is
a single-link regular file whose bytes pass the strict marker schema above and
whose typed root name exactly equals the bundle root. A missing, duplicate,
directory, nested, malformed, noncanonical, wrong-version, or unknown-field
marker is rejected.

A bundle contains at most 10,000 entries and 16 GiB total bytes; one file is at
most 4 GiB. Directory entries are required for every non-root parent and precede
their children. Bundles are sorted by root name and assigned contiguous outer
indexes. Restore recreates them beneath an owned empty quarantine staging
directory using exclusive no-follow creation, fixed permissions, and fresh
ordinary files; it never restores a link or caller-selected path. Entry count
must consume the bundle exactly; truncation or any trailing byte is rejected.

The stable, logical-name-independent `quarantineBundleHash` is lowercase
hexadecimal for:

```text
SHA-256(
  UTF8("finance-companion/operation-quarantine-bundle/v1") ||
  0x00 ||
  bundleBytes
)
```

`bundleBytes` starts with the `FCQTR001` magic and includes the root name and all
entries above. A bank-sync child row stores this hash in
`quarantine_bundle_hash`; it never stores the backup `artifact.hash`, because
that separate hash includes the backup-time positional logical name such as
`quarantine/000003.fcq`.

Backup creation and `backup:verify` decode every quarantine bundle and require
its root name, ownership marker, job-run ID, worker-operation ID, account ID,
and computed `quarantineBundleHash` to match exactly one unresolved child row in
the backed-up companion database. They separately verify the positional archive
record's logical name, byte length, and `artifact.hash`.
`unresolvedQuarantineHashes` remains the sorted list of those archive-name-bound
artifact hashes. Reordering quarantine roots can therefore change archive
artifact hashes without changing any root's `quarantineBundleHash`.

### Runtime path validation

Immediately before work and again after maintenance/locks are owned, every
caller-supplied source, destination, container, and Actual artifact is resolved
through canonical existing parents. The command rejects:

- any symlink or reparse point in any existing path component;
- a non-regular source or non-directory destination;
- equality, ancestor, or descendant overlap with the companion data root,
  Actual API root, integrity anchor, MAC key, backup encryption key, password
  files, bootstrap/rotation credential file, another artifact, or the source
  container;
- duplicate Actual artifact kinds or logical names;
- an existing final container; and
- a destination that cannot provide restricted exclusive creation.

Backup-create and backup-verify temporary/extraction paths obey the same
external overlap ban and remain outside every live or secret root.

Internally derived restore staging and rollback paths are the only exception to
the live-root overlap rule. They are fixed direct siblings of the exact
configured live target, named
`.<live-leaf>.restore-<canonical-restore-UUID>.stage` and
`.<live-leaf>.restore-<canonical-restore-UUID>.rollback`. The command requires
the canonical parent to equal the live target's canonical parent, requires both
leaves not to exist when preparation starts, creates them exclusively without
following links, and rejects overlap with any other live target, source, secret,
or restore sibling. They are never caller-selected. Parent and opened-object
identity is revalidated before and after every create, flush, rename, and
removal.

The final container is created with exclusive semantics as
`<backupId>.finance-companion-backup`. Temporary files are owned direct
children of the validated destination and are removed or quarantined by the
same scoped-cleanup rules as adapter operation directories.

### Permission and opened-handle contract

The service identity is the effective Unix UID or Windows account running the
command. On POSIX:

- every secret/key/credential input is a single-link regular file owned by the
  service identity with mode exactly `0400` or `0600`;
- every writable private directory is owned by that identity with mode `0700`;
  and
- every created database copy, container, manifest, journal, staging, rollback,
  extraction, or quarantine file is mode `0600`.

On Windows, the filesystem must expose stable file IDs and ACLs. Each private
file/directory is owned by the service identity and has a protected DACL with
inheritance disabled. Allow entries exist only for the service identity and
`NT AUTHORITY\SYSTEM`; no other principal, inherited entry, broad group, or
network identity has access. The service identity has the required read access
for inputs and full control for owned writable objects. Files with an alternate
data stream or any reparse tag are rejected.

Validation is not path-only. POSIX code uses no-follow open/create, then
`fstat`, and compares device/inode, owner, mode, type, and link count with the
pre-open path result. Windows code opens without traversing a reparse point,
then compares volume/file ID, final canonical path, owner, DACL, type, and
reparse state with a second path query. The containing directory is held open
or its identity is rechecked around each rename. A mismatch, unverifiable ACL,
unstable file ID, network filesystem, or unsupported no-follow primitive fails
before sensitive bytes are read or live state changes.

When writes have never been enabled, `companion-only`:

1. owns the queue and companion lock;
2. rejects unresolved bank-sync or write quarantines and verifies the
   generation-zero anchor;
3. checkpoints through the SQLite online backup API or `VACUUM INTO`;
4. hashes and verifies the resulting database and pre-backup anchor;
5. builds and authenticates the manifest; and
6. encrypts, fsyncs, verifies, and atomically publishes the container.

Companion-only creation rejects `actualArtifacts`. Paired creation requires
exactly one verified `actual-export` or `actual-snapshot` artifact for the bound
budget; a later approved topology may version this cardinality rather than
silently changing it.

Once writes are or have been enabled, `companion-only` is rejected. `paired`
must additionally own the future remote fence, call Actual `sync` inside the
already-owned adapter lifecycle, capture verified Actual export/snapshot
artifacts, include unresolved write quarantines, finalize and encrypt the set,
then advance `lastVerifiedPairedBackupManifestHash` only after the published
container passes `backup:verify`. The manifest binds the pre-advance anchor and
never embeds the post-advance anchor, preventing a circular hash.

`backup:verify` authenticates the bounded header, derives the key, verifies the
GCM tag, parses the bounded record stream, authenticates the manifest, compares
the optional expected hash, and verifies every artifact hash/length, schema,
binding, currency, anchor, issued/applied chain, capability-event chain,
quarantine declaration, stable bundle hash and account-operation binding, and
mode rule. It streams through an owned temporary directory outside every live
or secret root and removes that directory before returning. It changes no
database, anchor, or Actual state.

### Crash-recoverable restore activation

Restore is offline. Contract v1 implements only generation-zero
`companion-only` restore. If `expectedMode` is `paired`, the command returns the
stable `feature_not_implemented` result before reading a key, opening the source
container, creating a path, or changing live state. Current public
`importBudget` creates/imports a budget; it is not a remotely fenced replacement
of the bound budget and cannot prove rollback or an unknown outcome.

Paired restore remains disabled until a reviewed contract amendment defines and
implements a versioned server-owned remote fence, conditional restore/import,
durable idempotency key, authoritative applied/not-applied lookup, recovery for
unknown outcomes, binding transition, and its interaction with this local
journal. Write capability cannot be enabled until that paired-restore release
gate passes. No implementation may substitute the companion-owned Actual API
working directory or infer remote success from current budget contents.

For `companion-only`, restore performs the full verify operation and requires
both the live target and backup to prove generation zero: writes disabled,
capability event hash null with an empty event table, issued/applied sequences
zero with null hashes, no receipt/write marker, and no unresolved bank-sync or
write quarantine. Before creating a staging path, the live database's
`companion_instance.instance_id`, the Actual API-root `owner.json` instance ID,
and the backup database's instance ID must all exist and be the same immutable
canonical UUID. Binding and currency must also match the configured target.
Contract v1 has no instance-rebind restore; a missing or different live identity
fails closed. The restored database remains write-disabled and the command
reconstructs and verifies its generation-zero anchor. Success returns the
literal companion-only `RestoreBackupResult` above; it does not enter
`recovery_required`.

After full verification, restore computes the prior/restored target-set hashes
without creating a live-root sibling. It rejects any restore-named sibling that
is not owned by an authenticated matching journal. Before creating any staging
or rollback sibling, it writes an
`AuthenticatedRestoreIntentJournalV1` beside the integrity anchor. Its envelope
uses the same shape as the anchor envelope, with this MAC input:

```text
HMAC-SHA-256(
  integrityMacKey,
  UTF8("finance-companion/restore-intent/v1") ||
  0x00 ||
  UTF8(RFC8785(journalPayload))
)
```

The initial journal and every target have phase `preparing`; live prior sets
must be unchanged and rollback siblings absent. Restore then materializes each
target inside its nonce-bound restricted staging sibling, verifies its complete
restored hash, and persists that target as `prepared`. When all are prepared,
the global journal becomes `prepared`. The database target is always the main
file plus `-wal` and `-shm` sidecars. The clean restored set has no sidecars; the
rollback set preserves their exact prior presence and bytes. A quarantine target
is the complete canonical bundle set, never one selected directory.

The journal binds hashes of configured live paths, exact prior and staged target
sets, backup manifest, nonces, and every phase. Each journal update writes and
flushes a restricted temporary sibling named
`.finance-companion-restore-intent-<restore UUID>.tmp`, atomically replaces the
journal, reopens and authenticates it, and flushes the parent directory where
supported. If both the journal and its update temporary exist after a crash,
recovery accepts only authenticated payloads for the same restore where the
temporary is the exact next monotonic phase; it durably completes that
replacement. A sole authenticated initial `preparing` temporary with unchanged
prior targets and no restore siblings is durably removed as a canceled
preparation. Any other sole/paired temporary state fails closed. A platform
without durable replace/flush semantics is unsupported for restore.

After persisting global `activating`, each non-anchor target uses these durable
transitions:

1. verify prior live set, restored staging set, and absent rollback sibling;
2. persist `live-moving`;
3. move the prior set into rollback and flush the parent;
4. persist `live-moved`;
5. persist `staged-activating`;
6. move the restored set into the exact live names and flush the parent;
7. persist `staged-activated`;
8. reopen and verify the complete live set; and
9. persist `verified`.

The database set moves each of its three named members separately, recording no
invented sidecar. Other file/directory sets use an atomic same-parent rename
when supported. The integrity anchor follows the same target phases but is
activated last. After its target reaches `verified`, the global journal becomes
`anchor-activated`; a final full verification advances it to `verified`.

Cleanup is also journaled. The global phase becomes `cleaning`; before removing
each target's rollback/staging sibling the target becomes `cleaning`. After
identity/hash validation, removal, and parent flush, it becomes `cleaned`.
Targets are cleaned in reverse activation order. Only when every target is
`cleaned` does the global journal become `committed`. The authenticated journal
is removed last, its parent is flushed, and only then may restore report
success.

Each `livePathHash` is
`SHA-256(UTF8("finance-companion/restore-live-path/v1") || 0x00 ||
UTF8(canonicalAbsolutePath))`, encoded as lowercase hexadecimal. Path hashes
remain inside the authenticated local journal and never enter logs, results, or
the backup.

This protocol does not claim a cross-volume atomic rename. Startup detects a
journal before database open or adapter work, authenticates it, and enters
`recovery_required`. It accepts only the following authenticated phase and
hash/existence combinations:

| Target phase        | Required placement                                                                                                           | Recovery action                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `preparing`         | prior set wholly live; rollback absent; staging absent or a nonce-bound partial owned set with only declared member names    | delete owned partial staging and cancel prepare |
| `prepared`          | prior set wholly live; restored set wholly staged; rollback absent                                                           | remain prepared                                 |
| `live-moving`       | restored set wholly staged; each prior member exists exactly once across live and rollback; union hashes to prior set        | finish moving prior members into rollback       |
| `live-moved`        | prior set wholly in rollback; live absent; restored set wholly staged                                                        | begin staged activation                         |
| `staged-activating` | prior set wholly in rollback; each restored member exists exactly once across staging and live; union hashes to restored set | finish moving restored members into live        |
| `staged-activated`  | prior set wholly in rollback; restored set wholly live; staging absent                                                       | verify live set                                 |
| `verified`          | prior set wholly in rollback; restored set wholly live; staging absent                                                       | retain until global verification                |
| `cleaning`          | restored set wholly live; staging absent; prior rollback is either exact or already absent                                   | remove any exact rollback and flush             |
| `cleaned`           | restored set wholly live; staging and rollback absent                                                                        | retain until journal removal                    |
| `canceled`          | prior set wholly live; staging and rollback absent                                                                           | retain until canceled-journal removal           |

For a target represented by one atomic rename, the two partition rows permit
only the complete pre-rename or complete post-rename placement. For the
three-member database set they permit an exact partition, never a missing,
duplicated, unknown, or hash-mismatched member. This matrix covers a crash after
either filesystem mutation but before its following journal update.

During global `preparing`, no live mutation is allowed. Recovery verifies the
prior live hashes, removes only nonce-bound partial staging, flushes, marks each
target `canceled`, marks the journal `canceled`, removes it last, and leaves the
prior service state unchanged. Once the authenticated global journal reaches
`prepared`, recovery always converges forward to the restored set; it never
guesses that a partially executed restore should be canceled. It completes
every target through the matrix in order, activates the anchor last, verifies,
and resumes or completes journaled cleanup.

A prior live-anchor hash means anchor activation has not completed and recovery
continues it. A restored live-anchor hash advances the global journal to
`anchor-activated` and continues final verification. In global `committed`, all
targets must be `cleaned`, all restore siblings absent, and all live hashes
restored before the journal is removed and its parent flushed. A restore-named
staging, rollback, or journal-update sibling without a valid matching journal
is fail-closed; it is never removed by age. Any other anchor value, placement
outside the matrix, unauthenticated journal, missing rollback evidence, extra
sidecar, or failed durable flush remains fail-closed for manual recovery;
normal service never starts on a mixed set.

Restore never copies either key, never accepts a database-only rollback after
writes, and never reports success until the journal is committed and removed.
Crash-injection tests cover before and after every journal replace, member
rename, directory flush, live verification, anchor activation, and cleanup.

### Command results and exits

Successful create, verify, and restore write exactly one corresponding
allowlisted result object to stdout. Failures write one single-line JSON problem
to stderr and no partial success object:

| Code                             | Exit | Meaning                                                                                    |
| -------------------------------- | ---: | ------------------------------------------------------------------------------------------ |
| `invalid_backup_request`         |   64 | A request, path, key file, mode, or expected hash is invalid.                              |
| `backup_verification_failed`     |   65 | Authentication, decryption, hash, schema, binding, chain, or artifact verification failed. |
| `maintenance_required`           |   69 | Exclusive maintenance, queue, lock, or remote fence is unavailable.                        |
| `backup_destination_unavailable` |   73 | Exclusive protected creation or scoped cleanup is unavailable.                             |
| `restore_recovery_required`      |   75 | A restore journal cannot be safely converged automatically.                                |
| `feature_not_implemented`        |   78 | The owning implementation gate has not landed.                                             |

No failure deletes a published backup or an unresolved quarantine.

`integrity:verify` has this closed CLI surface:

```ts
export type IntegrityVerifyRequest = Readonly<
  | {
      resolveBankSyncJobId?: never;
      acknowledgeUnknownProviderOutcome?: never;
    }
  | {
      resolveBankSyncJobId: string;
      acknowledgeUnknownProviderOutcome: true;
    }
>;

export type IntegrityVerifyResult = Readonly<{
  ok: true;
  status: 'verified' | 'bank-sync-outcome-resolved';
  schemaVersion: number;
  writeCapabilityState: 'disabled' | 'enabled' | 'recovery_required';
  unresolvedQuarantineCount: number;
  resolvedJobRunId: string | null;
  verifiedAt: string;
}>;
```

Normal verification authenticates the database/anchor chains, binding,
currency, ownership marker, replay/job/receipt state matrices, and quarantine
manifests without mutating them. Bank-sync resolution is the explicit procedure
defined in the worker lifecycle and requires the acknowledgement flag. Success
prints one result and exits `0`; integrity failure uses exit `65`, unresolvable
recovery uses `75`, and an unlanded owner uses `78`.

## Logging and health

Structured logs use this field allowlist:

- timestamp;
- severity;
- stable event code;
- request/job/operation/receipt ID;
- review kind;
- hashed budget scope;
- account ID only when required to diagnose an account-scoped operation;
- duration and count fields; and
- allowlisted error code.

Messages and metadata never contain credentials, cookies, CSRF tokens, raw
source bytes, Amazon item titles, transaction notes, merchant descriptions,
account numbers, SQL, child-process command lines, or local paths. Logging a
configuration problem names the key, not its value.

Internal service health distinguishes:

- `healthy`;
- `degraded` for a retryable provider/job issue while guards are released;
- `maintenance`;
- `recovery_required`; and
- `unhealthy` when a child exit, lock, ownership, database, anchor, or binding
  cannot be proven.

Public `/health` returns only `{ status, version }`, mapping every fail-closed
state to a non-healthy status without internal detail.

## Extraction boundary

The companion can later move to another repository without an Actual database
migration because:

- its only Actual dependency is the closed adapter contract;
- the browser speaks only the same-origin HTTP DTOs;
- companion SQLite owns only derived/provenance/integrity metadata;
- all IDs crossing the boundary remain opaque strings;
- money/date serialization is explicit; and
- no other Actual workspace may import companion implementation modules.

Extraction must preserve the same local authentication and integrity behavior.
It does not justify remote binding or a generic public integration API.

## Implementation gates

FIN-9 completion may unblock only:

- FIN-10 package scaffold;
- FIN-11 database, migration, anchor, and backup lifecycle;
- FIN-27 scheduled-sync policy design;
- FIN-33 subscription scoring/schedule-operation design; and
- FIN-37 Amazon identity/retention/allocation design once FIN-15 also completes.

FIN-12 waits for FIN-10 and FIN-11. FIN-13 waits for FIN-11 and FIN-12. FIN-14
waits for FIN-10 through FIN-12. No companion review write becomes agent-ready
from this contract alone. Phase 9 must separately freeze and implement the
conditional Actual mutator, durable outcome, remote fence, receipt recovery,
and paired-backup gate.

## Contract acceptance checks

Before FIN-9 is Done:

- Markdown formatting and links pass;
- every configuration key, public route, public DTO, operation, script,
  migration/table owner, and capability state is named here;
- a security review verifies loopback authentication, Host/Origin/CSRF,
  session lifecycle, secret handling, directory ownership, worker fail-stop,
  stale-lock recovery, and external anchor behavior;
- a financial-integrity review verifies authority boundaries, write-disabled
  review behavior, idempotency, unknown-outcome handling, and backup/restore;
- this repository contract supersedes conflicting prose in FIN-10 through
  FIN-14, and the lead aligns each live ticket before moving that ticket to
  `In Progress`; and
- no secret, personal data, host-specific path, raw statement, generated
  database, or non-English user-facing content is present.
