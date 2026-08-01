# FIN-61 Bank-Sync HTTP and Maintenance Admission

## Delivered

- `POST /api/v1/jobs/bank-sync` uses the existing loopback, exact Origin,
  owner-session, CSRF, JSON limit, and idempotency protections. It resolves
  account scope through the existing Actual adapter and durable FIN-27 job
  repository. A new run returns `202`; an exact terminal replay returns `200`.
- `GET /api/v1/runs` returns owner- and budget-scoped bank-sync summaries in
  newest-first pages. The default limit is 50, the maximum is 100, and the
  cursor is the last public job ID from the preceding page.
- Every `/api/v1` request holds the existing lifecycle lock until its response
  finishes. CLI maintenance therefore refuses a request-first race, while a
  maintenance-first request receives the stable retryable
  `operation_in_progress` problem. The HTTP bank-sync repository knows the
  request already owns the lock, so it does not acquire a nested lock.
- HTTP bank-sync rows use operation ID
  `finance-companion/http/bank-sync/v1`; CLI and scheduler rows retain
  `finance-companion/job:bank-sync/v1`.

No ledger-mutator endpoint was added. Public responses contain only the frozen
job summary fields and allowlisted problem details.

## Verification

- Finance Companion typecheck passed.
- `bank-sync-http.test.ts`, `bank-sync.test.ts`, and `server.test.ts`: 3 files,
  17 tests passed.
- The HTTP tests use a temporary synthetic companion database and prove route
  authentication/Host/Origin/CSRF, exact replay and conflict behavior,
  timeout and unknown outcomes, pagination bounds, redaction, and both lock
  race orderings.
- Formatter and `git diff --check` passed.
- The complete Finance Companion suite passed: 358 tests passed and four
  platform-specific tests skipped. The production UI/service build passed.
