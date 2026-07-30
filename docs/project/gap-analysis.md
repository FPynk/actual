# Personal Finance App gap analysis

This document maps the requested product behavior to verified Actual Budget
capabilities at commit `822fbe3f96af21f276f3f41d686c796ddcd84285`.
Detailed evidence is in `docs/project/current-capabilities.md`.

## Decision legend

- **Configure Actual**: no project code is needed.
- **Use Actual API/CLI**: automation can remain outside the ledger.
- **Companion service**: keep derived, review, or connector metadata outside
  Actual and use only supported interfaces.
- **Targeted Actual change**: the behavior belongs in the ledger, reconciler, or
  existing user interface and cannot be made reliable externally.

Complexity is relative to this project: S is a focused ticket, M is several
bounded tickets behind one design, and L requires staged delivery and migration
or security review.

## Expenditure analysis

| Requirement                  | Existing support                                                        | Gap                                                          | Recommended layer                             | Complexity | Risk and phase                                  |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------- | ---------- | ----------------------------------------------- |
| Expenditure by category/type | Custom reports group and filter by category or group                    | None for core use                                            | Configure Actual                              | S          | Low; Phase 2 workflow validation                |
| Arbitrary ranges             | Static start/end report dates                                           | None                                                         | Configure Actual                              | S          | Low; Phase 2                                    |
| Predefined ranges            | Live week/month/last-30-days/months/YTD/year presets                    | None                                                         | Configure Actual                              | S          | Low; Phase 2                                    |
| Total expenditure            | Payment totals and net calculations                                     | Terminology needs user guidance                              | Configure Actual                              | S          | Low; Phase 2                                    |
| Average per month            | Summary report                                                          | None for ordinary use                                        | Configure Actual                              | S          | Low; Phase 2                                    |
| Average per day/week         | Daily/weekly intervals exist, but no arbitrary-range summary cards      | Missing direct metrics and partial-period definition         | Targeted Actual report calculation/UI         | M          | Medium semantic risk; Phase 6                   |
| Median transaction size      | No general metric                                                       | Must define expense rows, splits, refunds, and zero values   | Targeted Actual report calculation/UI         | M          | Medium data semantics; Phase 6                  |
| Spending by merchant         | Group by payee                                                          | Raw aliases can fragment a merchant                          | Configure Actual after merchant normalization | S          | Low; Phase 4 then 6                             |
| Month-over-month change      | Monthly Spending compares selected periods                              | No general percent/amount metric across arbitrary selections | Targeted Actual report calculation/UI         | M          | Medium; Phase 6                                 |
| Rolling 30-day spending      | Last-30-days live range                                                 | No rolling series or change metric                           | Targeted Actual report calculation/UI         | M          | Medium performance/semantics; Phase 6           |
| Transfers and card payments  | Represented as transfers and generally excluded from expense categories | Must be locked into new metric fixtures                      | Reuse Actual semantics                        | S          | High integrity if wrong; Phase 6 tests          |
| Refunds                      | Positive rows offset net/category amounts                               | No dedicated refund type                                     | Reuse current semantics initially; document   | S          | Medium; Phase 6 tests                           |
| Splits                       | Existing parent/child model and report support                          | New metrics must aggregate children correctly                | Reuse Actual semantics                        | S          | High integrity if double-counted; Phase 6 tests |
| Multiple currencies          | One budget display currency; no per-row FX model                        | True aggregation unavailable                                 | Explicit non-goal until a separate design     | L          | High migration/integrity; future                |

Configuration already satisfies most analysis requirements. The first custom
report ticket should add only a shared, tested metric calculation for average
day/week, median, month-over-month, and rolling 30-day values. It must not
replace custom reports or Monthly Spending.

## Statement import

| Requirement                      | Existing support                                   | Gap                                                                             | Recommended layer                                                               | Complexity | Risk and phase                   |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- | -------------------------------- |
| OFX/QFX import                   | Existing with `FITID` identity                     | Institution quirks remain                                                       | Configure and add synthetic fixtures only as discovered                         | S          | Low; Phase 2/3                   |
| CSV/TSV import                   | Existing mapping and preview                       | No intrinsic stable identifier                                                  | Configure; optional source adapter can create scoped IDs                        | M          | Medium collision risk; Phase 3   |
| QIF import                       | Existing                                           | Weak source identity                                                            | Configure; prefer OFX/QFX                                                       | S          | Medium dedup risk; Phase 2       |
| CAMT XML import                  | Existing                                           | Pending state/category behavior needs fixtures                                  | Configure, then targeted parser tests if needed                                 | S          | Medium; Phase 3                  |
| PDF import                       | Missing                                            | OCR/layout variability and weak identity                                        | Deferred companion adapter only for unsupported institutions                    | L          | High correctness/privacy; future |
| Common normalized representation | `ImportTransactionEntity`                          | Source/batch provenance is incomplete                                           | Reuse contract; keep connector provenance in companion initially                | M          | Medium; Phase 3                  |
| Troubleshooting metadata         | Imported payee/notes and bank `raw_synced_data`    | File source/batch metadata is limited; raw provider JSON can contain excess PII | Companion import receipt plus redacted diagnostics                              | M          | Medium privacy; Phase 3          |
| Import review                    | CSV mapping/preview and resulting transaction list | No durable reconciliation-confidence queue                                      | Companion review metadata; targeted Actual UI only after API boundary is proven | L          | High integrity/UI; Phase 3       |

