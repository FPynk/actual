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

| Key                                                 | Required                                 | Validation and use                                                                            |
| --------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `FINANCE_COMPANION_BIND_ADDRESS`                    | No; defaults to `127.0.0.1`              | The only accepted value is exactly `127.0.0.1`                                                |
| `FINANCE_COMPANION_PORT`                            | No; defaults to `4100`                   | Integer `1024..65535`                                                                         |
| `FINANCE_COMPANION_ORIGIN`                          | No; derived from address and port        | If supplied, must equal `http://127.0.0.1:<port>` exactly                                     |
| `FINANCE_COMPANION_DATA_DIR`                        | Yes                                      | Companion SQLite and service-owned data; existing real directory, not a symlink/reparse point |
| `FINANCE_COMPANION_ACTUAL_API_DIR`                  | Yes                                      | Dedicated Actual API root; distinct from and not nested under any other configured root       |
| `FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH`           | Yes                                      | Anchor file outside the data and Actual API roots and their restore domain                    |
| `FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE`          | Yes                                      | Read-only file containing at least 32 random bytes; never captured in a backup                |
| `FINANCE_COMPANION_ACTUAL_SERVER_URL`               | Yes                                      | Absolute `http` or `https` URL; credentials and fragments rejected                            |
| `FINANCE_COMPANION_ACTUAL_BUDGET_ID`                | Yes                                      | Non-empty opaque Actual budget identifier; logged only through its domain-separated hash      |
| `FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY`          | Yes                                      | Three uppercase ASCII letters; must match the opened budget                                   |
| `FINANCE_COMPANION_ACTUAL_PASSWORD_FILE`            | Exactly one password source              | Preferred permission-restricted file; contents never stored in companion SQLite               |
| `FINANCE_COMPANION_ACTUAL_PASSWORD`                 | Exactly one password source              | Development-only alternative; value is redacted and removed from `process.env` after loading  |
| `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE` | Required only before the first principal | Preferred permission-restricted file with 32 or more random bytes                             |
| `FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL`      | Development-only bootstrap alternative   | Mutually exclusive with the file; removed from `process.env` after hashing                    |
| `FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS`         | No; defaults to `120000`                 | Positive integer smaller than the hard deadline                                               |
| `FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS`         | No; defaults to `180000`                 | Positive integer; reaching it starts child termination                                        |
| `FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS`          | No; defaults to `30000`                  | Maximum time to prove child exit after termination                                            |
| `FINANCE_COMPANION_LOG_LEVEL`                       | No; defaults to `info`                   | `error`, `warn`, `info`, or `debug`; debug still uses the same allowlist                      |

The service does not accept a configuration key that enables review writes.
`write_capability_state` is durable database and anchor state changed only by a
future gated integrity command. The package never accepts provider credentials.

All configured roots are resolved and compared using canonical existing parent
paths. The service rejects overlaps, directory symlinks/reparse points, a MAC
key inside a backup root, and a data or adapter root whose ownership marker is
bound to another companion instance.

## Stable binding and capability state

The budget binding hash is:

```text
SHA-256(
  "finance-companion/budget-binding/v1\0" +
  normalizedActualServerOrigin + "\0" +
  actualBudgetId
)
```

The normalized origin lowercases the scheme and host, removes default ports,
requires an empty path or `/`, and contains no credential, query, or fragment.
The raw budget ID and server URL are never persisted in candidate tables or
ordinary logs.

At first initialization, one transaction creates:

- the `companion_instance` row with the binding hash, configured currency, and
  `write_capability_state = disabled`;
- one stable owner UUID in `local_principals`;
- an Argon2id hash of the bootstrap credential; and
- schema migration records with verified checksums.

The opened Actual budget must independently report the configured ISO currency.
A binding or currency mismatch closes the adapter and refuses service startup.
Changing server, budget, or currency requires a new data directory.

Capability states have these effects:

| State               | Actual reads | Account-scoped bank sync | Review writes | Migration/backup rule                                             |
| ------------------- | ------------ | ------------------------ | ------------- | ----------------------------------------------------------------- |
| `disabled`          | Allowed      | Allowed                  | Blocked       | Companion-only backup is allowed before migration                 |
| `enabled`           | Allowed      | Allowed                  | Gated only    | Every migration/rollback requires a remotely fenced paired backup |
| `recovery_required` | Allowed      | Blocked                  | Blocked       | Only verification and paired restore/repair may proceed           |

“Gated only” means the operation-specific ticket, conditional Actual mutator,
durable Actual outcome, remote fence, receipt recovery, and all named tests are
complete. No route infers permission merely from the string `enabled`.

