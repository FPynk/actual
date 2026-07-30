# FIN-10 handoff

- Agent/model: Codex / GPT-5.6 Terra
- Ticket: FIN-10 — Scaffold `@actual-app/finance-companion`
- Branch: `feature/FIN-10-finance-companion-scaffold`
- Original start commit: `9e56bd235d69314b8a3efa2fb95c79e15c044f0e`
- Current integration base: `27f673c09c4ff36729ae64ffd63869ad5bb4b4d3`
- End commit: Pending lead commit
- PR: Pending lead action

## Files

- `.gitignore`
- `yarn.lock`
- `packages/finance-companion/package.json`, configuration, build/test configuration, and static UI
- `packages/finance-companion/src/{cli,config}.ts`
- `packages/finance-companion/src/{http,service,ui,tests}/`
- This handoff

## Summary

Adds the package-discovered companion scaffold: frozen configuration name/syntax validation, direct secret environment cleanup, exact raw Host enforcement, a `127.0.0.1` static login shell, and the minimal health payload. Unowned specialized commands emit their fixed `feature_not_implemented` result before configuration loading.

## Assumptions and limitations

- FIN-10 checks configuration presence and syntax only; it does not inspect paths, files, credentials, Actual, or a database.
- FIN-11 owns filesystem/database/anchor/backup work. FIN-12 owns credential reading, sessions, CSRF, and a login endpoint.
- The login form has no submission behavior and no auth route is mounted.

## Tests

- `yarn workspace @actual-app/finance-companion typecheck` — passed.
- `yarn workspace @actual-app/finance-companion build` — passed.
- `yarn workspace @actual-app/finance-companion test` — passed: 3 files, 37 tests.
- `yarn lage build --scope=@actual-app/finance-companion` — passed.
- `yarn lage typecheck --scope=@actual-app/finance-companion` — passed.
- `yarn lage test --scope=@actual-app/finance-companion` — passed.
- `yarn oxfmt --check` for the package and handoff — passed.
- `yarn oxlint --type-aware --quiet packages/finance-companion/src` — passed.
- `yarn constraints` — passed.
- `git diff --check` — passed.
- A standalone loader probe verified all three direct secret alternatives are
  absent from `process.env` after successful loading. Tests also cover cleanup
  after validation failure and readonly injected environment maps.
- A raw TCP probe against the production build sent two `Host` header lines and
  received HTTP `400`. The temporary loopback service then stopped with empty
  stdout and stderr logs.
- Dependency and boundary scans found no direct core, sync-server, Electron, or
  SQLite import, no domain/auth route implementation, and no SQL migration file.
- `packages/finance-companion/dist` is explicitly ignored; no file is staged.
- PowerShell child-process tests execute every specialized package script and
  assert exit `78`, empty stdout, exact one-line stderr, and no configuration
  loader call. The package test passes from this Windows path containing spaces.
- Git Bash is available. From the mounted worktree path containing spaces,
  `test:db` emitted the exact expected feature result and exited with the
  intentional nonzero status.

## UI evidence

- Production bundle ran locally on `127.0.0.1:4100` with synthetic values only.
- `GET /health` returned exactly `{"status":"healthy","version":"0.0.1"}`.
- Headless browser validation found no console messages or page errors.
- A static login-shell screenshot was retained in a non-repository temporary
  location for lead review.
- The temporary service was stopped after validation; stdout and stderr logs were empty.

## Problems

Yarn installation completed with pre-existing workspace peer-dependency warnings. The uncommitted work rebased cleanly from the original start commit onto exact integration base `27f673c09c4ff36729ae64ffd63869ad5bb4b4d3`. No FIN-10 validation failure remains.

## Follow-ups

Lead should append final command results and visual evidence, then commit with: `[AI] Scaffold finance companion package [FIN-10]`.
