# Development baseline

This document records the unmodified Actual Budget baseline used by the
Personal Finance App project. It separates upstream behavior from later project
changes and gives future regressions a known comparison point.

## Source state

- Upstream repository: <https://github.com/actualbudget/actual>
- Fork: <https://github.com/FPynk/actual>
- Upstream default branch: `master`
- Starting commit: `822fbe3f96af21f276f3f41d686c796ddcd84285`
- Starting commit subject: `Bump tar in the npm_and_yarn group across 1 directory (#8592)`
- Project integration branch: `integration/finance-app`
- Local checkout: `C:\Users\Andrew\Desktop\Side Projects\actual`

At the starting commit, `origin/master`, `upstream/master`, and the base of
`integration/finance-app` were identical. The working tree and lockfile were
clean after dependency installation.

## Toolchain

| Tool       | Verified version or state                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| Windows    | Native PowerShell host                                                                                     |
| Git        | `2.45.1.windows.1`                                                                                         |
| GitHub CLI | `2.96.0`; its local token was stale, so authenticated GitHub app access was used for GitHub API operations |
| Node.js    | `22.18.0`, selected through NVM for Windows                                                                |
| npm        | `10.9.3`                                                                                                   |
| Yarn       | Repository-pinned `4.17.1` through `.yarnrc.yml`                                                           |
| Docker     | CLI `20.10.22`; daemon/config access was unavailable and was not required                                  |
| WSL        | WSL 2 was installed; distribution enumeration was unavailable and was not required                         |
| Git Bash   | Used only for Bash-based repository build scripts                                                          |

Node 22 is the supported line declared by the repository. The machine's
pre-existing Node 25 installation was not used for validation.

## Dependency installation

`yarn install --immutable` completed successfully in 4 minutes 12 seconds. It
resolved 2,464 packages and fetched approximately 376.61 MiB. The reported peer
dependency warnings were present in the upstream dependency graph. The command
did not change `yarn.lock`.

## Baseline validation

| Check                    | Result                   | Evidence                                                                                                                                                                            |
| ------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting               | Passed                   | `yarn oxfmt --check .`                                                                                                                                                              |
| Oxlint                   | Failed on Windows        | Two `typescript-paths(absolute-parent-import)` findings in `TrackingBudgetComponents.tsx:34` and `EnvelopeBudgetComponents.tsx:33`; both files import shared parent types from `..` |
| Type checking            | Passed                   | All 10 workspace tasks completed in 67.7 seconds                                                                                                                                    |
| Unit/integration tests   | Partial baseline failure | 8 of 9 workspace test tasks passed; 1,011 tests passed, 2 failed, and 2 were skipped                                                                                                |
| Browser production build | Passed through Git Bash  | Plugins service, CRDT, core, and web client built in 44.1 seconds                                                                                                                   |
| Production UI            | Passed                   | Welcome screen, demo budget, Budget, Reports, Schedules, and transaction list rendered                                                                                              |
| Browser console          | Passed                   | No console errors or warnings during the manual flow                                                                                                                                |

### Test failures

Both failures are in
`packages/loot-core/src/server/main.test.ts`. A teardown tries to remove the
synthetic `mocks/files/budgets/test-budget/db.sqlite` before Windows releases
the SQLite handle:

1. The first budget test fails with `EBUSY` while unlinking `db.sqlite`.
2. The following test fails with `EEXIST` while recreating the directory.

An isolated rerun produced the same sequence. The other core tests completed,
so this is recorded as a deterministic Windows lifecycle issue rather than a
finance behavior failure.

### Windows script constraints

The upstream scripts assume Bash in several places:

- Running `yarn build:browser` directly from PowerShell caused `/bin/bash` to
  interpret the Windows checkout path incorrectly. Invoking the repository
  script with Git Bash completed the build.
- `yarn start` could not find `sh` from a plain PowerShell environment.
- After Git's Unix tools were added to `PATH`, `bin/watch-browser` still split
  the checkout path at `Side Projects` because its `dirname $0` usage is
  unquoted.

These findings match the repository's Windows contribution guide, which says
many development scripts are Bash-only. A narrow compatibility ticket should
cover the reproducible path and teardown defects without replacing upstream
tooling.

That ticket is complete only when:

- `yarn lint` reports neither affected parent-import finding;
- the targeted `main.test.ts` run passes on Windows and leaves no residual
  `test-budget` fixture;
- `yarn start` works from a checkout path containing spaces when launched from
  the documented supported shell; and
- the full Windows test suite no longer has the recorded SQLite teardown
  failures.

## Manual UI verification

The production browser bundle was served locally on port 3001 with synthetic
demo data. The following workflow was completed:

1. Open the welcome screen.
2. Select **Try the demo**.
3. Load the synthetic **Test Budget**.
4. Open the budget view.
5. Open Reports and inspect income, expenses, net worth, cash flow, month
   comparison, and average widgets.
6. Open Schedules.
7. Open the synthetic Bank of America account and its transactions.
8. Open the import dialog and cancel its file chooser without selecting data.

No personal account, statement, credential, or financial record was used.

## Baseline interpretation

The application is locally buildable and its main UI works at the upstream
starting commit. The baseline has three Windows-specific development defects:
two path lint findings, SQLite test teardown ordering, and an unquoted Bash
script path. They are suitable for an isolated compatibility fix. They do not
invalidate Actual's existing finance features or the successful Ubuntu-focused
upstream CI evidence.
