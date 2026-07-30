# FIN-2 agent handoff

## Ticket

- Linear: FIN-2, **Investigate Actual Budget capabilities and relevant upstream
  decisions**
- Work type: read-only repository and upstream research
- Parent branch at assignment: `integration/finance-app`
- Research start commit: `822fbe3f96af21f276f3f41d686c796ddcd84285`
- Research end commit: `822fbe3f96af21f276f3f41d686c796ddcd84285`
- Documentation branch: `research/FIN-2-capability-assessment`
- Pull request: <https://github.com/FPynk/actual/pull/2>

The requested `gpt-5.6-lunar` model was not available in this environment.
All three research assignments used `gpt-5.6-terra` with high reasoning as the
closest cheaper available model. The lead agent retained architecture,
security, financial-integrity, and final recommendation decisions.

## `/root/fin2_import_sync_research`

- Agent identifier: `/root/fin2_import_sync_research`
- Model: `gpt-5.6-terra`, high reasoning
- Scope: statement parsers, normalized imports, reconciliation, bank providers,
  SimpleFIN, pending/posted behavior, deduplication, and security boundaries
- Files changed: none
- Tests run: none; read-only assignment

### Principal files inspected

- `packages/loot-core/src/server/transactions/import/parse-file.ts`
- `packages/loot-core/src/server/transactions/import/parse-file.test.ts`
- `packages/loot-core/src/server/transactions/import/ofx2json.test.ts`
- `packages/desktop-client/src/components/modals/ImportTransactionsModal`
- `packages/loot-core/src/server/accounts/sync.ts`
- `packages/loot-core/src/server/accounts/sync.test.ts`
- `packages/loot-core/src/server/accounts/app.ts`
- `packages/loot-core/src/types/models/import-transaction.ts`
- `packages/loot-core/src/types/models/bank-sync.ts`
- `packages/api/methods.ts`
- `packages/cli/src/commands/server.ts`
- `packages/sync-server/src/app-simplefin/app-simplefin.js`
- `packages/sync-server/src/app-simplefin/app-simplefin.test.js`
- `packages/sync-server/src/services/secrets-service.js`
- `packages/loot-core/migrations/1608652596044_trans_views.sql`

### Summary

The agent verified CSV/TSV, QIF, OFX/QFX, and CAMT transaction parsing; a common
`ImportTransactionEntity`; and a shared account-scoped reconciliation path for
file and bank imports. It identified the exact-ID then amount/date/payee match
order, strict identifier guard for file/API imports, relaxed guard for bank
sync, field-preservation behavior, reconciled-row lock, deleted-row preference,
five bank providers, full SimpleFIN integration, and API/CLI sync entry points.

It found no internal scheduler. It identified open same-batch ID duplication,
fuzzy collision, changed-ID pending/posted, source namespace, and stale raw
provider-data risks. It also flagged that bank credentials are outside budget
end-to-end encryption and that debug secret logging is unsafe.

### Assumptions and limitations

- Behavior was inferred from source and tests rather than executing provider
  integrations.
- Provider availability and payload stability were not verified against live
  financial institutions.
- No statement containing real financial data was inspected.
- CAMT pending semantics and QIF category mapping remain areas for focused
  fixture validation.

### Problems encountered and follow-ups

No execution blocker. Recommended follow-ups were same-batch exact-ID tests,
changed-ID pending/posted tests, cross-source overlap tests, and a scheduler
around the supported API/CLI.

## `/root/fin2_rules_reports_research`

- Agent identifier: `/root/fin2_rules_reports_research`
- Model: `gpt-5.6-terra`, high reasoning
- Scope: categories, payees, rules, learning, reports, schedules, subscriptions,
  splits, and user-facing state handling
- Files changed: none
- Tests run: none; read-only assignment

### Principal files inspected

- `packages/loot-core/src/types/models/rule.ts`
- `packages/loot-core/src/server/transactions/transaction-rules.ts`
- `packages/loot-core/src/server/transactions/transaction-rules.test.ts`
- `packages/loot-core/src/server/rules/app.ts`
- `packages/loot-core/src/server/payees/app.ts`
- `packages/desktop-client/src/components/ManageRules.tsx`
- `packages/desktop-client/src/components/reports/ReportOptions.ts`
- `packages/desktop-client/src/components/reports/reportRanges.ts`
- `packages/desktop-client/src/components/reports/spreadsheets`
- `packages/loot-core/src/types/models/schedule.ts`
- `packages/loot-core/src/server/schedules/find-schedules.ts`
- `packages/loot-core/src/shared/schedules.test.ts`
- `packages/desktop-client/e2e/reports.test.ts`
- `packages/desktop-client/e2e/rules.test.ts`
- `packages/desktop-client/e2e/schedules.mobile.test.ts`