## Schema-v1 migration ownership

`docs/project/data-model.md` remains authoritative for columns, constraints,
indexes, retention, and state transitions. Contract v1 freezes these migration
files and table owners:

| Migration | Tables                                                                                                                                                                                                                                                                                                                                                 | Implemented by       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `001`     | `schema_migrations`, `companion_instance`, `local_principals`                                                                                                                                                                                                                                                                                          | FIN-11               |
| `002`     | `request_replays`, `job_runs`                                                                                                                                                                                                                                                                                                                          | FIN-13/FIN-28        |
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

The MAC input is UTF-8 RFC 8785 canonical JSON of `payload`, prefixed with
`finance-companion/integrity-anchor/v1` and a zero byte. `keyId` is the first 16
hexadecimal characters of a domain-separated SHA-256 hash of the key and is not
secret. The MAC key is never stored beside the anchor.

An update writes a permission-restricted temporary sibling, flushes it, closes
it, atomically replaces the anchor, and flushes the containing directory where
the platform supports that operation. Startup verifies the envelope before any
adapter operation. A missing generation-zero anchor may be initialized only
for a new database that has never enabled writes and has no pre-existing anchor
path. Any anchor ahead of, divergent from, or bound differently than durable
database state sets `recovery_required`.

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
  'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';

export type AccountBankSyncOutcomeCode =
  | 'succeeded'
  | 'no-new-transactions'
  | 'authentication-required'
  | 'rate-limited'
  | 'timed-out'
  | 'configuration-error'
  | 'provider-error'
  | 'final-sync-failed';

