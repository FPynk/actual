# Personal Finance App test strategy

## Objectives

Tests must protect:

1. financial-data integrity;
2. upstream compatibility;
3. deterministic and explainable review behavior;
4. secret and personal-data boundaries;
5. Windows local development; and
6. future Ubuntu homelab readiness.

No test may use a real statement, account, order, email, provider credential, or
personal identifier.

## Baseline

The unmodified baseline is recorded in
`docs/project/development-baseline.md`.

At the starting commit:

- formatting passed;
- type checking passed;
- the production browser build passed through Git Bash;
- the synthetic demo UI worked without browser console errors;
- lint reported two Windows parent-import findings; and
- the test suite had two deterministic Windows SQLite teardown failures in
  `packages/loot-core/src/server/main.test.ts`.

The first compatibility ticket must eliminate those recorded development
failures. A project PR may not hide a baseline failure by changing an expected
result, skipping a test, or weakening a lint rule without a separate approved
reason.

## Test layers

| Layer                           | Purpose                                                               | Typical location                                                                     |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Pure unit                       | Parsing helpers, normalization, metrics, scoring, cadence, allocation | Existing package `*.test.ts`; proposed `packages/finance-companion/src/**/*.test.ts` |
| Database unit                   | Constraints, migration behavior, stale/version checks, idempotency    | Companion test database; tests under `packages/loot-core/src/server`                 |
| Fixture integration             | End-to-end parser-to-normalized-record behavior                       | Existing import fixtures and proposed synthetic companion fixtures                   |
| Actual adapter integration      | Supported API calls against an isolated synthetic budget              | `packages/api` patterns and companion adapter tests                                  |
| Provider integration with mocks | Scheduling, retries, pending/posted normalization, redaction          | Existing sync-server/core mocks; no live network                                     |
| Component/UI                    | Loading, empty, error, stale, success, keyboard interaction           | React Testing Library and existing component conventions                             |
| Browser E2E                     | User review and approval workflows                                    | Playwright in `packages/desktop-client/e2e` or the companion package                 |
| Visual regression               | Actual-style responsive states                                        | Existing VRT workflow where the screen is stable                                     |
| Build/deployment smoke          | Production bundles, health checks, migrations, backup/restore         | Windows local commands and Ubuntu CI/container job                                   |

The smallest relevant layer is required for each behavior. E2E tests do not
replace unit tests for financial calculations.

## Planned companion command contract

The implementation package is named `@actual-app/finance-companion` and is
discovered by the existing `packages/*` workspace. Its `package.json` must
provide these scripts before the package skeleton is accepted:

| Script            | Purpose                                            | Repository-root invocation                                         |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `build`           | Production service and UI bundle                   | `yarn workspace @actual-app/finance-companion run build`           |
| `typecheck`       | Package TypeScript validation                      | `yarn workspace @actual-app/finance-companion run typecheck`       |
| `test`            | Deterministic unit/component tests                 | `yarn workspace @actual-app/finance-companion run test`            |
| `test:db`         | Migrations, constraints, retention, recovery       | `yarn workspace @actual-app/finance-companion run test:db`         |
| `test:adapter`    | Isolated Actual API adapter integration            | `yarn workspace @actual-app/finance-companion run test:adapter`    |
| `test:e2e`        | Production-build browser workflows                 | `yarn workspace @actual-app/finance-companion run test:e2e`        |
| `start`           | Loopback-only local service/UI                     | `yarn workspace @actual-app/finance-companion run start`           |
| `smoke:container` | Non-root image, volume, health, and shutdown smoke | `yarn workspace @actual-app/finance-companion run smoke:container` |

The package `build`, `typecheck`, and `test` tasks are registered with the
repository's Lage configuration so root `yarn build`, `yarn typecheck`, and
`yarn test` include them. The specialized database, adapter, E2E, and container
commands remain explicit release gates. Every script must run from PowerShell
and Git Bash and from a repository path containing spaces.

## Synthetic-data policy

All fixtures use clearly fictional values:

- account names such as `Synthetic Checking`;
- payees such as `Example Market` and `Example Streaming`;
- domains reserved for documentation;
- order IDs such as `SYNTH-ORDER-0001`;
- deterministic UUIDs where supported;
- fixed dates independent of today's date unless a live-range test supplies an
  explicit clock;
- integer minor-unit amounts; and
- message bodies authored specifically for this repository.

Fixture rules:

