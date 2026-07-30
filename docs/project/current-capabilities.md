# Current Actual Budget capabilities

This assessment describes Actual Budget at upstream commit
`822fbe3f96af21f276f3f41d686c796ddcd84285`. Findings were verified in source,
tests, project documentation, the local browser build, and relevant upstream
issues and pull requests. "Existing" means the behavior is available without
this project's custom code; it does not mean every edge case is complete.

## System boundaries

Actual is a local-first monorepo:

- `packages/desktop-client` contains the React/Vite web interface.
- `packages/desktop-electron` packages the client as a desktop application.
- `packages/loot-core` owns budget logic, the local SQLite database, migrations,
  AQL, imports, reconciliation, rules, schedules, and report calculations.
- `packages/sync-server` provides authentication, encrypted budget transport,
  file synchronization, and bank-provider integrations. It is not a general
  ledger REST API.
- `packages/api` is the supported headless JavaScript API.
- `packages/cli` exposes supported API workflows for shell automation.
- `packages/crdt` implements synchronization data structures.

The browser runs the database backend in a Web Worker. Electron runs it in a
Node child process. The documented boundary is
`packages/docs/docs/contributing/project-details/architecture.md`; conditional
platform exports are declared in `packages/loot-core/package.json`.

## Capability matrix

### Accounts

Actual supports on-budget and off-budget accounts, opening balances, account
closure, transfers, linked bank accounts, and account-specific sync/import
preferences.

Evidence:

- Account model: `packages/loot-core/src/types/models/account.ts`
- Account handlers: `packages/loot-core/src/server/accounts/app.ts`
- Sync orchestration: `packages/loot-core/src/server/accounts/sync.ts`
- UI: `packages/desktop-client/src/components/accounts`
- Tests: `packages/loot-core/src/server/accounts/app-bank-sync.test.ts` and
  `packages/loot-core/src/server/accounts/sync.test.ts`

Accounts and transactions do not carry independent currency or exchange-rate
fields. The displayed currency is a budget-wide formatting choice, so true
multi-currency aggregation is not an existing capability.

### Statement and transaction imports

The transaction parser in
`packages/loot-core/src/server/transactions/import/parse-file.ts` supports:

| Input       | Existing behavior                                                           | Stable source identity                           |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| CSV and TSV | User maps date, payee, notes, amount/debit/credit columns in a preview flow | No intrinsic identifier; a caller may supply one |
| QIF         | Parses dates, amounts, payees, notes, and category text                     | No intrinsic identifier                          |
| OFX and QFX | Parses statement transactions and maps `FITID` to `imported_id`             | `FITID` when the institution supplies it         |
| CAMT XML    | Parses bank statement entries                                               | `AcctSvcrRef` when supplied                      |

The desktop workflow is implemented in
`packages/desktop-client/src/components/modals/ImportTransactionsModal`. It
previews mapped rows and sends normalized transactions through the same
reconciliation path used by bank sync. Representative fixtures and parser
coverage are in:

- `packages/loot-core/src/server/transactions/import/parse-file.test.ts`
- `packages/loot-core/src/server/transactions/import/ofx2json.test.ts`
- `packages/desktop-client/e2e/transactions.test.ts`

`ImportTransactionEntity` in
`packages/loot-core/src/types/models/import-transaction.ts` is the maintained
normalization contract. File parsers preserve the imported payee text and
useful notes. Bank-normalized rows can also retain provider JSON in
`raw_synced_data`. PDF statement parsing is not supported and should remain a
fallback rather than the default ingestion path.

Budget-level imports from other applications are separate importers under
`packages/loot-core/src/server/importers`.

### Categorization and payees

Categories, category groups, payees, transaction splits, and manual category
assignment are existing core features. Payees can be merged and can opt in or
out of category learning.

The application can learn a simple payee-to-category rule. When category
learning is enabled, `updateCategoryRules` examines the latest five eligible
transactions for that payee within approximately 180 days. It creates or
updates the rule only when one category receives at least three votes.

Evidence:

- Learning and rule execution:
  `packages/loot-core/src/server/transactions/transaction-rules.ts`
- Transaction save integration:
  `packages/desktop-client/src/components/transactions/TransactionList.tsx`
- Payee management: `packages/loot-core/src/server/payees/app.ts` and
  `packages/desktop-client/src/components/payees`