No default PDF parser is justified. Supported structured formats should remain
the documented first choice.

## Classification and merchant normalization

| Requirement                     | Existing support                                  | Gap                                                        | Recommended layer                                                              | Complexity | Risk and phase                        |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- | ------------------------------------- |
| Automatic categorization        | Ordered rules and learned payee-to-category rules | No confidence score                                        | Configure Actual first                                                         | S          | Low; Phase 2/4                        |
| Merchant normalization          | Imported-payee rename rules                       | No alias suggestion/confidence/conflict review             | Companion proposes aliases; approval creates Actual rename rules               | M          | Medium; Phase 4                       |
| Uncertain classification review | Uncategorized transactions can be edited          | No explicit confidence/reason/status                       | Companion classification-review entity and UI                                  | L          | High incorrect-category risk; Phase 4 |
| Learn from confirmations        | Category learning uses recent votes               | Confirmation does not train a general model                | Reuse the deterministic rule learner; add only explicit approved alias updates | M          | Medium behavior drift; Phase 4        |
| Preserve user decisions         | Reconciliation keeps category/payee/notes         | Re-running some rule stages can still alter rows by design | Do not add silent background recategorization                                  | S          | High trust risk; all phases           |

A probabilistic classifier is not an initial requirement. Deterministic rules,
explicit merchant alias proposals, and an uncertainty queue provide an
auditable path with less financial-data risk.

## Bank synchronization and scheduling

| Requirement                   | Existing support                                                | Gap                                                                 | Recommended layer                                                               | Complexity | Risk and phase                          |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- | --------------------------------------- |
| SimpleFIN                     | Complete server/provider integration                            | Requires user setup token and server configuration                  | Configure Actual                                                                | S          | Security-sensitive credentials; Phase 5 |
| Other providers               | GoCardless, Pluggy, Enable Banking, Akahu                       | Availability varies by region/account                               | Configure one supported provider                                                | S          | Provider-specific; Phase 5              |
| Manual sync                   | Existing UI/API/CLI                                             | None                                                                | Configure Actual                                                                | S          | Low                                     |
| Scheduled sync                | `runBankSync` and `actual server bank-sync` hooks               | No built-in scheduler                                               | Companion/supervisor invokes CLI with lock, retry, timeout, and redaction       | M          | High secret/retry risk; Phase 5         |
| Instant live updates          | Not available                                                   | Not required                                                        | Non-goal                                                                        | —          | —                                       |
| Rate-limit and retry handling | Provider-specific handling exists                               | No project-level scheduled run policy                               | Companion scheduler                                                             | M          | Medium; Phase 5                         |
| Secret storage                | Sync server secrets DB; CLI supports environment/session inputs | Credentials are not budget-E2E encrypted; no scoped service account | Environment or permission-restricted ignored file; single-user homelab boundary | M          | High security; Phase 5                  |
| Safe logging                  | Standard logs                                                   | Debug path can expose secrets/provider PII                          | Redaction policy and tests in scheduler                                         | M          | High security; Phase 5                  |

The scheduler must retain the CLI's existing per-data-directory lock or provide
equivalent exclusive access when using the API directly. It must download/open
the budget, run bank sync, call `sync`, and always call `shutdown`. Systemd timer
or container scheduling is an Ubuntu deployment concern; a portable one-shot
command is the project deliverable.

## Duplicate detection and reconciliation