1. No copied or lightly redacted personal source data.
2. No production log excerpts.
3. No real bank routing/account numbers.
4. No real Amazon order or shipment IDs.
5. No real email addresses, addresses, item history, or tracking numbers.
6. Parser fixtures state their schema/adapter version.
7. Snapshots are reviewed for accidental paths, tokens, and host/user names.
8. Randomized cases use a committed seed and print it on failure.

A reusable synthetic scenario builder should create accounts, payees,
categories, transactions, schedules, and split parents without committing a
generated SQLite database.

## Unit-test strategy

### Money and date calculations

Every calculation:

- accepts integer amounts;
- states whether expense is represented as negative or positive magnitude;
- handles empty input;
- uses an explicit inclusive/exclusive date interval;
- injects the current date/clock;
- avoids floating-point money; and
- tests boundary dates and leap years.

### Fingerprints and source identity

Tests distinguish:

- stable external identity;
- source namespace;
- account hard gate;
- fingerprint version; and
- non-unique fuzzy evidence.

At least two legitimate transactions must deliberately share account, amount,
merchant, and date and still receive distinct source records.

### Candidate scoring

Table-driven tests assert both score and reason codes. A score test also asserts
that no mutation occurs. Competing candidates, reconciled rows, and changed
target hashes must lower eligibility or block approval as designed.

### Metrics

The metric module tests:

- total expense;
- average per calendar day over partial and full ranges;
- average per seven-day week using the documented denominator;
- average per month with partial-month semantics;
- median for odd and even transaction counts;
- month-over-month absolute and percentage change;
- zero prior-month behavior without divide-by-zero;
- rolling 30-day windows at the start/end of data;
- refunds;
- transfers and credit-card payments;
- split parents/children; and
- unsupported currency mismatch.

## Import fixture tests

Existing parser coverage remains in:

- `packages/loot-core/src/server/transactions/import/parse-file.test.ts`;
- `packages/loot-core/src/server/transactions/import/ofx2json.test.ts`; and
- `packages/loot-core/src/server/accounts/sync.test.ts`.

Add synthetic fixtures only for behavior under change:

| Fixture                       | Required assertions                                                 |
| ----------------------------- | ------------------------------------------------------------------- |
| OFX/QFX                       | `FITID`, date, amount, payee/notes, stable repeat identity          |
| CSV debit/credit columns      | Mapping, sign, date format, row ordering                            |
| CSV single amount             | Positive/negative normalization                                     |
| TSV                           | Delimiter and quoted text                                           |
| QIF                           | Weak/no source ID is explicit                                       |
| CAMT                          | `AcctSvcrRef`, amount, date, payee, unknown booking behavior        |
| Statement currency mismatch   | Rejected before candidates against the bound budget currency        |
| Malformed row                 | Redacted error with row number, no partial silent apply             |
| Identical duplicate ID rows   | One normalized row and a deterministic duplicate result             |
| Conflicting duplicate ID rows | No mutation for that identity group and an explicit conflict result |
| Same bytes twice in companion | Existing import receipt returned                                    |
| New parser version            | Same bytes may be reparsed without silently applying twice          |

No parser test writes a raw source payload into a snapshot unless that payload
is entirely synthetic and necessary.

## Duplicate and reconciliation matrix

Each case asserts added IDs, updated IDs, ignored/review candidates, preserved
fields, cleared/reconciled behavior, and idempotent rerun.

The authoritative case definitions, result codes, and exact FIN-16/FIN-17 test
ownership are frozen in
[`transaction-identity-contract.md`](transaction-identity-contract.md).

| Scenario                                                | Expected result                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Same OFX file imported twice                            | One ledger transaction per stable ID; rerun is ignored/update-only                      |
| Normalized-identical stable ID twice in one batch       | One add and one deterministic duplicate result                                          |
| Same stable ID with conflicting normalized fields       | Zero mutation for that ID group and an explicit conflict/review result                  |
| More than one existing row for `(account, imported_id)` | Mutation is blocked; no arbitrary first row is selected                                 |
| Mixed batch with one conflicting ID group               | Conflict group is quarantined; unaffected identity groups proceed with explicit results |
| Two partially overlapping statements with IDs           | Overlap matches exactly; non-overlap adds                                               |
| Two partially overlapping CSV statements without IDs    | Ambiguous overlap is shown/reviewed; no permanent fuzzy uniqueness                      |
| Statement and bank sync share a companion namespace     | No cross-source exact match; native identity remains `(account, imported_id)`           |
| Statement and bank sync have only fuzzy similarity      | Candidate/review; no new automatic project merge                                        |
| Pending then posted with same ID                        | Eligible unreconciled row may promote; cleared is never demoted                         |
| Pending then posted with changed ID                     | Separate identity and review; no inferred automatic continuity                          |
| Reconciled pending row receives posted match            | Existing row is not mutated; review explains the lock                                   |
| Manual transaction then imported row                    | User payee/category/notes remain; cleared may promote; no duplicate if unambiguous      |
| Same amount and merchant twice on one day               | Both legitimate purchases survive                                                       |
| Same date/amount/merchant in different accounts         | Never match                                                                             |
| Existing identified file row and different incoming ID  | Strict file/API check prevents fuzzy match                                              |
| Existing deleted row with reimport disabled/enabled     | Existing preference behavior remains covered                                            |
| Existing split parent then imported match               | Split categories/children remain correct and sums balance                               |

