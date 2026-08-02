# Native OpenAI transaction categorization

## Decision

Add a native **Auto-categorize** action to Actual's transaction list. It produces a reviewable category proposal for a caller-selected set of expense transactions and applies approved proposals through Actual's existing transaction-edit and undo path.

Classification is performed by OpenAI's Responses API through the Actual sync server. The default model is the cost-sensitive `gpt-5.6-luna` requested for this product; administrators can select another Responses-compatible model in the feature settings. Do not hard-code pricing or promise a price: the UI labels the default as cost-sensitive and links to the model setting.

This is an opt-in, server-backed integration. It is unavailable in a local-only browser session because an OpenAI key must not be retained in browser storage or sent by the browser. Actual continues to work normally without it.

## User experience

### Configure once

An authenticated server administrator opens **Settings > Integrations > OpenAI categorization** and can:

- enter or replace an OpenAI API key (the value is accepted once, then shown only as a masked suffix and a configured state);
- choose the model, initially `gpt-5.6-luna`;
- edit the categorization instruction; and
- select the categories this integration may assign and add a short, editable instruction for each selected category.

The category picker reads categories from the currently open Actual budget. A category is never an LLM candidate unless it is enabled in this allowlist. A removed, hidden, or no-longer-allowed category invalidates an un-applied proposal rather than being silently replaced.

The supplied instruction is product-level guidance (for example, "classify work travel separately from household purchases"), while category guidance explains the boundary of a particular category. Actual adds mandatory instructions that transaction and category text are untrusted data, output must use the supplied opaque IDs, and the model must not select an unknown category.

### Choose scope and generate a preview

The transaction-list toolbar action opens an **Auto-categorize** dialog. The dialog has exactly these mutually exclusive scopes:

| Scope          | Candidate set                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------- |
| Selected rows  | Rows selected in the current transaction table.                                               |
| Current filter | All eligible rows in the current table query/filter, including rows outside the visible page. |
| Date range     | Eligible rows whose transaction date is in an inclusive start/end range.                      |
| All eligible   | Every eligible expense transaction in the open budget.                                        |

The dialog displays the resolved candidate count before sending anything. Its **Include already categorized expenses** checkbox is off by default. With it off, only rows without a category are candidates. With it on, categorised ordinary expenses are also candidates and can receive a proposed replacement; the preview always shows the current category and highlights a proposed change.

Eligible means a non-deleted, non-transfer, non-split-parent expense transaction with a non-zero amount. Income, transfers, split transactions, child split lines, and transactions with a missing description/payee are skipped and reported with their reason. This avoids using an LLM to make destructive decisions for accounting structures that need a human decision.

Before **Generate preview** is enabled, the dialog shows a short disclosure:

> Descriptions, payees, dates, amounts, currency, account names, your selected category names and guidance, and your custom instruction will be sent to OpenAI to generate suggestions. No OpenAI API key, Actual transaction IDs, notes, attachments, balances, budget name, or unselected transactions are sent.

The caller must explicitly accept this disclosure for each run. The setting page also contains the disclosure and a link to OpenAI's data controls/privacy information.

### Review, apply, and undo

The review view contains each candidate's description/payee, date, amount, current category, suggested category, confidence (`high`, `medium`, or `low`), and one concise explanation. No change has been made while this view is open.

- All suggestions begin selected only when confidence is `high`; medium and low suggestions require an explicit row selection.
- The user can select/deselect rows, filter by confidence, and choose **Apply selected**.
- **Apply selected** rechecks each transaction before editing it. Changed, deleted, split, transferred, or now-disallowed candidates are skipped and called out; no stale proposal is applied.
- Applying uses one existing Actual transaction mutation/undo group, so a single Actual undo restores every category changed by that apply operation. A partial apply is still one undo group for the successfully changed rows.
- Closing, canceling, a server restart, or changing the scope does not alter transactions. A new preview supersedes the old one.

There is deliberately no automatic background application in the first release. "Auto" means bulk LLM-assisted categorization, followed by user review.

## Privacy, credentials, and access control

The browser never receives the OpenAI API key after initial submission. The sync server owns the configuration and makes the outbound HTTPS call to OpenAI. To keep setup simple, `OPENAI_API_KEY` is the optional operator override; otherwise the authenticated settings screen writes one dedicated key file beneath Actual's existing server data directory. The key:

- is accepted only over the existing authenticated Actual server connection;
- is stored in one server-local secret file with owner-only permissions where the platform supports them, without requiring a second encryption key;
- is never returned by a read endpoint, included in sync data, browser storage, exports, telemetry, errors, or logs; and
- can be rotated and deleted. Deletion immediately disables new previews and leaves already-created previews unapplied.

If `OPENAI_API_KEY` is set, the UI reports an operator-managed configured state and does not overwrite it. Otherwise an existing administrator/owner can replace or delete the server-local key through Settings. The server must use Actual's established role check rather than inventing a second identity system. The documentation tells self-hosters to protect the Actual data directory because the API key must be recoverable by the running server.

Request logging records only request ID, candidate count, model, elapsed time, outcome, and error class. It must not record prompts, category guidance, transaction fields, raw model output, or credentials.

## Data contract and Responses API

The browser resolves the scope from its local budget and sends the server a candidate payload without a raw Actual transaction ID. It assigns an opaque per-preview `candidate_id` and retains the local mapping. The server receives and forwards to OpenAI only:

```text
candidate_id
transaction date (YYYY-MM-DD)
signed amount in the budget currency's minor-unit-safe decimal representation
ISO currency code
payee, if present
imported/original description, if present
account display name, if present
enabled categories: opaque category_id, display name, category guidance
the administrator's editable categorization instruction
```

