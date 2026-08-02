# Native Actual finance backlog migration

## Decision

The Finance Companion is no longer an execution target. The requested result is
one Actual application, URL, budget and login, with Finance Companion features
implemented in the corresponding native Actual surfaces. Actual remains the
source of truth for transactions, categories, schedules, imports, undo and
sync. No Companion process, port 4100, Companion SQLite database, local
principal, integrity anchor, adapter worker, custom HTTP API, or Companion
backup/restore lifecycle is retained.

The replacement work must reuse portable, tested domain logic where it is
useful (metrics, matching, Amazon parsing, subscription scoring), but must not
embed or proxy the Companion UI. It must use Actual's own query, mutation,
import, schedule, undo, authentication and synchronization paths.

This document is the execution backlog design. The native-Actual architecture
document is the authoritative source for implementation locations and security
boundaries; every replacement issue should link both documents.

## Unfinished FIN issue inventory and recommended disposition

| Issue | Current state | Disposition | Reason |
| --- | --- | --- | --- |
| FIN-25 | Backlog | Supersede | Its constrained Companion rule writer is replaced by native LLM bulk categorization; rule creation is not the requested primary workflow. |
| FIN-26 | Backlog | Supersede | Its Companion review UI and one-at-a-time rule action are replaced by the native transaction-table bulk categorization flow. |
| FIN-36 | Backlog | Supersede | Native recurring-payment work must create/edit schedules through Actual, without Companion receipts or adapter APIs. |
| FIN-43 | Backlog | Obsolete | The Companion conditional mutator is an architecture that must not be introduced. Native writes use Actual's established transaction mutation and undo path. |
| FIN-44 | Backlog | Obsolete | Companion cross-database receipts, anchors and recovery are unnecessary once there is no second database or remote mutation boundary. |
| FIN-45 | Backlog | Supersede | The reconciliation outcome remains required, but is rebuilt as a native Actual review-and-merge flow. |
| FIN-46 | Backlog | Supersede | One-time Companion classification is replaced by the native selectable/range/all LLM categorization batch. |
| FIN-47 | Backlog | Supersede | Amazon notes/splits remain required, but are rebuilt using native Actual transaction and split editing. |
| FIN-57 | Backlog | Obsolete | Companion retention and Amazon purge tables disappear. Native feature data follows Actual's own storage/retention model. |
| FIN-58 | Backlog | Obsolete | Companion owner credentials disappear; Actual's existing authentication is reused. OpenAI credentials have a separate narrowly scoped native setting. |
| FIN-59 | In Progress | Supersede | Companion container smoke/CI is no longer release evidence. Replace with focused native CI and E2E coverage. Do not merge Companion-only CI. |
| FIN-60 | In Progress | Obsolete | Companion secret-reader/root-isolation work belongs to the removed runtime. Retain only any independently useful, reviewed helper patch after native design review. |
| FIN-61 | In Progress | Obsolete | The Companion bank-sync HTTP API and maintenance gate are removed. Native sync uses Actual's existing bank-sync lifecycle. |
| FIN-62 | In Progress | Obsolete | Companion bank-sync quarantine resolution is removed with the Companion job system. |
| FIN-63 | In Progress | Obsolete | Companion paired/staged restore is removed. Actual's existing backup/restore behavior remains authoritative. |
| FIN-64 | In Progress | Keep | `yarn build:browser --skip-translations` must work from a Windows checkout with spaces. This is an Actual build defect independent of Companion. Keep its scope narrow. |
| FIN-65 | Backlog | Supersede | Its final audit assumes the Companion release. Replace with a native feature-parity audit after the tickets below. |

Linear records both obsolete and superseded work as **Canceled**, with a note
linking the replacement native issue and this document. They are architectural
supersessions, not exact duplicate tickets. Existing branches and worktrees are
left untouched so an execution agent may selectively reuse a small portable
patch; the Companion scope does not continue merely because work had started.

## Native Actual execution issue set

