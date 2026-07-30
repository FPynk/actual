# FIN-8: Existing finance workflow acceptance

Commit `2268e874f4d96ddc30299e82f5d6925c3ae8397a` supplies the only data source for this check: `createSyntheticFinanceWorkflowFixture()` with its fixed `2026-01-15` clock. The browser test converts two fixture transactions to an in-memory CSV, so it neither commits source data nor relies on a host path.

## Validated browser flows

| Flow                   | Observed behavior                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Structured import      | The CSV preview exposes two imported fixture records and imports them into the fixture-named checking account.        |
| Payee and rule         | A rule for `Example Market` sets the fixture's ordinary-expense note when a new transaction is entered.               |
| Account transactions   | Checking accepts imported, rule-applied, split, posted-schedule, and refund entries; the refund remains after reload. |
| Split transactions     | A parent amount is displayed as `Split`; its two child amounts remain separately visible.                             |
| Schedules              | A fixture-named schedule begins Due, posts successfully, then reads Paid and produces an account transaction.         |
| Arbitrary report range | Net Worth accepts a manually selected December 2025 through January 2026 static range.                                |

## Limitations and evidence

- The reusable fixture is a core-data builder, not an Actual budget export. Browser setup therefore uses the existing local demo budget and creates the fixture-named accounts through the UI; categories use the demo's `Food` and `General` names.
- The structured-import preview attachment is emitted only by this focused Playwright run as `structured-import-preview` in the Playwright HTML report; it is not committed as a generated asset.
- The acceptance spec listens for browser `warning`, `error`, and `pageerror` events and fails on any message. It reloads the fixture-named checking account and verifies the refund persists.