| Scenario                        | Existing support                                                  | Gap                                                       | Recommended layer                                                                           | Complexity | Risk and phase                                 |
| ------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- |
| Same OFX/QFX twice              | Exact account + `imported_id` normally matches                    | Same-batch duplicate IDs can both insert                  | Targeted Actual exact-ID batch guard                                                        | M          | Critical integrity; Phase 3                    |
| Overlapping statements          | Exact IDs when present; otherwise fuzzy                           | CSV/QIF can silently merge or duplicate                   | Preserve preview; add candidate reasoning and fixtures before UI change                     | L          | Critical false-positive/negative risk; Phase 3 |
| Statement plus bank API         | Common account reconciler                                         | No source namespace or durable cross-source evidence      | Lead-owned matching design; companion registry first, targeted core change only if required | L          | Critical; Phase 3                              |
| Pending then posted, same ID    | Exact ID updates an unreconciled row                              | Public pending state is weak; reconciled rows are skipped | Add regression fixture; reuse behavior                                                      | S          | High; Phase 3                                  |
| Pending then posted, changed ID | Sync accounts disable strict-ID checking, so fuzzy match may work | Wrong or missed match; reconciled pending rows are locked | Lead-owned candidate scoring and manual review                                              | L          | Critical; Phase 3                              |
| Manual then imported            | Fuzzy match and field preservation                                | Ambiguous repeated purchase can select wrong row          | Add explicit fixtures and review for uncertainty                                            | M          | Critical; Phase 3                              |
| Same amount/merchant twice      | No unique constraint, so both can exist                           | Fuzzy matching may combine them                           | Never add date/amount/merchant uniqueness; introduce scored candidates                      | M          | Critical; Phase 3                              |
| Deleted transaction reimport    | `reimportDeleted` preference                                      | None for supported behavior                               | Configure Actual                                                                            | S          | Medium                                         |
| Reconciled transaction          | Locked and skipped                                                | Provider update cannot advance it                         | Preserve lock; show review candidate instead of mutating                                    | M          | High trust; Phase 3                            |

The permanent identity hierarchy should be:

1. Actual account plus source namespace plus stable external identifier.
2. Actual account plus stable statement/provider identifier.
3. A candidate score using amount, normalized payee, date tolerance, and
   pending/posted relationship.
4. Explicit review below an unambiguous threshold.

Only levels 1 and 2 may produce automatic exact matches. Level 3 must never
become a permanent database uniqueness constraint. The final score, thresholds,
and migration strategy remain lead-owned decisions.