The same-batch fix must first fail a regression test on the upstream baseline
and pass only after the focused implementation. Tests also assert that
companion source namespaces never strengthen Actual's initial native exact
identity.

## Bank-sync tests with mocks

No test contacts SimpleFIN or another provider.

Existing provider normalization and SSRF tests remain authoritative. New
scheduler tests mock the Actual adapter and assert:

- one process-global adapter operation at a time;
- a companion-owned cross-process lock for its dedicated API data directory;
- a second participating companion is refused, while raw CLI/API separation is
  tested as a configuration/ownership invariant;
- linked-account enumeration followed by sequential
  `runBankSync({ accountId })` calls;
- the scheduled path never calls no-argument `runBankSync()`;
- initialization, per-account bank sync, final `sync`, and `shutdown` call
  order;
- normal failure calls `shutdown` and completes it before worker exit/guard
  release;
- a hard deadline terminates and joins the worker before queue release,
  quarantines its operation directory, and reclaims only a proven stale lock;
- inability to confirm worker exit leaves the service unhealthy and starts no
  new operation;
- retryable versus non-retryable errors;
- exponential retry cap and deterministic injected jitter;
- continued processing after one account fails;
- explicit succeeded, failed, skipped, and canceled per-account results;
- hard-kill after provider work begins records `outcome_unknown`, retains the
  job-bound quarantine, blocks automatic retry/companion-only backup, and
  requires the explicit unknown-effects resolution flow;
- every ordered account has a durable pre-worker child row binding its account
  ID, worker-operation UUID, ordinal, and exact expected quarantine root;
- startup rejects a missing expected root, unregistered lookalike, substituted
  marker/account, duplicate ordinal, and quarantine bundle hash mismatch;
- operation markers reject missing, duplicate, nested, non-regular, malformed,
  noncanonical, wrong-version, unknown-field, wrong-root-kind, and
  instance/binding/job/worker/account/receipt mismatches;
- a crash after durable quarantine but before the child-row hash update recovers
  only the exact marker-bound root and stores its stable canonical bundle hash;
- deterministic partial-account summary and exit code;
- idempotency bound to the versioned endpoint/command operation, budget,
  principal, and canonical request, with stored replay behavior;
- no credential/provider payload in logs;
- process exit code for success, partial, configuration failure, and transient
  failure.

Pending/posted provider normalization remains a core test concern, not a
scheduler reimplementation.

## Classification and merchant tests

Tests preserve Actual's existing rule behavior and add:

- alias proposal from several imported-payee variants;
- no proposal when aliases conflict across canonical payees;
- initial approval records a decision and leaves Actual unchanged;
- rejection prevents immediate reproposal;
- stale canonical payee blocks even a decision from being presented as
  actionable;
- `categorize_once` does not create a rule;
- `create_rule` requires explicit approval;
- the later rule-write capability proves it cannot rewrite reconciled history
  or lose an intervening remote-client rule edit before tests expect rule
  creation;
- target transaction/category deletion causes stale status;
- existing category learning thresholds remain unchanged; and
- a previously reviewed transaction is not silently recategorized.

## Subscription-detection tests

All dates use an injected clock.

