# FIN-41 Amazon Import and Review Handoff

FIN-41 closes the Amazon import and review workflow. Actual remains the owner
of transactions, accounts, payees, categories, and reconciliation state. This
ticket reads Actual through the FIN-9 adapter and records review state only in
the Finance Companion database. It does not add an Actual mutation.

## Import contract

`POST /api/v1/imports/amazon` uses the existing authenticated, same-origin,
CSRF, multipart, request-size, and idempotency boundaries. A request contains
exactly one uncompressed `.json` Amazon export with `application/json` or
`application/octet-stream`, or one `.eml` message with `message/rfc822` or
`application/octet-stream`. CSV, archives, unsupported media, additional
parts, malformed boundaries, and path-like filenames are rejected before
parsing.

The service uses the first `amazon_profile` source namespace, creating a local
opaque namespace when none exists. Parser results are canonical and receipt
replays return the same privacy-safe status and counts. The response exposes
only the version, parser status, replay flag, receipt status and counts,
allowlisted error code, and number of candidates evaluated. It does not expose
order IDs, item titles, filenames, raw messages, or raw exports.

Caller buffers are zeroed on success, replay, conflict, handler failure,
connection close, and response finish. Multipart temporary files are removed
before parsing, and the raw upload is never persisted or logged.

After a successful or canonical replay with accepted observations, the import
reads the source date range, adds the fixed three-day matching window, and
reads Actual transaction snapshots in at most 64 partitions of at most 90
days each. Every response must match the configured budget key hash and
currency. FIN-40 then performs exact live-target reads before storing match
candidates. These calls are read-only.

## Review contract

The authenticated API is:

- `GET /api/v1/amazon-reviews`
- `GET /api/v1/amazon-reviews/:reviewRef`
- `POST /api/v1/amazon-reviews/:reviewRef/decision`

Review and parent references are HMAC-derived opaque values scoped to the
bound budget. List responses intentionally contain generic candidate labels,
status, score, counts, and timestamps only. Detail responses may contain
sanitized Actual labels and Amazon item titles truncated to 160 characters,
the exact signed allocation graph, reasons, overall and per-parent competitor
counts, and manual guidance. Control characters and unsafe markup never enter
rendered HTML.

Decision bodies are exactly one of `{ "kind": "approve" }`,
`{ "kind": "reject" }`, `{ "kind": "defer" }`, or
`{ "kind": "reopen" }`. Before every decision, the service re-reads every
exact Actual target and verifies that it still exists, is an unreconciled
non-child and non-starting-balance parent, and has the stored target version
hash. A missing, reconciled, or changed target marks the candidate stale and
removes any deferral instead of recording the requested decision.

Approve, reject, defer, and reopen are atomic companion-only transitions. The
repository compares the complete expected candidate graph before updating so
a same-status concurrent rewrite conflicts. A decision does not select,
invalidate, or alter competing candidates. Approval provides manual Actual
guidance because FIN-42 and FIN-44 do not yet authorize an Actual write.

## Schema ownership

Migration 006 creates only a fail-closed `application_receipts` compatibility
parent required by the immutable FIN-40 foreign keys. It accepts a canonical
UUID key shape at the schema level, but an unconditional insert trigger aborts
all inserts, including `INSERT OR IGNORE`; application receipts remain
disabled. A future FIN-44 migration numbered 008 or later must verify the
reserved table is empty, rebuild it under foreign keys, recreate affected
child foreign keys and indexes, and pass `foreign_key_check` before enabling
receipt storage.

Migration 007 adds `amazon_review_deferrals` as companion-only review state.
The effective review status overlays a deferral on a pending match. Reject,
approve, reopen, and stale invalidation remove the overlay as appropriate.

## UI and verification

The `/amazon` shell supports loading, empty, successful import, parser error,
review list, exact detail, stale, reconciled, competing-candidate, and decision
states. Decisions require an explicit confirmation dialog and have no default
selection. Focus moves to load or mutation outcomes, Escape and Cancel return
focus to the opening button, and the layout contains maximum-length titles and
filenames at a 390-pixel viewport.

Focused coverage lives in:

- `amazon-import-service.test.ts`
- `amazon-review-service.test.ts`
- `amazon-review-http.test.ts`
- `amazon-review-ui.test.ts`
- the existing database, HTTP security, idempotency, parser, and FIN-40 matcher
  suites

The package typecheck, production build, and full test suite are the merge
gates. The browser check uses a 160-character unbroken hostile item title and
a long selected filename at 390 pixels, verifies no horizontal overflow or
markup execution, and verifies confirmation focus, Escape restoration, and no
automatic decision request.
