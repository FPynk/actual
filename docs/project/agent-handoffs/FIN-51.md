# FIN-51 final review handoff

## Decision

The local read-only companion release candidate passed the final synthetic
security, migration, integrity, performance-bound, build, and browser review
after the release blockers below were fixed. No real user database, Actual
server, provider, credential, or source file was used.

The release remains generation-zero and companion-only. Actual mutations,
write-era backup/restore, remote exposure, and real deployment are not
approved.

## Fixed findings

| Finding                                                                             | Resolution                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clean backup could restore over and erase an unresolved bank-sync outcome.        | Backup, verification, restore, and migration now reject unresolved parent, child, or quarantine evidence. Restore checks the live database before staging or replacement.     |
| Partial resolution metadata could bypass the quarantine gate.                       | Only the exact parent `failed` and child `outcome_unknown` tuple with the approved resolution code, retained hash, and equal non-null resolution time is accepted.            |
| Bank sync could race maintenance after creating its job.                            | Configured bank sync owns the shared maintenance lock through adapter setup and terminal durable completion. Synthetic job-first and maintenance-first races fail closed.     |
| Normal startup could apply pending migrations without the required verified backup. | Fresh initialization remains automatic. Existing databases with pending migrations stop with an instruction to run `db:migrate`; only the maintenance lifecycle applies them. |
| A large valid Amazon source set could overflow the JavaScript call stack.           | Exact matching is iterative and has one deterministic global work/candidate budget. A 20,000-source regression fails with the stable limit error, not `RangeError` or a hang. |
| `/health` remained healthy after terminal adapter fail-stop.                        | Readiness now reads adapter health and returns HTTP 503 with the minimal unhealthy payload after terminal fail-stop.                                                          |
| Baseline documents retained a personal local path.                                  | Host-specific checkout paths were replaced with workspace placeholders.                                                                                                       |

## Verification

Run from the repository root on the FIN-51 branch:

```powershell
corepack yarn workspace @actual-app/finance-companion typecheck
corepack yarn workspace @actual-app/finance-companion exec vitest --run --testTimeout=30000
corepack yarn workspace @actual-app/finance-companion build
corepack yarn workspace @actual-app/finance-companion test:e2e
git diff --check integration/finance-app...HEAD
```

Results:

- companion typecheck passed;
- complete companion suite: 43 files, 355 passed, 4 intentional skips;
- production build passed with only the two existing ineffective dynamic
  import warnings;
- production-build Chromium: desktop and 390x844, 2/2 passed; and
- the revised restore/bank-sync patch received independent approval after a
  first review rejection and correction.

The synthetic restore tests preserve the live companion database, integrity
anchor, and encrypted backup bytes when unresolved evidence blocks restore.
Interruption tests retain the prior pair at its live or verified rollback
paths. The tests never import an Actual adapter or ledger mutator into restore.

## Safe limitations and follow-ups

- The service is HTTP loopback-only. Do not reverse proxy or expose it
  remotely.
- `write_capability_state` remains `disabled`. Deferred write tickets must not
  be inferred from approved companion decisions.
- Amazon multipart input is transiently spooled to a restricted temporary
  file before deletion and accepted buffers are zeroed. Deletion is not media
  erasure; use encrypted host and temporary storage. Normalized sensitive
  identifiers and titles remain in SQLite and encrypted backups.
- Documented 30/365-day retention is not scheduled automatically, and Amazon
  purge is not implemented. Treat the database as sensitive and review data
  manually until FIN-57 lands.
- Owner credential rotation is still a placeholder command (FIN-58). Protect the
  bootstrap credential in a secret manager and stop the service if compromise
  is suspected.
- GitHub has no automated check rollup for these PRs. The evidence above is
  local and synthetic; FIN-59 owns CI and Ubuntu runtime evidence.
- Docker Buildx was unavailable on the Windows host, so no successful Linux
  container runtime smoke is claimed. Run the documented synthetic smoke on a
  private Ubuntu host before deployment.

## Rollback

The code change is reverted by reverting its squash merge. A synthetic
companion restore may replace only the companion database and authenticated
integrity anchor from a verified encrypted generation-zero backup. It does not
restore Actual or bypass unresolved quarantine, write-era, or remote-fence
gates.