| Scenario                                   | Expected evidence                                               |
| ------------------------------------------ | --------------------------------------------------------------- |
| Stable monthly subscription                | Monthly cadence, low amount/date variance, high review priority |
| Monthly household bill with varying amount | Monthly cadence, bill type remains user choice, variance reason |
| Weekly recurring charge                    | Weekly cadence                                                  |
| Quarterly bill                             | Quarterly cadence                                               |
| Annual renewal                             | Annual cadence                                                  |
| Merchant with irregular purchases          | Low confidence or no candidate                                  |
| Subscription price increase                | Price-change reason without breaking cadence                    |
| Paused and resumed subscription            | Gap reason; remains reviewable                                  |
| Two cadences at one payee                  | Separate signatures or ambiguous candidate                      |
| Rejected candidate                         | Suppressed until policy/version reset                           |
| Existing Actual schedule                   | Candidate links rather than duplicates                          |

Tests assert occurrence count, first/last dates, median amount, variance,
cadence, reason codes, and status. Confidence does not automatically create a
schedule. Initial approval records the decision and leaves Actual unchanged. A
separate schedule-write capability suite is enabled only after its supported
operation, stale behavior, reconciled-derived read-only rule, and idempotency
contract are approved. It also races an intervening remote-client schedule edit
and must conflict rather than overwrite or duplicate it.

## Amazon parser and matching tests

Parser tests use versioned synthetic CSV/JSON-like export fixtures and `.eml`
messages authored for the test suite.

Required scenarios:

| Scenario                                  | Expected behavior                                          |
| ----------------------------------------- | ---------------------------------------------------------- |
| One order, one item, one charge           | Exact signed transaction-to-item candidate                 |
| One order, two shipments, two charges     | Many-to-many allocations balance per transaction and item  |
| Multiple items with different categories  | Suggested splits equal each parent amount                  |
| Partial gift-card payment                 | Explicit order adjustment explains bank/card remainder     |
| Tax, shipping, discount, and rounding     | Explicit signed components; no hidden remainder            |
| Partial refund                            | Canonical refund and positive Actual allocation candidate  |
| One charge covering multiple orders       | Direct allocation edges cover both orders                  |
| Multiple charges for one order            | Shared candidate; application progress is per parent       |
| Several plausible orders                  | Competing candidates require selection                     |
| Charge with no order                      | Unmatched state, no mutation                               |
| Order with no charge                      | Unmatched order state                                      |
| Currency mismatch                         | Decision is non-actionable                                 |
| Same export twice                         | Existing receipt/canonical entities returned               |
| Same data through export and email        | Canonical children upsert; both observations retained      |
| Reparse under a new parser version        | New observations, no duplicate canonical children or apply |
| Conflicting canonical observation         | Explicit conflict; no silent canonical overwrite           |
| Crash after receipt, before normalization | Resume on resubmission; no normalized children             |
| Crash during canonical/observation write  | Complete rollback; retry creates one canonical graph       |
| Crash after commit, before response       | Retry returns the committed receipt and canonical graph    |
| Stale or reconciled Actual charge         | Candidate/apply is blocked                                 |
| Parser failure                            | Raw input removed; redacted diagnostic only                |
| Two candidates consume one item capacity  | At most one applied allocation; the other conflicts        |
| Re-import after sensitive-detail purge    | Applied reservation prevents a second application          |

For every candidate:

- signed direct allocations equal every included Actual charge/refund amount;
- item, refund, and order-adjustment capacities remain within normalized
  source totals after all applied reservations and unresolved holds;
- split proposals equal the Actual parent;
- candidate creation rejects reconciled Actual targets; and
- initial decision approval leaves Actual unchanged and creates no allocation
  reservation.

The post-mutator application suite additionally proves that the idempotency key
prevents repeat application, concurrent capacity claims allow at most one
winner, a stale or reconciled target never changes, and detection does not
create a second note, split, receipt, hold, or capacity reservation. A lost or
unprovable outcome retains its pre-call holds and blocks both the Actual parent
and source capacities until an authoritative outcome resolves it.

A multi-transaction match never uses one receipt for several parents. Tests
apply one balanced parent at a time, expose `partially_applied` group state, and
prove that a conflict on a later parent neither obscures nor repeats an earlier
successful parent.

Tests also assert that logs and API responses exclude raw email bodies, local
paths, addresses, item titles where not required, and source payloads.

## Companion database tests

Each migration is tested against:

1. a fresh empty database;
2. the immediately prior schema version;
3. representative retained/rejected/applied rows;
4. foreign-key enforcement;
5. immutable single-budget binding and account-scoped, namespaced source
   identity;
6. deliberately non-unique fingerprints;
7. transaction rollback after an injected migration failure;
8. checksum mismatch detection; and
9. lock-before-backup ordering and checkpoint-consistent backup/open/integrity
   verification.