export type JobRunSummary = Readonly<{
  id: string;
  kind: 'bank-sync';
  status: JobRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  accountResults: readonly Readonly<{
    accountId: string;
    outcomeCode: AccountBankSyncOutcomeCode;
    addedCount: number;
    updatedCount: number;
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
  sections: readonly ('accounts' | 'payees' | 'categories' | 'transactions')[];
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
  addedCount: number;
  updatedCount: number;
  finalSyncCode: 'succeeded' | 'failed';
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

The adapter rejects duplicate/unknown sections, more than 90 days in an
unpaginated transaction range, an empty account ID, an unsupported target kind,
and any unknown property. It owns AQL construction; callers cannot submit AQL,
SQL, field lists, file paths, API method names, or arbitrary JSON patches.

### Allowlisted result fields

The adapter converts Actual objects to companion-owned DTOs before worker IPC.
Only these fields may cross:

| DTO              | Fields                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget metadata  | binding hash, ISO currency, Actual sync status, snapshot timestamp                                                                                             |
| Account          | ID, name, on/off-budget, closed, sync source, last sync, redacted sync status                                                                                  |
| Payee            | ID, name, transfer-account ID                                                                                                                                  |
| Category/group   | ID, name, group ID, income/hidden flags                                                                                                                        |
| Transaction      | ID, account/parent/transfer IDs, date, integer amount, payee/category IDs, notes, imported ID/payee, cleared/reconciled/split/starting-balance/tombstone flags |
| Target graph     | target plus required split children and a server-derived version hash                                                                                          |
| Bank-sync result | account ID, started/completed timestamps, stable outcome code, added/updated counts, final sync code                                                           |

Notes and merchant/item text are sensitive and are never logged. Raw provider
responses, credentials, account numbers, bank IDs, SQL errors, and Actual
working-directory paths never cross worker IPC.

Rule and schedule reads are intentionally absent from this first adapter union.
FIN-22 and FIN-33 must add separately reviewed, closed read DTOs before their
implementation tickets need those objects. They may not widen this contract to
raw API responses or caller-supplied queries.

### Worker lifecycle

`adapter-queue.ts` implements a dependency-free FIFO promise queue with
concurrency one. Every HTTP read, review refresh, import lookup, detector,
scheduled job, backup adapter call, and future write uses it.

For each dequeued request the parent:

1. creates an opaque operation ID and a unique child directory under
   `<ACTUAL_API_DIR>/operations`;
2. forks `adapter-worker-entry.ts` with an IPC channel and an explicit minimal
   environment allowlist rather than inheriting the service environment,
   passing secrets through a one-time IPC message rather than command-line
   arguments;
3. waits for the child to acquire the directory lock and verify ownership;
4. sends one validated `ActualAdapterRequest`;
5. accepts one validated terminal result;
6. waits for the worker's `shutdown-complete` message and process exit; and
7. releases the queue slot only after exit is proven.

The worker owns this closed lifecycle:

1. acquire the cross-process lock;
2. verify the root ownership marker;
3. initialize `@actual-app/api` with the operation directory;
4. download/open only the configured budget;
5. verify budget binding and currency;
6. perform the one allowlisted request;
7. for account bank sync, call account-scoped `runBankSync`, then `sync`;
8. on every normal/error path, await `shutdown`;
9. release the lock; and
10. exit.

`sync` and `shutdown` are lifecycle steps, not caller-selectable operations.
The worker handles no second request.

At the soft deadline the parent reports a pending timeout state but does not
release any guard. At the hard deadline it requests graceful termination, then
terminates the child. It waits up to
`FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS` for process exit. Only after exit may
it rename the operation directory into quarantine and verify/reclaim a stale
lock. If exit, quarantine, or lock state cannot be proven, service health
becomes `unhealthy`, the queue closes permanently for that process, and no new
adapter operation starts.

Read-only quarantines receive a redacted manifest and may be removed by a
tested retention job after no write receipt references them. A future write
quarantine is receipt-named and follows the durable retention rules in
`data-model.md`.

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

The stable owner credential is 32 or more random bytes and at most 1024 bytes.
Its Argon2id hash uses at least 64 MiB memory, three iterations, parallelism one,
and a per-hash random salt. Login is protected by one process-global token
bucket: burst five, refill one attempt per minute. Verification always runs
against a real or fixed dummy Argon2id hash to reduce account/state timing
leakage.

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
unknown fields. The request stream is bounded before buffering. General
mutating routes accept only `application/json; charset=utf-8` with a 256 KiB
limit.

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
- the SHA-256 hash of versioned RFC 8785 canonical JSON for the validated
  semantic request.

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

Stored response JSON is rebuilt from a route-specific allowlist and cannot
contain credentials, session/CSRF tokens, raw uploads, notes/item titles,
account numbers, exception text, SQL, or host paths.

## Backup, restore, and integrity interfaces

The service must be stopped or in an exclusive maintenance state. Scheduler
invocations and new HTTP work are refused during maintenance.

```ts
export type BackupMode = 'companion-only' | 'paired';

export type CreateBackupRequest = Readonly<{
  mode: BackupMode;
  destinationDirectory: string;
  actualArtifacts?: readonly Readonly<{
    kind: 'export' | 'snapshot';
    path: string;
  }>[];
}>;

export type VerifiedBackupManifestV1 = Readonly<{
  formatVersion: 1;
  mode: BackupMode;
  budgetKeyHash: string;
  budgetCurrencyCode: string;
  schemaVersion: number;
  companionDatabaseHash: string;
  actualArtifacts: readonly Readonly<{
    kind: 'export' | 'snapshot';
    hash: string;
  }>[];
  preBackupAnchorHash: string;
  highestIssuedIntentSequence: number;
  highestIssuedIntentHash: string | null;
  highestAppliedReceiptSequence: number;
  highestAppliedReceiptHash: string | null;
  unresolvedQuarantineHashes: readonly string[];
  createdAt: string;
}>;
```

Paths are local CLI inputs and never HTTP fields or manifest values. Manifest
entries contain hashes and logical kinds only.

When writes have never been enabled, `companion-only`:

1. owns the queue and companion lock;
2. verifies the generation-zero anchor;
3. checkpoints through the SQLite online backup API or `VACUUM INTO`;
4. hashes and verifies the resulting database and pre-backup anchor; and
5. writes an authenticated manifest to the protected destination.

Once writes are or have been enabled, `companion-only` is rejected. `paired`
must additionally own the future remote fence, call Actual `sync` inside the
already-owned adapter lifecycle, capture verified Actual export/snapshot
artifacts, include unresolved write quarantines, finalize and encrypt the set,
then atomically advance
`lastVerifiedPairedBackupManifestHash`. The manifest binds the pre-advance
anchor and never embeds the post-advance anchor, preventing a circular hash.

Restore runs offline into new staging paths. It verifies every hash, schema
version, budget/currency binding, anchor MAC, issued/applied chains, quarantine,
and write-era rule before atomically selecting the staged set. A write-era
restore is paired only and reconstructs the one documented post-finalization
anchor advance. Failure leaves the original paths untouched. Restore never
copies the MAC key and never treats a database-only rollback as valid after
writes.

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

Detailed authenticated health distinguishes:

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
- the live FIN-10 through FIN-14 tickets match this contract; and
- no secret, personal data, host-specific path, raw statement, generated
  database, or non-English user-facing content is present.
