# FIN-48 handoff

- Agent/model: Codex subagent / GPT-5
- Ticket: FIN-48 - Add cross-feature E2E, accessibility, and visual coverage
- Branch: `feature/FIN-48-cross-feature-e2e`
- Start commit: `711dc75fcee2bdb502d36c96546148783cbb85b4`
- Actual reports commit: `00caf3165`
- Companion commit: recorded in the Linear handoff after commit because a
  commit cannot embed its own final hash

## Files

- `packages/desktop-client/e2e/reports.test.ts`
- `packages/finance-companion/e2e/finance-companion.test.ts`
- `packages/finance-companion/playwright.config.ts`
- `packages/finance-companion/package.json`
- `packages/finance-companion/tsconfig.json`
- `yarn.lock`
- This handoff

## Summary

Extends the existing Actual custom-report summary journey with semantic FIN-32
metric and rolling-series assertions, keyboard activation and focus, reload
persistence, console and page-error collection, and a 390x844 horizontal
overflow check. It retains the existing VRT hook and adds no snapshots or
calculation duplication.

Adds a production-build Finance Companion Chromium journey at desktop and
390x844 widths. A deterministic browser-side API fake exercises the shipped UI
for sign-in, navigation, reconciliation, classification, recurring-payment,
and Amazon import/review flows. It covers loading, empty, success, expected
error, competing, approval, reopen, defer, stale, reconciled, retry, dialog,
focus, reload, privacy, and responsive states.

The journey records every API request, allows only the implemented companion
review endpoints, checks all decision bodies and CSRF headers, verifies the
Amazon upload's idempotency header without retaining its multipart body, and
fails if an Actual mutation, hold, reservation, receipt, or apply endpoint is
called. No real server, database, Actual adapter, provider, credential, or user
data is used.

## Tests

- `yarn workspace @actual-app/web exec playwright test --config
../finance-companion/playwright.config.ts --repeat-each=2` - passed: 4
  production-build Chromium journeys, covering desktop and 390x844 twice.
- `yarn workspace @actual-app/finance-companion run typecheck` - passed,
  including the Playwright config and E2E source.
- `yarn exec oxfmt --check packages/finance-companion/package.json
packages/finance-companion/tsconfig.json
packages/finance-companion/playwright.config.ts
packages/finance-companion/e2e/finance-companion.test.ts` - passed.
- `yarn exec oxlint --type-aware --quiet
packages/finance-companion/playwright.config.ts
packages/finance-companion/e2e/finance-companion.test.ts` - passed.
- `git diff --check` - passed.
- The rebased Actual reports production-build journey passed twice in one run:
  `2 passed (8.1s)`.

## Assumptions and limitations

- The browser fake is intentionally limited to the production UI and HTTP
  contract boundary. Authentication controls, DTO validation, SQLite
  persistence, live revalidation, and Actual-adapter isolation remain covered
  by their focused integration suites.
- The package-local Playwright configuration builds the companion and serves
  `dist/ui` with the already-installed Vite preview server. No dependency was
  downloaded or installed; the package now declares the existing pinned
  Playwright test dependency so lint and immutable lock validation remain
  correct.
- The package `test:e2e` script is the browser-runner entry point. The internal
  direct CLI placeholder remains unused; `yarn workspace
@actual-app/finance-companion test:e2e` runs the production-build journey.
- FIN-28 and FIN-29 already cover per-account sync behavior through service and
  CLI tests. This ticket does not invent a browser surface for it.
- No screenshots were added because semantic and responsive assertions provide
  stable coverage. Playwright retains screenshots and traces only on failure,
  and those generated artifacts are ignored.
- The companion build emits two existing ineffective-dynamic-import warnings.
  They do not fail the build or affect this browser coverage.
- Linux was not available locally. The runner uses no platform-specific shell
  environment assignment and relies on Yarn, Vite preview, and Playwright paths
  supported on Windows and Ubuntu.
