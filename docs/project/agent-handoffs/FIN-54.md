# FIN-54 final project handoff

## Release position

- The release-candidate base is `integration/finance-app` commit
  `c7ce06d2541d1829fd525f673ab6fab53aee6e0c`.
- Project pull requests #1 through #49 are merged into that branch. FIN-52 and
  FIN-53 provide the English user and Ubuntu preparation guides.
- This FIN-54 change adds the final handoff and stabilizes Windows integration
  test timeouts. Record the resulting squash-merge commit in the FIN-54 Linear
  completion comment.
- This snapshot has not been deployed, production-certified, or tested with
  real user data.

## What is implemented

The project adds a local finance companion alongside Actual. Actual remains the
ledger and source of truth. The companion is loopback-only, authenticated, and
uses its own SQLite database and integrity anchor.

Implemented companion capabilities include:

- synthetic workflow fixtures plus focused Windows compatibility fixes;
- a bounded, serialized Actual adapter for allowlisted reads and explicitly
  authorized account bank-sync invocation;
- durable source identities, idempotent request receipts, and explainable,
  read-only reconciliation candidates and review UI;
- deterministic merchant/category proposals, subscription candidates, Amazon
  export and local `.eml` import, Amazon matching/allocation candidates, and
  their review screens;
- finance metric calculations and report UI;
- one-shot bank-sync scheduling behavior with timeout, quarantine, and
  maintenance-lock protections; and
- a generation-zero companion database lifecycle: migrations, authenticated
  companion backup, integrity verification, and staged rollback recovery.

The review and enrichment features store companion metadata and show
candidates; they do not mutate the Actual ledger. The explicitly operated
one-shot bank-sync command is the sole mutating exception: it delegates to
Actual's supported linked-account path and can import transactions into the
configured Actual budget. It uses idempotency, quarantine, and fail-stop
unknown-outcome handling, and must run only with authorization.

## Deliberately not implemented

The write boundary in FIN-42 remains in force. The following are intentionally
disabled or absent:

- companion-created or companion-updated Actual transactions, categories,
  rules, schedules, notes, or splits outside the supported one-shot bank sync;
- write-era backup or restore, paired Actual/companion restore, a remote fence,
  and any bypass of unresolved-outcome quarantine;
- remote exposure, public hosting, automatic deployment, and real user-data
  operation; and
- browser credential scraping, Amazon password storage, and broad mailbox
  access.

`backup:restore` operates only on a verified generation-zero companion
database and its integrity anchor. It does not import, export, alter, or restore
Actual. The staged restore behavior was authorized and tested with synthetic
rollback artifacts only; it must not be run against real user data under this
handoff.

## Final release evidence

FIN-48 added production-build Playwright coverage for desktop and mobile-sized
browser viewports. FIN-51 independently reviewed and closed the final
companion safety findings: unresolved bank-sync outcomes block maintenance and
restore, startup migrations require the verified maintenance lifecycle, Amazon
candidate search is bounded, and health/readiness fails closed.

The post-FIN-52 release candidate passed these Windows checks:

- companion typecheck;
- 43 of 43 test files, with 355 tests passed and four intentional skips;
- companion production build;
- two production-build Chromium E2E scenarios: desktop and `390x844`; and
- focused CLI regression: 15 of 15 tests.

The first two full-suite attempts exposed only default five-second timing
ceilings under concurrent Windows load: one package-script smoke took 6.2
seconds and one synthetic restore test took 5.1 seconds. No assertion failed.
The companion now uses a 15-second integration-test ceiling and a 30-second
ceiling for child-process package gates; the full suite then passed.

The root TypeScript project check passed. The broader workspace `lage
typecheck` did not: linked-worktree resolution surfaced pre-existing strict
TypeScript errors in the upstream `loot-core` source from the shared primary
checkout. The companion typecheck is independently green; no clean monorepo
typecheck is claimed.

Changed-file formatting and `git diff --check` passed. The final diff scan
found no CJK user-facing text, secret signature, personal host path, database,
or generated artifact.

At validation, the integration branch was 49 project commits ahead of and two
commits behind `upstream/master`. The missing upstream changes are the PikaPods
README price update (`98d1cb7e6`) and payee-page `Transfer:` prefix search
(`98ee00e01`). Neither changes the companion contract. Keep deployments pinned
to the recorded integration commit and bring them forward in a normal reviewed
upstream-sync change instead of altering the release candidate during handoff.

## Handoff actions

1. Squash-merge the FIN-54 pull request into `integration/finance-app` and
   record the resulting commit in Linear.
2. Keep write automation, remote exposure, and real-data restore disabled.
3. If an operator authorizes the next stage, deploy the exact integration
   commit only to a private synthetic Ubuntu environment and complete FIN-59
   before making any Linux-runtime or CI claim.

## Known limits and follow-ups

| Follow-up | Scope                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| FIN-57    | Implement executable retention and Amazon data purge. Until then, operators must handle retention manually. |
| FIN-58    | Implement owner credential rotation. The current command is only a placeholder.                             |
| FIN-59    | Add GitHub CI and a verified Ubuntu container smoke test, including a clean-checkout monorepo typecheck.    |

Docker Buildx was unavailable on the Windows host, so no successful Linux
container run was recorded. GitHub check rollups are empty and are not a
substitute for CI. No real database, Actual account, provider credential, or
production deployment was used during this project.

## Release decision

The project is ready to hand off as a local generation-zero companion with
read-only review workflows and an explicitly authorized one-shot bank-sync
exception. It is not approval for companion-authored ledger writes, remote
hosting, real-data restore, or production deployment.