Crash injection covers backup creation, migration before commit, migration
after commit but before healthy startup, and restore with the prior
application. Constraint tests cover every state-dependent requirement.

Retention tests cover the 365-day Amazon boundary; deletion blocks for pending
candidates and `applying`, `outcome_unknown`, and `failed_retryable` receipts;
foreign-key cascades; sensitive-title deletion after an applied match;
preserved receipts, unresolved holds, and applied reservations; and re-import
after purge without double application. Repository tests do not commit a
generated database file.

Write-state tests prove that a fresh database is `disabled`, loss or an
unpaired/older restore is `recovery_required`, and no ledger-write endpoint is
available until a paired Actual/companion restore manifest and the complete
receipt/hold/reservation chain plus unresolved write quarantines are verified.
Generation tests require database/anchor equality, a null generation-zero event
hash with an empty event table, contiguous immutable event hashes, an
authenticated referenced paired manifest, and exact one-event database-ahead
completion. Anchor-ahead, gaps, decreases, missing/extra events, unknown
capability IDs, and divergent hashes remain `recovery_required`.
External-anchor cases cover a database one valid receipt ahead after a crash,
database one valid issued intent ahead before the pre-call anchor update,
issued-intent or applied anchor ahead of an older database, missing anchor after
prior writes/intents, divergent chain, wrong budget, and the fail-closed paired
restore gate; once that gate lands, paired restore is the only allowed
write-era rollback. No first call or retry begins until the receipt's
issued-intent chain matches. Retries of an identical receipt and action reverify
the same intent and do not advance the issued sequence; a changed action
requires a new receipt. Backup cases also prove the two-phase order: capture and
hash-bind the pre-backup anchor artifact, finalize the encrypted manifest,
atomically advance the live anchor to that manifest hash, and reconstruct
exactly that transition during restore without copying the MAC
key.

## Actual adapter integration tests

Use an isolated synthetic Actual budget and dedicated temporary data directory.
The adapter test proves:

- a dedicated worker initializes only after the global queue and
  cross-process lock are held;
- account/category/payee queries;
- read-only candidate generation;
- serialized per-account `runBankSync({ accountId })`;
- sync invocation;
- shutdown completion before releasing either guard;
- overlapping HTTP reads, imports, approval checks, and jobs never create two
  active API lifecycles;
- a second participating companion cannot acquire the same data directory;
- normal cancellation/failure releases guards after shutdown;
- hard-deadline worker exit releases OS handles before the operation directory
  is quarantined or the queue advances;
- a hard-killed write worker after local commit but before outcome sync leaves a
  receipt-derived, permission-restricted quarantine that is neither deleted nor
  reused while the receipt is unresolved;
- stale-lock reclamation rejects a live PID/process-start identity and accepts
  only a proven dead owner on local NTFS/ext4-style storage;
- an ownership-marker/configuration mismatch is refused;
- tests document that an arbitrary raw API/CLI process does not participate in
  the lock and that sharing the directory is unsupported operational misuse;
- an initial approval records only a decision/guidance and leaves the Actual
  budget byte-for-byte unchanged; and
- cleanup limited to the created temporary directory.

Tests never write `db.sqlite` directly. The adapter never uses
`batchBudgetUpdates` as an atomic primitive; its batching behavior provides
neither rollback nor compare-and-set protection.

## Conditional Actual-write mutator and receipt recovery gate

These tests do not run against a companion read-then-write implementation.
They become an implementation gate only after P9.1 designs server-owned
conditional transaction, rule, and schedule operations plus their shared
durable-outcome contract.

For a transaction action, the core/API suite must prove that one closed,
allowlisted operation:

- re-reads the authoritative transaction and complete split graph;
- derives and compares the expected target-version hash inside the mutation;
- re-derives the deterministic proposed state, including receipt-derived split
  child IDs, and matches the expected-after hash persisted before the call;
- rejects reconciled targets for reconciliation, category, note, and Amazon
  split actions;
- mutates exactly one parent/split graph per request and receipt;
- validates IDs, action fields, currency, and exact split balance;
- accepts the receipt ID and canonical action hash as the operation identity;
- atomically writes a durable Actual-side committed outcome with the ledger
  mutation;
- returns the stored outcome without a second mutation for the same operation
  ID/hash and rejects the same ID with another hash;
- commits the complete supported change or no change;
- returns the resulting target-version hash and authoritative outcome; and
- cannot accept an arbitrary transaction patch from the client.