- Tests:
  `packages/loot-core/src/server/transactions/transaction-rules.test.ts`
- Upstream implementation: merged
  [PR #4081](https://github.com/actualbudget/actual/pull/4081)

Actual does not assign a confidence score to learned categories and does not
provide a dedicated queue for uncertain classifications. Import preview and
ordinary uncategorized transaction workflows provide manual control, but they
are not a confidence-based review system.

### Rules and merchant normalization

The typed rule model in `packages/loot-core/src/types/models/rule.ts` supports
conditions over account, amount, category/group, date and recurrence, payee,
imported payee, notes/tags, saved/cleared/reconciled state, and transfers.
Actions can set transaction fields, create or update split values, link a
schedule, modify notes, or delete a transaction.

`runRules` applies ordered rules across pre, normal, and post stages.
`updatePayeeRenameRule` can create or extend a pre-stage rule that maps multiple
raw `imported_payee` strings to one normalized payee. This already handles
explicit merchant aliases without inventing a second merchant system.

Evidence:

- Engine:
  `packages/loot-core/src/server/transactions/transaction-rules.ts`
- API handlers: `packages/loot-core/src/server/rules/app.ts`
- UI ordering: `packages/desktop-client/src/components/ManageRules.tsx`
- Tests:
  `packages/loot-core/src/server/transactions/transaction-rules.test.ts`
  and `packages/loot-core/src/shared/rules.test.ts`
- Recent payee-resolution behavior: merged
  [PR #8360](https://github.com/actualbudget/actual/pull/8360)

Missing behavior is automatic alias suggestion, confidence, conflict detection
between rename rules, and a review queue that learns from explicit alias
approval.

### Duplicate handling and reconciliation

File imports and bank sync converge on `reconcileTransactions` and
`matchTransactions` in `packages/loot-core/src/server/accounts/sync.ts`.
Matching is account-scoped and follows this order:

1. Match `imported_id` when available.
2. Otherwise search transactions with the same amount in a seven-day date
   tolerance.
3. Prefer a matching payee among those fuzzy candidates.
4. Use the first remaining eligible candidate.

File and API imports normally use strict identifier checking. If both the
incoming and existing transactions have different `imported_id` values, those
rows cannot fuzzy-match; an incoming identified transaction may still
fuzzy-match an existing row with no identifier. Bank-sync accounts disable this
guard because providers can replace identifiers, so their changed-ID rows may
use fuzzy matching.

Existing non-empty user payee, category, and notes values are preserved when an
imported row matches. Cleared state is combined as existing-cleared OR
incoming-cleared, so an import can promote an uncleared row to cleared but does
not clear an already-cleared row. This enables a manually entered transaction
to be updated by a later import. Reconciled transactions are deliberately
locked and skipped, including exact-ID matches. A `reimportDeleted` preference
controls how tombstoned matches are treated.

The persisted public `imported_id` maps to the legacy `financial_id` column
through `packages/loot-core/migrations/1608652596044_trans_views.sql`.
There is no database uniqueness constraint for this value.

Important limitations:

- Duplicate identifiers inside one incoming batch can both be inserted because
  matching queries the database before the pending batch is committed. This is
  open [issue #4280](https://github.com/actualbudget/actual/issues/4280).
- Fuzzy matching can silently combine legitimate same-amount transactions. The
  CSV preview problem is open
  [issue #8464](https://github.com/actualbudget/actual/issues/8464); open WIP
  [PR #8468](https://github.com/actualbudget/actual/pull/8468) proposes pinning
  preview matches.
- Bank sync intentionally relaxes strict identifier handling because providers
  sometimes replace identifiers. If a pending transaction receives a different
  posted identifier, success depends on the fuzzy matcher.
- There is no durable public pending state beyond the provider's `booked` value
  being mapped to `cleared`.
- Cross-source statement/sync identity is not namespaced, and there is no
  uncertainty review queue.
- Matching by amount/date/payee is an operation, not a permanent unique
  constraint, but it can still select the wrong legitimate repeated purchase.

The reconciler has substantial tests in
`packages/loot-core/src/server/accounts/sync.test.ts`, including manually
entered transactions, deleted rows, strict identifiers, and split behavior.
High-value missing tests are same-batch duplicate identifiers, statement versus
provider overlap, changed-ID pending-to-posted, and deliberate identical
purchases.

### Bank and credit-card synchronization

Five provider identifiers are present in
`packages/loot-core/src/types/models/bank-sync.ts`:

- GoCardless
- SimpleFIN
- Pluggy
- Enable Banking
- Akahu

Core orchestration and provider normalization live in
`packages/loot-core/src/server/accounts/sync.ts`. Account linking and status
handlers live in `packages/loot-core/src/server/accounts/app.ts`.
Provider-facing server routes live under
`packages/sync-server/src/app-simplefin`,
`packages/sync-server/src/app-gocardless`,
`packages/sync-server/src/app-pluggyai`,
`packages/sync-server/src/app-enablebanking`, and
`packages/sync-server/src/app-akahu`.

SimpleFIN is a complete implementation in
`packages/sync-server/src/app-simplefin/app-simplefin.js`. It claims a setup
token, stores the resulting access key server-side, downloads accounts and
transactions, includes pending rows, limits redirects, and applies SSRF
preflight checks. Coverage is in
`packages/sync-server/src/app-simplefin/app-simplefin.test.js` and the core sync
tests.

Bank sync can be started through:

- the user interface;
- `runBankSync` in `packages/api/methods.ts`; or
- `actual server bank-sync [--account <id>]` in
  `packages/cli/src/commands/server.ts`.

There is no built-in cron scheduler. The official bank-sync documentation at
`packages/docs/docs/advanced/bank-sync.md` states that bank sync is not
automatic. A homelab scheduler should invoke the supported CLI or API and must
not call provider routes or modify SQLite directly.

Bank credentials live in the sync server's secrets database and are not covered
by budget end-to-end encryption. Provider transaction JSON in
`raw_synced_data` also expands retained financial data. Debug logging in
`packages/sync-server/src/services/secrets-service.js` must never be enabled in
a configuration that could print credential values.

### Reports and expenditure analysis

Custom reports already support:

- static arbitrary start/end dates;
- live presets including current periods, last 30 days, recent months,
  year-to-date, prior year, and all time;
- daily, weekly, monthly, and yearly intervals;
- grouping by category, category group, payee, account, or interval; and
- payment, deposit, net, net payment/deposit, and budgeted totals.

Relevant modules:

- Options and date ranges:
  `packages/desktop-client/src/components/reports/ReportOptions.ts`
- Live range calculation:
  `packages/desktop-client/src/components/reports/reportRanges.ts`
- Query construction:
  `packages/desktop-client/src/components/reports/spreadsheets/makeQuery.ts`
- Custom report data:
  `packages/desktop-client/src/components/reports/spreadsheets/custom-spreadsheet.ts`
- Tests:
  `packages/desktop-client/src/components/reports/reportRanges.test.ts`,
  `packages/desktop-client/src/components/reports/spreadsheets/spending-spreadsheet.test.ts`,
  and `packages/desktop-client/e2e/reports.test.ts`

Metric coverage:

| Requested metric                | Existing support                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Total expenditure               | Existing through payment totals and filters                                                 |
| Category breakdown              | Existing                                                                                    |
| Merchant breakdown              | Existing by payee                                                                           |
| Arbitrary and predefined ranges | Existing                                                                                    |
| Average per month               | Existing in Summary                                                                         |
| Average per transaction         | Existing in Summary                                                                         |
| Average per day                 | Missing as a general arbitrary-range summary metric                                         |
| Average per week                | Missing as a general arbitrary-range summary metric                                         |
| Median transaction size         | Missing; the experimental Crossover report has an unrelated projection median               |
| Month-over-month change         | Partial; Spending Analysis compares a selected month with another month, budget, or average |
| Rolling 30-day spending         | Partial; "Last 30 days" is a live filter, not a rolling time-series metric                  |

Merged [PR #7920](https://github.com/actualbudget/actual/pull/7920) added
configurable average ranges to Monthly Spending. Requests for generalized
average/median tables were closed for voting in
[issue #7695](https://github.com/actualbudget/actual/issues/7695) and
[issue #5148](https://github.com/actualbudget/actual/issues/5148).

Normal on-budget transfers and credit-card payments are transfer pairs rather
than expenditure. Refunds are positive transactions and offset net/category
amounts but have no dedicated refund type. Split transactions are aggregated
through their children. These semantics need explicit fixtures in any new
metric calculation.

### Recurring transactions and subscriptions

Schedules support daily, weekly, monthly, and yearly recurrence, intervals,
date patterns, end modes, weekend handling, approximate or ranged amounts, and
manual or automatic posting.

`findSchedules` in
`packages/loot-core/src/server/schedules/find-schedules.ts` already discovers
weekly, biweekly, and common monthly patterns. It groups by payee and account,
uses approximately 7.5% amount tolerance and two days of date variance, excludes
transfers, and asks the user which candidates to create.

Evidence:

- Model: `packages/loot-core/src/types/models/schedule.ts`
- Discovery: `packages/loot-core/src/server/schedules/find-schedules.ts`
- Handlers: `packages/loot-core/src/server/schedules/app.ts`
- UI: `packages/desktop-client/src/components/schedules`
- Tests: `packages/loot-core/src/shared/schedules.test.ts`,
  `packages/loot-core/src/server/schedules/app.test.ts`, and
  `packages/desktop-client/e2e/schedules.mobile.test.ts`

The discovery algorithm does not identify annual or quarterly candidates,
merchant aliases, price evolution, pauses, confidence, or "optional
subscription" versus "household/financial bill." Upstream
[issue #7458](https://github.com/actualbudget/actual/issues/7458) was closed
with schedules and Find Schedules identified as the existing recurring-expense
workflow.

### Split transactions

Parent and child transactions, split editing, split-producing rules, and
split-aware imports are existing. A matched imported transaction can update a
manually entered split without discarding its categorization. Representative
coverage is in:

- `packages/loot-core/src/server/transactions/transaction-rules.test.ts`
- `packages/loot-core/src/server/accounts/sync.test.ts`
- `packages/desktop-client/e2e/transactions.test.ts`
- Merged [PR #1465](https://github.com/actualbudget/actual/pull/1465)

Splits are an appropriate target for approved Amazon item category suggestions;
they should not be changed silently.

### Supported APIs and automation

`@actual-app/api` is a headless JavaScript interface, not an HTTP REST API.
`init` creates a local backend and can connect it to an Actual server. Supported
methods in `packages/api/methods.ts` include:

- download, sync, shutdown, export, and import budget;
- run bank sync and transaction import;
- accounts, transactions, categories, payees, rules, and schedules;
- AQL query building through `q` and `aqlQuery`; and
- atomic mutation grouping through `batchBudgetUpdates`.

The API is documented in `packages/docs/docs/api/index.md` and tested in
`packages/api/methods.test.ts` and `packages/api/e2e/browser.test.ts`.
The CLI in `packages/cli` is the safest shell-facing scheduler seam.

`addTransactions` does not deduplicate; callers that need reconciliation must
use `importTransactions`, as clarified by closed
[issue #1704](https://github.com/actualbudget/actual/issues/1704).

Direct manipulation of `db.sqlite`, sync files, or internal `/sync` endpoints is
unsupported. The client-side plugin setting is disabled as "soon" in
`packages/desktop-client/src/components/settings/Experimental.tsx`, so the
experimental plugin service is not a stable foundation for this project.

### Authentication and security

The sync server supports password, trusted-header, and OpenID login
configurations. Passwords use Argon2id with bcrypt compatibility and rehashing
in `packages/sync-server/src/accounts/password.js`. Server configuration and
trusted proxy controls are implemented in
`packages/sync-server/src/load-config.js`.

Budget end-to-end encryption protects synchronized budget content from the
server when enabled, but:

- local device databases are not encrypted by Actual;
- a lost encryption password is unrecoverable;
- bank credentials are not budget-E2E encrypted; and
- the API/CLI does not expose a clearly scoped service-account model.

Operational guidance is in:

- `packages/docs/docs/getting-started/sync.md`
- `packages/docs/docs/advanced/bank-sync.md`
- `packages/docs/docs/api/cli.md`
- `packages/docs/docs/config/index.md`

The companion service must use environment variables or an ignored,
permission-restricted local secret file. It must redact connection strings,
tokens, raw email, and provider payloads from logs.

### Local-first storage and synchronization

Each budget is an Actual-owned SQLite database. Migrations live in
`packages/loot-core/migrations`; the runner is
`packages/loot-core/src/server/migrate/migrations.ts`. Startup applies
migrations and regenerates AQL views through
`packages/loot-core/src/server/update.ts`.

The sync server stores:

- account/authentication state and secrets in `server-files/account.sqlite`;
- budget files under `user-files`; and
- CRDT message stores managed by
  `packages/sync-server/src/sync-simple.js`.

Schema changes require a migration, model/AQL updates, test coverage, and an API
version decision. The process is documented in
`packages/docs/docs/contributing/project-details/migrations.md` and
`database.md`.

### Development workflow and testing

The root workspace requires Node 22 or later and pins Yarn 4.17.1. Lage
orchestrates package tasks through `lage.config.js`.

Primary checks are:

- `yarn lint`
- `yarn typecheck`
- `yarn test`
- `yarn e2e`
- `yarn e2e:desktop`
- `yarn vrt`
- `yarn build:browser`

Vitest projects are aggregated by `vitest.config.ts`. Browser E2E uses
Playwright. Ubuntu is the primary continuous-integration environment in
`.github/workflows/check.yml`, `.github/workflows/build.yml`, and
`.github/workflows/api-browser-test.yml`.

Native Windows source development is supported with constraints. The guide at
`packages/docs/docs/contributing/windows.md` requires Git Bash for many scripts.
The verified local baseline and its Windows-specific failures are recorded in
`docs/project/development-baseline.md`.

### Deployment, backup, and recovery

The repository root Docker configuration is for development. The production
example at `packages/sync-server/docker-compose.yml` uses:

- `actualbudget/actual-server`;
- port 5006;
- a persistent `/data` mount;
- a health check; and
- `restart: unless-stopped`.

Installation, reverse-proxy, and configuration guidance is in:

- `packages/docs/docs/install/docker.md`
- `packages/docs/docs/config/index.md`
- `packages/docs/docs/config/reverse-proxies.md`

Manual budget export/import and desktop backups are documented under
`packages/docs/docs/backup-restore`. The server image does not provide a
complete scheduled backup/rollback system. A homelab deployment needs external
volume snapshots plus verified budget exports before upgrades. Deployment
itself remains outside the current project scope.

## Upstream decisions that constrain this project

| Topic                        | Upstream evidence                                                                                                               | Project implication                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Same-batch duplicate IDs     | Open [#4280](https://github.com/actualbudget/actual/issues/4280)                                                                | A narrow exact-ID fix and tests are justified                                       |
| CSV fuzzy merge              | Open [#8464](https://github.com/actualbudget/actual/issues/8464), WIP [#8468](https://github.com/actualbudget/actual/pull/8468) | Avoid competing preview changes until the upstream PR resolves                      |
| Deleted-row reimport         | Merged [#6926](https://github.com/actualbudget/actual/pull/6926)                                                                | Reuse `reimportDeleted`; do not rebuild it                                          |
| Pending/provider ID changes  | Closed [#3762](https://github.com/actualbudget/actual/issues/3762) contains continuing reports                                  | Add explicit regression fixtures before changing semantics                          |
| Category learning            | Merged [#4081](https://github.com/actualbudget/actual/pull/4081)                                                                | Extend the existing rule workflow rather than create a classifier silo              |
| Payee resolution in rules    | Merged [#8360](https://github.com/actualbudget/actual/pull/8360)                                                                | Base merchant normalization on imported-payee rename rules                          |
| Configurable report averages | Merged [#7920](https://github.com/actualbudget/actual/pull/7920)                                                                | Add only missing general metrics                                                    |
| Scheduled bank sync          | Feature request [#3831](https://github.com/actualbudget/actual/issues/3831) closed; community tools use API/CLI                 | Prefer a separate scheduler over a large core fork                                  |
| Subscription overview        | [#7458](https://github.com/actualbudget/actual/issues/7458) closed in favor of schedules                                        | Reuse schedule candidates and add confidence/type metadata outside the ledger first |
| Amazon item import           | [#4616](https://github.com/actualbudget/actual/issues/4616) closed for voting                                                   | Treat as optional companion enrichment with review                                  |

## Reuse conclusion

Actual already provides the ledger, accounts, supported statement parsers,
rules, learned payee categorization, explicit payee normalization, reports,
schedules, splits, bank providers, synchronization, authentication, and a
supported automation API. The project should not replace any of them.

The evidence supports three narrowly separated additions:

1. Small, test-backed Actual fixes where ledger reconciliation itself is
   incomplete.
2. Small report UI/calculation additions for metrics Actual does not expose.
3. A separate local companion for scheduling, confidence/review metadata,
   subscription analysis, and Amazon enrichment, communicating only through the
   supported API/CLI.