Open upstream [issue #4280](https://github.com/actualbudget/actual/issues/4280)
supports a small same-batch exact-ID fix. Open
[issue #8464](https://github.com/actualbudget/actual/issues/8464) and WIP
[PR #8468](https://github.com/actualbudget/actual/pull/8468) mean this project
should not concurrently redesign CSV preview matching.

## Subscription and recurring-payment detection

| Requirement                                  | Existing support                                                  | Gap                               | Recommended layer                                             | Complexity | Risk and phase                 |
| -------------------------------------------- | ----------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- | ---------- | ------------------------------ |
| Weekly/biweekly/monthly candidates           | Find Schedules                                                    | Limited cadence/alias assumptions | Reuse output as one signal                                    | M          | Medium; Phase 7                |
| Quarterly/annual cadence                     | Schedules can represent yearly, but discovery does not find these | Candidate generation missing      | Companion analysis                                            | M          | Medium; Phase 7                |
| Amount/date variance                         | Discovery has fixed tolerances                                    | No explainable multi-factor score | Companion score with reasons                                  | M          | Medium; Phase 7                |
| Price increases                              | Not modeled                                                       | Trend/change feature missing      | Companion analysis                                            | M          | Medium; Phase 7                |
| Paused/resumed recurrence                    | Not modeled                                                       | History-state logic missing       | Companion analysis                                            | M          | Medium; Phase 7                |
| Subscription versus household/financial bill | No type distinction                                               | User classification needed        | Companion review metadata                                     | M          | Low ledger risk; Phase 7       |
| Confidence/review                            | User selects discovered schedules, but no score                   | Need confidence and reason codes  | Companion UI; create/link Actual schedule only after approval | L          | Medium UI/integration; Phase 7 |

Derived candidates do not belong in the Actual ledger until confirmed. The
companion can query synthetic-safe transaction fields through the API, persist
candidate metadata in its own database, and create or link an Actual schedule
only after approval.

## Amazon purchase enrichment

| Requirement                              | Existing support                                       | Gap                                               | Recommended layer                                                                      | Complexity | Risk and phase                           |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| Order data source                        | None in Actual                                         | Consumer Amazon has no stable supported order API | User-supplied Amazon data-request export first                                         | M          | High privacy/schema variability; Phase 8 |
| Confirmation/shipping/refund email       | None                                                   | Mail access, parsing variants, duplicate messages | Local `.eml` upload first; optional read-only connector after separate security review | L          | High restricted-data/privacy; Phase 8    |
| Order/shipment/item model                | Splits can represent approved category allocation      | No enrichment entities                            | Companion database                                                                     | L          | Medium; Phase 8                          |
| Gift card, tax, shipping, partial refund | No order semantics                                     | Allocation and refund relationships missing       | Companion normalized order model and deterministic totals                              | L          | High financial correctness; Phase 8      |
| Many-to-many order/charge matching       | Ordinary transaction matcher is not designed for items | Candidate generation and allocation missing       | Companion candidate graph with amount/date evidence                                    | L          | Critical false-match risk; Phase 8       |
| Attach item details                      | Notes and splits can be updated through API            | Need provenance and idempotency                   | Companion retains source; approved concise note/split mutation through API             | M          | Medium; Phase 8                          |
| Suggested category splits                | Actual supports splits                                 | Suggestion/approval workflow missing              | Companion review, then API batch update                                                | L          | Critical trust; Phase 8                  |
| Unsafe browser credential scraping       | Not used                                               | Must remain prohibited                            | Explicit non-goal                                                                      | —          | Security requirement                     |

Amazon's privacy notice states that customers can access purchase history, and
Amazon provides a
[Request Your Data](https://www.amazon.com/hz/privacy-central/data-requests/preview.html)
flow. The resulting export is user-controlled but its delivery time and schema
are not an application contract. This makes an adapter-based import with fixture
versioning safer than assuming one permanent CSV shape.

If email access is added later, Google's
[Gmail authorization guide](https://developers.google.com/workspace/gmail/api/auth/scopes)
classifies `gmail.readonly` as a restricted scope, while
[`users.messages.list`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
supports Gmail-style filtering before message retrieval. The first release
should therefore accept user-exported `.eml` files or a dedicated forwarded
mailbox folder instead of requesting broad mailbox authorization.

All matches begin as candidates. Even a high score may attach explanatory item
metadata, but category or split mutations require user approval unless a later
design proves an exact, idempotent relationship.

## UI and workflow gaps

Existing Actual screens generally provide loading and empty states, but some
report failures are logged and converted to empty data rather than shown to the
user. New project screens must explicitly represent:

- loading;
- no candidates/data;
- successful confirmed state;
- recoverable source/API failure;
- stale candidate caused by a changed ledger transaction; and
- partial success where one mutation in a review batch fails.

Uncertain matches must show human terms, evidence, and consequences. They must
not expose raw provider IDs or email headers by default. Keyboard access,
labels, focus return, responsive layout, and destructive confirmation are
acceptance criteria for every UI implementation ticket.

## Deployment-readiness gaps

Actual itself is ready for a Docker-based Ubuntu homelab, but this project still
needs:

- a project policy that pins the chosen image digest or version and reviews
  upgrades, stricter than Actual's supported `latest` recommendation;
- durable volumes and an external backup schedule;
- pre-upgrade budget exports and restore verification;
- secret injection outside source control;
- health checks for Actual and any companion one-shot/service;
- reverse proxy secure-context and header configuration;
- Tailscale-only access by default; and
- documented rollback that accounts for irreversible database migrations.

These are documentation and release-readiness tasks. Automatic deployment is
out of scope.

## Recommended phases

1. **Foundation and evidence**: preserve the baseline and fix only development
   blockers.
2. **Use the existing product**: validate supported imports, rules, reports,
   schedules, and splits with synthetic workflows.
3. **Protect transaction identity**: exact same-batch guard, high-value
   reconciliation fixtures, and a separately approved candidate design.
4. **Normalize merchants and classify transparently**: use imported-payee rules
   and explicit review.
5. **Schedule supported bank sync**: build one redacted, locked, retry-safe
   command around API/CLI.
6. **Add missing report metrics**: extend existing report seams only.
7. **Derive subscription candidates**: companion metadata with schedule reuse.
8. **Add optional Amazon enrichment**: user exports/local email files, a
   many-to-many review workflow, then approved notes/splits.
9. **Integrate and release-test**: synthetic end-to-end flows, accessibility,
   Windows and Ubuntu readiness.
10. **Document operation**: setup, daily use, backup, upgrade, rollback, and
    limitations.

## Explicit non-goals for the initial implementation

- Replacing Actual's ledger, rules, reports, schedules, or bank connectors.
- Direct writes to Actual's SQLite database or internal sync endpoints.
- A broad machine-learning categorizer.
- A general PDF/OCR statement ingestion platform.
- Amazon browser automation or password storage.
- Silent fuzzy duplicate deletion.
- Automatic mutation of uncertain Amazon categories or splits.
- True multi-currency accounting without a separately approved migration
  design.