Rule and schedule suites prove the same operation-ID/action-hash binding,
atomic authoritative outcome, replay, remote-fence, and lost-response
properties with action-specific before/after versions and deterministic IDs.
They cannot accept an arbitrary rule or schedule patch.

Deterministic race/failure cases include:

1. Two approvals share one expected hash: exactly one applies and one
   conflicts.
2. The target changes or becomes reconciled after candidate creation: no
   companion change applies.
3. Failure is injected after every internal mutation boundary: no partial
   category, note, parent, or split change remains.
4. Replaying a successful request returns the stored allowlisted result and
   performs no second mutation.
5. Another synced Actual client edits before, during, or immediately after the
   local operation: the approved sync-fence/conflict contract detects the edit
   without force-overwrite.
6. The operation commits, its response is lost, and another client edits or
   exactly reverts the target: recovery uses the durable operation outcome,
   never the current target hash, to finalize exactly once.

If pre/post-sync tests cannot prove safe behavior for another Actual client,
the ledger-write capability remains disabled even when local race tests pass.

Cross-database receipt tests persist `applying` before the Actual call and bind
the key to budget, the stable local owner principal rather than an ephemeral
browser session, endpoint/action, and canonical request hash. They crash:

1. after the companion receipt/holds/issued-intent commit but before the
   external anchor advance, proving startup finishes the one valid extension
   and no Actual call starts early;
2. after the issued-intent anchor advances but before the Actual call;
3. after Actual commits but before the receipt update;
4. after local Actual commit but before the outcome is synchronized, with the
   worker hard-killed and its operation directory quarantined;
5. after the receipt is complete; and
6. after process restart before recovery.

A restore to companion state before an anchored unresolved intent—both before
and after an Actual commit/lost response—must find the anchor ahead, enter
`recovery_required`, preserve Actual, and refuse every write.

Recovery reacquires the queue, lock, and approved remote fence, then queries
Actual's durable operation outcome by receipt ID. A matching committed outcome
becomes `applied`; a definitive no-commit result may retry the identical
operation under the same reverified issued intent or become a terminal
conflict. The test asserts that no attempt-level issued sequence is added.
Before/after target hashes remain validation evidence and never establish
outcome by themselves. An unavailable, mismatched, or unprovable outcome
becomes `outcome_unknown`, retains the exact action and Amazon allocation
holds, and blocks the affected target/capacities.
Reusing a key for another request returns a conflict and never replays another
request's response. No ambiguous receipt permits another mutation. A timeout,
lost response, or process death stays `applying`/`outcome_unknown`; only a
definitive server result proving no commit may become `failed_retryable` or
`failed_final`, with the latter also requiring a non-retryable reason.

## UI and accessibility tests

Component tests cover:

- loading label and busy state;
- empty-state explanation and source action;
- populated candidate list;
- score reasons in human language;
- competing candidate selection;
- stale conflict;
- recoverable source/API error and retry;
- disabled approval while invalid;
- explicit confirmation;
- success focus/announcement;
- keyboard traversal and activation;
- dialog focus trap and return;
- responsive narrow layout; and
- absence of raw technical identifiers.

Use semantic queries and accessible names instead of class selectors.

Browser E2E uses a production-like build and synthetic seeded data. It captures
screenshots for UI PRs and checks browser console errors/warnings. Required
flows:

1. Review a merchant alias, record a decision, and verify Actual is unchanged.
2. Review a classification without creating a rule or transaction update.
3. Run or inspect a per-account scheduled bank-sync result using mocks.
4. Review, reject, defer, and decide on subscription candidates without
   creating a schedule.
5. Import a synthetic Amazon source.
6. Resolve a competing Amazon match and inspect balanced proposed splits.
7. Record an Amazon decision and verify Actual is unchanged.
8. Trigger and resolve a stale candidate.
9. Verify a reconciled candidate is non-actionable.
10. Verify missing report metrics over an arbitrary range.

After each matching capability gate passes, separate E2E flows cover explicit
rule creation, schedule creation, one-time category application, and Amazon
split application. Those tests verify the resulting Actual state and
idempotent replay; they are not expectations of the initial read-only
companion.

No destructive confirmation is bypassed in E2E.

## Reporting tests

High-value scenario data includes:

- arbitrary range;
- empty range;
- one-day range;
- partial week and month;
- leap day;
- multiple categories and payees;
- refund;
- on-budget transfer;
- credit-card payment transfer;
- off-budget transaction according to selected report semantics;
- split transaction;
- two identical legitimate expenses;
- zero prior-period expense; and
- a currency-mismatch guard.

