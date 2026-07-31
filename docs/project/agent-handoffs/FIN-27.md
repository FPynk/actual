# FIN-27 Per-Account Scheduled Bank-Sync Policy

This policy refines the FIN-9 companion contract for FIN-28 and FIN-29. The
FIN-9 adapter, ownership, quarantine, idempotency, and redaction rules remain
authoritative. Scheduling stays outside the companion and provider credentials
stay in Actual.

## Invocation and account scope

`job:bank-sync` is a one-shot command. Its operation ID is
`finance-companion/job:bank-sync/v1`; its invocation kind is `scheduler` when
`--scheduler` is present and `local_cli` otherwise. Both use the stable owner
principal. The command requires `--idempotency-key <16-128 URL-safe ASCII>` and
accepts zero or more repeated `--account-id <opaque Actual ID>` arguments.
The HTTP route uses operation ID `finance-companion/http/bank-sync/v1`,
invocation kind `local_http`, its authenticated owner principal, the
`Idempotency-Key` header, and the existing `{ accountIds?: string[] }` body.

The validated semantic request is `{ accountIds: null | sortedUniqueIds }`.
Duplicates, empty IDs, unknown IDs, and accounts without a sync source reject
the whole request before a job starts. The service obtains one accounts-only
snapshot through the FIN-9 read adapter. With no requested IDs, it selects all
accounts with a sync source. It sorts selected accounts by exact account ID;
locale, display name, provider order, and database order never affect the run.
A selected closed account receives `skipped` without starting a worker. Linked
off-budget accounts remain eligible.

After enumeration, one companion transaction creates the job, its immutable
account-scope hash, and one child row per selected account with contiguous
ordinals and a preallocated worker/root identity. An exact idempotency replay
returns the stored summary and never enumerates or calls Actual again.

Exact command shapes are:

```powershell
corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key 0123456789abcdef
```

```sh
corepack yarn workspace @actual-app/finance-companion job:bank-sync -- --scheduler --idempotency-key 0123456789abcdef
```

FIN-29 may wrap these commands for Windows Task Scheduler or an Ubuntu timer,
but may not copy provider credentials into a task definition or change the job
contract.

## Sequential lifecycle

Only one account worker may exist at a time. The parent processes child rows in
ordinal order. A non-skipped child enters the global FIFO adapter queue, then
its worker verifies the durable bank-sync marker, acquires the cross-process
lock, initializes Actual in its unique operation directory, opens the one bound
budget, and calls only `runBankSync({ accountId })`. Calling no-argument
`runBankSync()` is forbidden.

The account request owns the small retry loop below, so all attempts retain one
durable child identity and one worker. After each returned or normally thrown
provider attempt, the worker must prove an explicit `sync` before it retries or
returns. It then awaits `shutdown`, releases the lock, proves process exit, and
only then releases the queue. There is no separate all-account final-sync
worker. A failed explicit sync or unproven shutdown after a provider call began
is `outcome-unknown`, not an ordinary failure.

A normal account failure does not stop later accounts. `outcome-unknown`, an
unproven worker exit, ownership failure, or unhealthy lock stops the loop and
marks untouched accounts `skipped`; no new adapter operation starts.

## Retry, deadline, and cancellation policy

There are at most three `runBankSync({ accountId })` attempts in one worker.
After retryable failures, delays are exactly `1000 + jitter` milliseconds and
`2000 + jitter` milliseconds, where production jitter is an integer from 0
through 250 and tests inject it. These are code constants, not configuration.
The existing account-worker soft and hard deadlines include calls and delays:

- `FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS` (default `120000`) records one
  pending-timeout event but does not release a guard;
- `FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS` (default `180000`) begins worker
  termination; and
- `FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS` (default `30000`) bounds proof of
  exit after termination.

No new bank-sync environment setting is added. `FINANCE_COMPANION_LOG_LEVEL`
still controls severity without widening the log field allowlist.