[FIN-68](https://linear.app/andrew-loh-homelab/issue/FIN-68/native-actual-integrate-all-finance-functionality-into-actual)
is the parent delivery issue. The child issues below are in the Finance App
team and Personal Finance App project and link this document plus both native
designs.

| Issue | Priority / estimate | Depends on | Scope and acceptance outline |
| --- | --- | --- | --- |
| [FIN-69](https://linear.app/andrew-loh-homelab/issue/FIN-69/native-foundation-add-finance-contracts-metadata-seam-and-test): Native finance contracts, metadata seam and fixtures | Urgent / 2 | None | Locate the transaction table, import flow, reports, schedules, bank-sync entry points, undo-safe mutation APIs and local-server settings seam. Map each portable Companion module to an Actual owner and add shared native contracts/fixtures. Acceptance: every feature below has one native owner; no port 4100/runtime dependency is introduced. |
| [FIN-70](https://linear.app/andrew-loh-homelab/issue/FIN-70/native-categorization-add-openai-settings-and-structured): OpenAI settings and structured classification gateway | Urgent / 3 | FIN-69 | Add a local, non-synced API key, inexpensive default model, editable master prompt, category allow-list and per-category guidance. Route requests through the local server and strictly validate structured replies. Acceptance: key is masked and never logged/committed/synced; disclosure is explicit; malformed or unknown responses cannot mutate data. |
| [FIN-71](https://linear.app/andrew-loh-homelab/issue/FIN-71/native-categorization-add-bulk-transaction-preview-apply-and-undo): Bulk categorization preview, apply and undo | Urgent / 5 | FIN-69, FIN-70 | Add **Auto-categorize** to the native transaction view for selected rows, date range, current filter and all eligible expenses. The already-categorized toggle defaults off. Acceptance: preview is editable and explains confidence; only allowed categories apply; canceled/failed batches make no changes; Actual undo restores the batch. |
| [FIN-72](https://linear.app/andrew-loh-homelab/issue/FIN-72/native-reconciliation-detect-review-and-safely-merge-duplicate): Native reconciliation review and safe merge | Urgent / 5 | FIN-69 | Detect exact imported-ID overlap, pending-to-posted replacement and likely duplicates; keep fuzzy cases approval-only. Acceptance: merge re-reads targets, respects reconciled/changed transactions, preserves useful metadata, is undoable and remembers keep-both decisions. |
| [FIN-73](https://linear.app/andrew-loh-homelab/issue/FIN-73/native-reports-close-expenditure-metric-and-breakdown-gaps): Expenditure metric and breakdown gaps | High / 3 | None | Keep the metrics already integrated in Actual and add missing average-month and merchant/category coverage. Acceptance: total, average day/week/month, median, category/merchant breakdowns, month-over-month and rolling measures handle refunds, transfers, splits and partial ranges; no separate Finance page. |
| [FIN-74](https://linear.app/andrew-loh-homelab/issue/FIN-74/native-recurring-detect-recurring-payments-and-create-actual-schedules): Recurring review and Actual schedules | High / 3 | FIN-69 | Reuse recurring detection in native Schedules/transaction context, distinguish optional subscriptions from household/financial bills, and show cadence/variance evidence plus approve/defer/reject/reopen actions. Acceptance: approval creates or updates exactly one native schedule; no automatic or duplicate schedule creation; stale/reconciled/ineligible evidence cannot write. |
| [FIN-75](https://linear.app/andrew-loh-homelab/issue/FIN-75/native-amazon-import-orders-match-charges-and-apply-reviewed-splits): Amazon import, matching and reviewed splits | High / 5 | FIN-69, FIN-72 | Port Amazon JSON and `.eml` parsing/matching into native import/transaction review. Acceptance: no mailbox connector or raw payload retention; ambiguous items do not write; approved notes/splits/categories use Actual mutations and undo. |
| [FIN-76](https://linear.app/andrew-loh-homelab/issue/FIN-76/native-bank-sync-add-practical-scheduled-synchronization-controls): Scheduled bank synchronization controls | High / 3 | FIN-69 | Extend Actual's existing linked-account sync with the smallest reliable local scheduler, status and one-shot control. Acceptance: no new provider credential store; duplicate runs are guarded; restart/disable/failure behavior and redaction are tested. |
| [FIN-77](https://linear.app/andrew-loh-homelab/issue/FIN-77/native-cleanup-retire-finance-companion-and-restore-one-app): Retire Companion and restore one-app startup/docs | High / 3 | FIN-71 through FIN-76 | Remove Companion runtime/config/docs after native parity lands, while retaining portable code only under native owners. Acceptance: one normal Actual URL/login/startup; no Companion process, port, database or setup; existing Companion state is not automatically deleted. |
| [FIN-78](https://linear.app/andrew-loh-homelab/issue/FIN-78/native-release-run-finance-parity-e2e-and-completion-audit): Native parity E2E and completion audit | Urgent / 3 | FIN-64, FIN-71 through FIN-77 | Consolidate native tests and evidence for categorization, reconciliation, reports, schedules, Amazon, bank sync, undo and restart. Acceptance: the Windows spaced-path build passes; no Companion-only test is cited as native evidence; the final handoff accurately identifies any real gap. |

## Parallel execution waves

```text
Wave 0: FIN-69, FIN-73 and FIN-64
Wave 1: FIN-70, FIN-72, FIN-74 and FIN-76 after FIN-69
Wave 2: FIN-71 after FIN-70; FIN-75 after FIN-72
Wave 3: FIN-77 after FIN-71 through FIN-76
Wave 4: FIN-78 after FIN-64 and FIN-71 through FIN-77
```

FIN-70, FIN-72, FIN-74 and FIN-76 can be assigned in parallel after FIN-69
lands, while FIN-64 and FIN-73 run immediately. To minimize merge conflicts,
each owns a different surface: Settings, transaction/import review, Reports,
Schedules, and linked-account sync. FIN-71 coordinates with FIN-72 only on
transaction-table action placement; it does not wait for reconciliation logic.
FIN-75 waits for FIN-72 so that its charge
matching uses the same reviewed merge safeguards.

## Ticket-writing rules

Each created issue should include these common constraints rather than copying
the old Companion delivery contract:

- Target the current native Actual integration branch and preserve unrelated
  user changes.
- Use synthetic fixtures only; never commit an API key, financial data, raw
  email/statement payload or host-specific secret path.
- All financial mutations must use Actual's established mutation and undo
  mechanisms and revalidate mutable records immediately before apply.
- Do not make a separate Companion route, service, database or authorization
  model. Do not use browser-side OpenAI calls or synchronize the OpenAI key.
- Include focused tests and `git diff --check`; run relevant typecheck, build
  and browser tests before handoff.
- Record exact remaining gaps as follow-up issues instead of claiming parity
  from read-only Companion behavior.

## Linear application checklist

1. Keep FIN-64 in progress and link it to FIN-78.
2. Link FIN-69 through FIN-78 dependencies as shown above.
3. Cancel the eleven old Backlog issues and add the applicable replacement
   issue link.
4. Stop and cancel the five Companion-only in-progress tickets (FIN-59 through
   FIN-63), while leaving their branches/worktrees available for selective
   reuse; do not mark them Done.
5. Replace FIN-65 with FIN-78 and retain the old issue as historical audit
   evidence only.