The classifier request does not include Actual transaction/budget IDs, existing category, notes, attachments, running balances, schedules, other transaction history, or any unselected candidate. The current category is used locally to decide eligibility and display review changes; it is not needed for a new LLM decision. Neither side sends a transaction field that is absent.

Use the Responses API with a server-side request, `store: false`, the chosen model, and strict JSON Schema structured output (`text.format` with `type: json_schema`). Transaction strings and editable guidance are serialized as data, not interpolated as instructions. The schema is:

```json
{
  "name": "transaction_category_proposals",
  "strict": true,
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["proposals"],
    "properties": {
      "proposals": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "candidate_id",
            "category_id",
            "confidence",
            "explanation"
          ],
          "properties": {
            "candidate_id": { "type": "string" },
            "category_id": { "type": ["string", "null"] },
            "confidence": {
              "type": "string",
              "enum": ["high", "medium", "low"]
            },
            "explanation": { "type": "string", "maxLength": 240 }
          }
        }
      }
    }
  }
}
```

`category_id: null` means "do not suggest a category." The server validates every returned ID against the preview candidate and allowlist, verifies exactly one proposal for every candidate, bounds explanation length, and rejects malformed/incomplete responses. The browser independently repeats category-ID and staleness checks before mutation. Model confidence is advisory, never an authorization to mutate.

## Batching, cost, failures, and rate limits

One preview runs at a time per browser session. The client divides the resolved candidates into batches of at most 25 and submits them sequentially to the server. The review opens after every batch succeeds, or with the completed batches when a later batch fails or the user stops the run. This keeps category context bounded, permits progress ("50 of 173 analyzed"), avoids a persistent job/queue for the first release, and makes cancellation immediate before the next batch.

The dialog estimates request count from the candidate count and displays it before confirmation. It does not claim an invented dollar estimate because model pricing may change and the custom prompt/category text affects token use. The server returns OpenAI usage when available for a completed run so the review can display actual input/output token counts.

- A 429 or transient 5xx is retried at most twice using `Retry-After` when supplied, otherwise capped exponential backoff with jitter. The UI stays cancellable.
- Authentication/configuration errors stop the run and direct the user to settings without exposing key details.
- A malformed, refused, incomplete, or disallowed response fails only that batch; already received proposals remain reviewable and the dialog shows how many expenses were not analyzed. The user starts a new preview to retry them.
- Network timeouts and user cancellation stop future batches without applying anything. No preview is silently resumed after reload.
- A server-side per-user/budget rate limit prevents concurrent expensive previews; the response tells the UI when it may retry.

The initial client limit is 5,000 candidates per all-eligible/date/filter run. Above that, Actual asks the user to narrow the scope. This preserves a responsive UI and avoids an unbounded bill; selected rows are subject to the same cap. The limit and batch size are implementation constants with focused tests, not user-facing model parameters.

## Actual integration boundary

The native transaction-list feature owns scope selection, eligibility, the preview state, and writes. The sync-server endpoint is only an LLM proxy/configuration boundary:

1. Client reads the already-loaded Actual transactions and creates opaque candidate IDs plus a local snapshot fingerprint of `date`, `amount`, `payee`, `imported description`, `category`, and split/transfer state.
2. Client calls the authenticated server categorization endpoint for a batch; the server reads the encrypted server configuration and returns validated proposals keyed by opaque candidate ID.
3. Client presents all results. Immediately before apply, it reloads/compares the local transaction against the snapshot and current allowlist.
4. For each valid selected proposal, the client uses the existing Actual transaction-category update action inside one existing undo transaction. Normal Actual sync/conflict handling carries these native edits to other devices.

The endpoint must not update Actual transactions itself. That keeps write behavior, audit expectations, conflict behavior, and undo consistent with any other category change made in Actual.

## Test plan

Unit tests cover candidate resolution for all four scopes, default/existing-category behavior, exclusions, allowlist validation, snapshot staleness, partial apply, and a single undo group. Server tests cover environment/file precedence, secure file creation/replacement/deletion, authorization, redacted logs, exact outbound payload construction, structured-output validation, invalid/missing/duplicate IDs, retry/cancel/rate-limit behavior, and no-key-return responses. Responses API calls are mocked at the HTTP boundary with fixtures; tests assert `store: false` and JSON Schema use without contacting OpenAI.

Focused browser tests use a demo budget and mock server responses to verify configuration masking, the per-run privacy acknowledgement, selected/current-filter/date/all flows, preview-before-write, high-confidence default selection, manual row selection, stale skipped rows, native undo, and a categorized row changing only when the checkbox is enabled. No test uses a real OpenAI key or transaction data.

## Acceptance criteria

- A configured administrator can use a native Actual transaction-list action to preview LLM category proposals for selected rows, current filter, inclusive date range, or all eligible expenses.
- The action sends only the documented minimal fields after per-run disclosure acknowledgement, calls the configurable default `gpt-5.6-luna` through the server with `store: false` and strict structured output, and never exposes the API key to the browser or logs.
- Only categories selected in the editable allowlist can be proposed or applied; editable global and category guidance influence the request.
- Already-categorized transactions are skipped by default and included only when explicitly selected.
- No category changes before the user applies the preview. Apply uses native Actual edits, skips stale rows, and one Actual undo reverses the successful batch.
- Invalid model output, failed batches, cancellation, rate limiting, and credential failures leave transactions unchanged and present a useful retry/configuration path.
- Focused unit, server, and browser tests cover the security and financial-write behavior above.

## OpenAI references

- [Models](https://developers.openai.com/api/docs/models)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Responses API text generation](https://developers.openai.com/api/docs/guides/text)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