| Final adapter outcome | Retry in the same worker | Child status | Public outcome |
| --- | --- | --- | --- |
| Success with proven explicit sync | No | `succeeded` | `succeeded` |
| Authentication required | No | `failed` | `authentication-required` |
| Rate limited | Yes, while attempts remain | `failed` after cap | `rate-limited` |
| Normal provider timeout with proven sync/shutdown | Yes, while attempts remain | `failed` after cap | `timed-out` |
| Configuration error | No | `failed` | `configuration-error` |
| Normal provider error with proven sync/shutdown | Yes, while attempts remain | `failed` after cap | `provider-error` |
| Final sync failure before provider work is proven to have begun | No | `failed` | `final-sync-failed` |
| Hard deadline or unproven sync/shutdown after provider work began | Never | `outcome_unknown` | `outcome-unknown` |
| Closed selected account or safety abort before start | Never | `skipped` | `skipped` |
| Cancellation before a provider attempt starts | Never in this run | `canceled` | `canceled` |

SIGINT or SIGTERM records cancellation and prevents the next provider attempt
or account from starting. It never abandons a live `runBankSync` promise. A
live call completes normally or reaches the worker hard deadline. Untouched
accounts are then `canceled`; if the hard deadline creates unknown effects,
the stronger `outcome_unknown` rule wins.

## Summary, retryability, and exits

Every selected account appears once in ordinal order in `JobRunSummary`, with
`transactionCounts: null`. Parent status precedence is:

1. any unknown result: `outcome_unknown`;
2. successes mixed with failed or canceled results: `partial`;
3. any success and otherwise only skipped results: `succeeded`;
4. one or more failures and no success: `failed`;
5. cancellation and no success/failure: `canceled`;
6. all skipped: `skipped`.

`retryable` is true only for `rate-limited`, normal `timed-out`, or normal
`provider-error` failures after the three-attempt cap, or a clean pre-call
cancellation. It is false when any final failure is authentication,
configuration, final-sync, adapter-health, or unknown-outcome related. A later
run after a terminal result uses a new idempotency key. Unknown outcomes first
require the FIN-9 offline resolution flow.

Terminal jobs write one single-line `JobRunSummary` JSON object to stdout.
Pre-job request/configuration failures write one allowlisted problem to stderr.
The process exits deterministically:

| Exit | Meaning |
| ---: | --- |
| `0` | `succeeded` or `skipped` |
| `1` | `partial` |
| `64` | Invalid arguments, account scope, or configuration |
| `69` | Maintenance, recovery-required, queue, binding, or adapter unavailable |
| `70` | Terminal non-retryable `failed` |
| `75` | Terminal retryable `failed` |
| `76` | `outcome_unknown` |
| `130` | `canceled` without unknown effects |

## Logs and exact FIN-28 tests

Bank-sync logs may contain only the FIN-9 fields: timestamp, severity, stable
event code, job/worker ID, hashed budget scope, account ID when needed,
duration/count, and allowlisted error code. They never contain account names,
provider names or payloads, account numbers, credentials, URLs, transaction
data, exception text, SQL, command lines, or paths.

FIN-28 uses a synthetic accounts snapshot and an injected fake adapter, clock,
jitter source, and signal source. Its focused tests must prove:

- exact ID ordering, requested-scope validation, and closed-account skipping;
- maximum adapter concurrency one and only account-scoped calls;
- the `call -> explicit sync -> retry/finalize -> shutdown -> exit -> next`
  order, including `1000/2000` delays with fixed jitter;
- every row of the retry table and continuation after an ordinary failure;
- soft deadline retaining guards, hard deadline join/quarantine, and unknown
  outcome aborting untouched accounts;
- cancellation before a call versus during a live call;
- exact parent status, retryable flag, JSON summary, and exit table;
- exact replay returning stored results without Actual access; and
- a privacy assertion over all captured logs and errors.

FIN-29 owns scheduler examples and the same failure matrix. Neither ticket adds
a provider, parses provider output, infers transaction counts, or handles
provider credentials.
