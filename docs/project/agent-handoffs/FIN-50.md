# FIN-50 handoff

- Agent/model: Codex subagent / GPT-5.6 Terra High
- Ticket: FIN-50 — Verify generation-zero companion backup and restore
- Branch: `feature/FIN-50-generation-zero-restore`
- Start commit: `a62a2299f2c016fdbe7e6edf278872fc0d171ce8`
- End commit: recorded in the Linear handoff after merge because a commit cannot
  embed its own final hash

## Files

- `packages/finance-companion/src/tests/database.test.ts`
- `packages/finance-companion/src/tests/database-safety.test.ts`
- This handoff

## Summary

Adds synthetic-only verification that each injected generation-zero restore
interruption retains a prior database and anchor member at the live or rollback
path. Adds a stale paired-manifest anchor backup refusal and an import-boundary
assertion that the companion-only restore lifecycle neither imports an Actual
adapter nor a mutator.

Existing FIN-11 coverage was reused for the successful create/verify/restore
path, encrypted-backup tampering, missing live anchor, wrong binding/key/
instance/currency, database-anchor mismatch, exclusive maintenance lock,
post-commit cleanup interruption, and integrity verification.

## Tests

- `yarn workspace @actual-app/finance-companion run test:db` — passed: 5 files, 68 tests.
- `yarn workspace @actual-app/finance-companion run typecheck` — passed.
- `yarn workspace @actual-app/finance-companion run build` — passed (two existing ineffective-dynamic-import warnings).
- `yarn oxfmt --check packages/finance-companion/src/tests/database.test.ts packages/finance-companion/src/tests/database-safety.test.ts` — passed.
- `yarn oxlint packages/finance-companion/src/tests/database.test.ts packages/finance-companion/src/tests/database-safety.test.ts` — passed.
- `git diff --check` — passed.

## Assumptions and limitations

- Fixtures are temporary synthetic SQLite databases, generated keys, and fixed
  placeholder hashes only. No Actual database, export, ledger, adapter call,
  remote fence, or write-capability change is involved.
- This verifies only the already-implemented generation-zero companion-only
  protocol. Paired Actual backup/restore, a remote fence, manifest chains, and
  any write-era recovery remain deferred and fail closed under FIN-42.
- FIN-11 intentionally leaves retained artifacts for manual recovery; this
  ticket proves that the prior pair remains available, not an automatic recovery
  procedure.

## Problems and follow-ups

- The fresh worktree had no completed dependency state. A worktree-local
  junction to the existing validated `actual/node_modules` was used for
  validation; it is untracked and not part of the commit.
- Build warnings about ineffective dynamic imports predate this focused test
  change and do not affect the generated package build.