Expected values are hand-calculated in fixture descriptions, not copied from
the implementation output.

## Cross-platform matrix

| Environment                   | Required scope                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Windows PowerShell + Git Bash | Install, lint, typecheck, targeted unit tests, production browser build, start from a path containing spaces, synthetic browser smoke |
| Ubuntu CI                     | Lint, typecheck, full unit/integration suite, browser build, companion build/tests, Playwright                                        |
| Ubuntu container smoke        | Actual health, companion health, migration from prior fixture, one mocked job, graceful shutdown                                      |
| Electron where changed        | Desktop E2E for any desktop-specific integration                                                                                      |

Scripts must not assume an unquoted path, global Yarn 1, or `/bin/bash` from
PowerShell. Windows SQLite tests close handles before removing files.

## Security tests

Add focused tests for:

- refusal of every non-loopback bind, including `0.0.0.0`, `::`, a LAN
  address, and a Tailscale address, with no first-release override;
- static UI and API on exactly one configured loopback origin;
- exact `Host` and loopback remote address on every request, including
  DNS-rebinding and alternate-host rejection;
- only minimal health, static login assets, and rate-limited login available
  without authentication;
- high-entropy local credential verification, constant-time failure, and proof
  that the raw credential never enters a URL, browser storage, log, fixture, or
  database;
- no CORS headers on successful, error, or preflight responses;
- exact scheme, host, and port `Origin` required for every mutating request;
- rejection of missing, `null`, mismatched, and cross-origin mutation origins;
- an `HttpOnly`, `SameSite=Strict` local session cookie;
- session-ID rotation at login, idle/absolute expiry, logout revocation, and
  restart invalidation;
- a per-session CSRF token in a custom header, rejecting missing, wrong, and
  cross-session tokens;
- no state-changing `GET`;
- JSON-only mutation content types except the protected upload endpoint;
- environment/secret references never returned by an API;
- log redaction for URLs, authorization headers, tokens, provider payloads,
  email bodies, and local paths;
- authenticated and CSRF-protected upload size, MIME, and content limits;
- parser time/record limits;
- path traversal and archive entry traversal;
- SSRF absence in any future connector;
- SQL parameterization;
- idempotency ownership by budget, stable local owner principal rather than a
  replaceable session, endpoint/action, and
  canonical request hash;
- same-request replay, mismatched-key conflict, concurrent execution-once, and
  allowlisted stored response behavior;
- stale-write conflict;
- backup files receiving restrictive documented permissions.

Run a targeted secret scan on every changed diff when the repository/connector
supports it. If GitHub Advanced Security is unavailable, inspect the diff and
run the repository's available local checks without claiming a passed remote
scan.

## Backup, upgrade, and rollback tests

Before release readiness:

1. Create synthetic Actual and companion data.
2. Pause scheduling, stop new requests, drain the operation queue, and acquire
   the companion lock as one non-recursive backup operation.
3. Acquire the approved remote-write fence or stable sync-version proof, sync
   and export the Actual budget, and open it in an isolated data directory.
4. Create the companion backup with the SQLite online backup API or
   `VACUUM INTO` while WAL activity is possible; prove that copying only the
   live main file is never used.
5. Quiesce Actual and companion services before taking paired `/data` volume
   snapshots, and read the authenticated pre-backup anchor from its distinct
   persistent mount.
6. Copy the authenticated pre-backup anchor artifact, never its MAC key, and
   all unresolved write-operation quarantine artifacts into the encrypted
   backup set. Create a manifest binding the Actual snapshots/exports,
   companion backup hash, schema version, pre-backup anchor artifact hash,
   capability generation/event hash, quarantine/account-operation bindings, and
   the last issued-intent and applied-receipt chain hashes.
   Prove that changing a quarantine bundle's positional archive index changes
   its artifact hash but not its logical-name-independent bundle hash, while a
   substituted bundle/root fails the database child-row binding.
7. Encrypt and finalize the export/snapshots/anchor artifact/manifest, verify
   checksums and restrictive permissions, then atomically advance the live
   anchor's
   `last_verified_paired_backup_manifest_hash` to the finalized manifest hash.
   The manifest never embeds that post-finalization anchor. Restore verifies the
   pre-backup anchor and manifest, then reconstructs this one deterministic
   anchor transition.