### Summary

The agent verified ordered pre/normal/post transaction rules, imported-payee
rename rules, deterministic category learning, arbitrary and live report ranges,
daily/weekly/monthly/yearly report intervals, category/payee grouping, split
support, and schedule discovery.

It established that total, category, payee, and average-per-month reporting
already exists. General average-per-day/week, transaction median,
month-over-month summary, and rolling-30-day series do not. It identified
Schedules and Find Schedules as the correct base for subscription candidates,
while noting missing quarterly/annual discovery, aliases, confidence, price
changes, pauses, and bill/subscription type.

### Assumptions and limitations

- No UI workflow was executed by the agent; the lead performed separate browser
  baseline verification.
- Multi-currency was treated as missing because no per-account or
  per-transaction currency/FX model was found.
- Report error and accessibility findings were a focused source review, not a
  complete accessibility audit.

### Problems encountered and follow-ups

No execution blocker. Recommended follow-ups were semantic fixtures for
transfers, refunds, credit-card payments, and splits; explicit error state in
new reports; and reuse of schedule discovery instead of a separate recurring
ledger.

## `/root/fin2_platform_research`

- Agent identifier: `/root/fin2_platform_research`
- Model: `gpt-5.6-terra`, high reasoning
- Scope: monorepo boundaries, database ownership, migrations, API/CLI,
  authentication, synchronization, plugins, testing, Docker, backup, and Ubuntu
  readiness
- Files changed: none
- Tests run: none; read-only assignment

### Principal files inspected

- `package.json`
- `lage.config.js`
- `packages/docs/docs/contributing/project-details/architecture.md`
- `packages/docs/docs/contributing/project-details/database.md`
- `packages/docs/docs/contributing/project-details/migrations.md`
- `packages/loot-core/src/server/migrate/migrations.ts`
- `packages/loot-core/src/server/update.ts`
- `packages/sync-server/src/account-db.js`
- `packages/sync-server/src/sync-simple.js`
- `packages/sync-server/src/app-sync.ts`
- `packages/api/index.ts`
- `packages/api/methods.ts`
- `packages/api/methods.test.ts`
- `packages/cli`
- `packages/sync-server/src/accounts/password.js`
- `packages/sync-server/src/load-config.js`
- `packages/desktop-client/src/components/settings/Experimental.tsx`
- `.github/workflows/check.yml`
- `.github/workflows/build.yml`
- `packages/sync-server/docker-compose.yml`
- `packages/docs/docs/install/docker.md`
- `packages/docs/docs/backup-restore`

### Summary

The agent established `loot-core` as the authoritative ledger boundary, the
sync server as transport/auth/provider infrastructure, and `@actual-app/api`
plus the CLI as the supported companion interfaces. It verified that direct
SQLite writes would bypass Actual's models, mutators, AQL, migrations, and sync
coordination, while internal sync-protocol use would bypass the supported API
contract. Encryption consequences depend on the specific storage path, so no
direct path is an approved extension seam.

It documented local SQLite ownership, server persistence, Argon2id login,
password/header/OpenID configuration, E2E limitations, experimental plugin
status, Ubuntu-focused CI, Windows Bash constraints, the official Docker
service layout, port 5006, `/data`, health checks, reverse-proxy requirements,
and the need for external homelab backups and rollback planning.

### Assumptions and limitations

- Docker daemon access and WSL distribution access were unavailable, so
  deployment-readiness conclusions came from repository evidence rather than a
  running container.
- No clearly scoped service account for a companion was found; the design must
  assume a single-user trusted automation boundary or add a separate security
  design.
- The plugin service was treated as experimental because its UI control is
  disabled.

### Problems encountered and follow-ups

No research blocker. Recommended follow-ups were to use API/CLI only, keep the
companion database non-authoritative, use permission-restricted secrets, pin
container versions, and test backup/restore before homelab deployment.

## Lead review and disposition

The lead agent cross-checked the findings against source, baseline execution,
and upstream issues/pull requests. The accepted decisions are:

1. Actual remains the only financial ledger owner.
2. Existing imports, rules, reports, schedules, splits, and bank providers are
   reused.
3. Exact reconciliation defects require narrow, test-first Actual changes.
4. Scheduling and derived review/enrichment data belong in a companion service
   using only API/CLI.
5. Duplicate thresholds, security, migrations, and final integration remain
   lead-owned.

The synthesized deliverables are:

- `docs/project/current-capabilities.md`
- `docs/project/gap-analysis.md`
