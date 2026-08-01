# FIN-64 handoff

- Agent/model: Codex / GPT-5
- Ticket: FIN-64 - Make browser production build cross-platform on Windows
- Branch: `fix/FIN-64-cross-platform-browser-build`
- Start commit: `fc203f48e55d05dd861fb926d4104fac2a32442d`

## Files

- `package.json`
- `bin/package-browser`
- `bin/package-browser.test.cjs`
- This handoff

## Summary

Replaced the Bash-only browser-build wrapper with a Node entry point. The
existing `build:browser` script and `--skip-translations` flag remain intact.
The wrapper still clones, resets, pulls, and filters translations unless that
flag is supplied, then runs the same Lage browser-build target. On Windows it
uses the local `lage.cmd`; Unix platforms continue to use `lage`.

The focused tests cover a synthetic repository path containing spaces,
translation-step forwarding, unknown arguments, and child-process failure
propagation. No Actual server, budget, credential, or financial data was used.

## Validation

- `node --test bin/package-browser.test.cjs` - passed: 3 tests.
- `corepack yarn build:browser --skip-translations` from
  `C:\Users\Andrew\Desktop\Side Projects\actual-fin64` - passed. Lage built
  `plugins-service`, `@actual-app/crdt`, `@actual-app/core`, and
  `@actual-app/web build:browser`.
- `corepack yarn build:browser --unexpected-option` - failed with exit code 1
  before starting a build, as intended.
- `E2E_START_URL=http://localhost:3001` against a temporary local
  `serve-build.mjs` process, followed by
  `corepack yarn workspace @actual-app/web run playwright test
e2e/reports.test.ts --browser=chromium` - passed: 16 production-bundle
  synthetic Reports tests.
- `corepack yarn exec oxfmt --check bin/package-browser
bin/package-browser.test.cjs package.json` - passed.
- `corepack yarn exec oxlint --type-aware --quiet bin/package-browser
bin/package-browser.test.cjs` - passed.
- `git diff --check` - passed.

## Known limitation

`E2E_USE_BUILD=1` still fails on Windows before Playwright starts because
`packages/desktop-client/playwright.config.ts` uses the separate Unix shell
assignment `PORT=${e2ePort} node ...`. This ticket intentionally changes only
the browser-build entry; the production bundle and Reports suite passed when
the same static server was started with PowerShell environment variables.