8. Upgrade/migrate the companion fixture and verify health, counts, pending
   reviews, receipts, and allocation reservations.
9. Until the remotely fenced paired-restore protocol lands, assert that paired
   restore returns `feature_not_implemented` before key/source access or
   mutation. After that separate release gate lands, restore the matching prior
   images and both old volumes in isolation, then verify the Actual export and
   companion integrity.
10. Restore a matching generation-zero companion-only backup and prove the
    database remains write-disabled with a reconstructed generation-zero
    anchor. Reject companion-only restore into a write-era target and reject
    older or mismatched backups without changing Actual.
11. Reject generation-zero restore before staging when the backup database,
    live database, or Actual API-root owner has a missing or different immutable
    companion instance UUID.
12. Resume scheduling only after paired verification succeeds.
13. Document that applied Actual mutations require Actual-level undo or a
    separately tested compensating action.

Hostile-container tests cover oversized/overflowing header and record lengths,
the aggregate AES-GCM cap, duplicate/missing/undeclared/trailing records,
backslash/drive/UNC names, record-manifest bijection, wrong mode/cardinality,
noncanonical/duplicate/unknown header fields, wrong binary/JSON magic, version,
algorithm, key ID, salt/nonce size, header/manifest backup ID, header/computed/
expected manifest hash, and fixed-size streaming allocation. Quarantine tests
round-trip a canonical directory bundle and reject links, reparse points, hard
links, alternate streams, non-NFC names, excess entries, and byte limits.

Restore crash injection stops before and after every journal replacement,
database main/WAL/SHM member move, directory rename, parent flush, verification,
anchor activation, and cleanup. Recovery must match the frozen
hash-and-existence matrix. A crash in authenticated `preparing` cancels before
live mutation and preserves the complete prior set; after global `prepared`,
recovery converges only to the complete restored set or fails closed for manual
recovery. Tests cover resumable journaled cleanup, journal removal last, and
orphan restore-sibling rejection. They reject extra/missing/duplicated members.
POSIX tests verify UID/modes and no-follow identity; Windows tests verify
protected owner/DACL, stable file ID, reparse/alternate-stream rejection, and
post-open identity revalidation.

A remote-client edit injected before, during, or after export invalidates the
backup set unless the approved fence proves it is outside the captured
snapshot.

Container smoke runs the reviewed image as a fixed non-root UID/GID with a
read-only root filesystem, writable owned `/data`, `/integrity-anchor`, and
`/tmp`, and a read-only MAC-key secret mount that is never captured with the
anchor. It verifies persistence and ownership of the distinct anchor mount, an
internal health check, and graceful shutdown. The first-release homelab smoke
publishes no companion UI port; health is checked inside the container. Remote
serving requires a later authentication design.

## Pull-request validation gates

### Documentation-only

- formatter check on changed documents;
- `git diff --check`;
- cited path/link inspection;
- lead review; and
- no secrets/personal data.

### Core financial behavior

- targeted regression test first;
- relevant package suite;
- `yarn lint`;
- `yarn typecheck`;
- full `yarn test`;
- production browser build when client/core bundling is affected;
- financial-integrity lead review; and
- no unresolved test-generated state.

### Companion service

- companion unit/database/integration suites;
- lint and typecheck;
- production build;
- shutdown/lock/redaction tests;
- Windows and Ubuntu smoke; and
- migration/backup review when schema changes.

### UI

- component and E2E tests;
- accessibility assertions;
- responsive manual check;
- screenshots;
- browser console inspection;
- loading/empty/success/error/stale states; and
- explicit approval behavior.

No PR is merged because a test is "probably unrelated." A pre-existing failure
must be reproduced on the base commit and recorded; a new failure blocks the PR.

## Manual acceptance

After automated checks, the lead verifies the complete changed workflow in a
browser with synthetic data. The handoff records:

- exact build/commit;
- operating system and browser;
- seed/fixture name;
- actions performed;
- screenshots for changed UI;
- console result;
- observed persistence after reload; and
- any limitation.

## Release-readiness definition

The local application is release-ready for homelab preparation only when:

- all applicable validation gates pass on Windows and Ubuntu;
- the upstream baseline defects are fixed or explicitly isolated;
- duplicate, subscription, Amazon, and report scenario matrices pass;
- no secret or personal fixture exists;
- companion migration and restore tests pass;
- Actual export/restore is verified;
- UI workflows pass manual acceptance;
- production browser and companion builds succeed; and
- remaining limitations are documented in the project README.
