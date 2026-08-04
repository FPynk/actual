# Native receipt ingestion and OCR pipeline

Status: implementation contract for FIN-83 through FIN-90  
Design owner: FIN-84  
Target: the single native Actual application

## 1. Outcome and non-negotiable behavior

Actual will accept receipt images, transcribe them locally, let the user correct the
result, persist the reviewed text and structured fields in the open budget, rank matching
transactions, and link a receipt only after explicit confirmation. A linked, reviewed
receipt can provide bounded evidence to the existing preview-first OpenAI categorization
workflow.

The default OCR path never uploads the image. Raw image bytes are temporary and are never
stored in the budget, backups, sync messages, browser storage, logs, analytics, or the
transaction Notes field. Receipt OCR works without an API key, companion process, second
database, login, or URL.

## 2. Decisions

1. **Primary OCR:** use the official
   [`@paddleocr/paddleocr-js`](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js)
   SDK in a dedicated browser Web Worker. Pin the SDK and its mobile English PP-OCRv5
   detection, direction, and recognition models.
2. **Local fallback:** use [Tesseract.js](https://github.com/naptha/tesseract.js) with
   pinned English language data only when PaddleOCR cannot initialize or the user chooses
   **Retry with alternate local OCR**. Do not merge two engines' output automatically.
3. **Optional online fallback:** show **Try OpenAI Vision** only after local OCR fails or
   produces a visibly low-confidence draft. Require per-receipt disclosure and consent.
   Use the existing server-owned key and `store: false`; do not retain the image.
4. **Parsing:** derive merchant, date, total, currency, payment hints, and line items from
   local OCR word boxes with deterministic code. An LLM is not required for the draft.
5. **Review:** OCR output is always editable. Nothing persists or links until the user
   explicitly saves or attaches it.
6. **Persistence:** add one bounded `receipts` table to the existing budget `db.sqlite`
   and use Actual's database helpers and CRDT sync. Do not use `finance` metadata: it is
   backed up, but later edits are not incrementally synchronized between devices.
7. **Cardinality:** one active receipt links to at most one current transaction, and one
   current transaction has at most one active receipt in v1. Split-tender and multi-receipt
   cases remain unmatched/manual-review cases.
8. **Categorization:** send only bounded, reviewed receipt fields to OpenAI, never the
   image, complete transcript, payment hints, OCR boxes, or provider metadata.

## 3. End-to-end architecture

```text
local image
  -> UI validation and decode
  -> receipt OCR Web Worker
  -> local preprocessing
  -> PaddleOCR.js (or explicit Tesseract.js retry)
  -> word boxes and confidence
  -> deterministic parser and sensitive-number redaction
  -> editable unsaved draft
  -> explicit Save receipt
  -> native receipts table and CRDT sync
  -> deterministic ranked transaction candidates
  -> explicit Attach receipt
  -> optional bounded receipt evidence in auto-categorization preview
```

OpenAI Vision is a separate explicit fallback from an error or low-confidence state, not
part of the normal flow.

## 4. Input contract

| Limit | v1 contract |
| --- | --- |
| Formats | JPEG, PNG, non-animated WebP |
| Per-image source size | 8 MiB maximum |
| Decoded size | 24 megapixels; neither dimension over 8192 pixels |
| OCR working image | Downscale to 2400-pixel longest edge; never upscale |
| Batch | 10 images maximum, processed sequentially |
| Concurrency | One active OCR job per Actual tab |
| OCR timeout | 30 seconds after models are ready |
| Local retry | One enhanced pass, then user-directed alternate engine |
| Online fallback | One request; retry once only for timeout, 429, or 5xx |

The UI verifies the declared MIME type, magic bytes, decoded frame count, dimensions, and
pixel count before inference. Decode failure, animation, unsupported data, or a limit
failure stops locally. Extensions alone are never trusted.

Compute SHA-256 over source bytes for duplicate detection. A temporary object URL may be
used for preview and must be revoked on removal, navigation, successful save, cancellation,
or failure cleanup.

## 5. Local worker and engine boundary

Create `packages/desktop-client/src/receipt-ocr/receiptOcr.worker.ts` as a Vite module
worker. Transfer the `ImageBitmap` or source buffer when supported. The worker returns
plain structured-cloneable values and never calls Actual's backend RPC.

```ts
type ReceiptOcrWorkerRequest =
  | { type: 'initialize'; engine: 'paddle' | 'tesseract' }
  | { type: 'extract'; jobId: string; image: ImageBitmap; options: ReceiptOcrOptions }
  | { type: 'cancel'; jobId: string }
  | { type: 'dispose' };
```

Responses are `ready`, `progress`, `draft`, `cancelled`, or `error`, with `jobId` where
applicable. Errors contain a bounded code and safe message, never image or OCR content.

Define the vendor-neutral interface in
`packages/desktop-client/src/receipt-ocr/receiptOcrEngine.ts`:

```ts
type ReceiptOcrEngine = {
  initialize(signal: AbortSignal): Promise<ReceiptOcrEngineRevision>;
  recognize(image: ImageBitmap, signal: AbortSignal): Promise<ReceiptOcrPage>;
  dispose(): Promise<void>;
};
```

`PaddleReceiptOcrEngine` and `TesseractReceiptOcrEngine` implement it. The parser, UI,
persistence, matching, and categorization layers do not import either vendor SDK.

### Self-hosted assets

All JavaScript, WASM, model, and language files are pinned and served from the same Actual
origin under `/ocr/`. Runtime CDN URLs are forbidden. Add a focused staging step to
`packages/desktop-client/vite.config.mts` that copies assets into browser and desktop
builds and emits a manifest containing path, size, engine revision, and SHA-256.

Load assets lazily on first receipt use. Cache same-origin model responses only after
integrity verification. Do not add large `.onnx` files to the current PWA precache until
its extension and size rules are deliberately updated. Use single-threaded WASM when
`crossOriginIsolated` is false; otherwise cap OCR at two threads.

Production verification must prove every asset is packaged and that OCR never contacts
GitHub, jsDelivr, unpkg, or another third party.

## 6. Preprocessing and parsing

Preprocessing is deterministic and local:

1. apply EXIF orientation during decode;
2. downscale with high-quality canvas resampling;
3. normalize transparency onto white;
4. run the primary engine on the color image;
5. if coverage or mean confidence is low, retry once with grayscale, contrast
   normalization, and conservative sharpening; and
6. correct only clear 90/180/270-degree orientation or deskew up to 10 degrees.

The enhanced result replaces the first only when coverage improves without weakening
total/date evidence. Otherwise retain the first result and show a warning.

The OCR engine returns short text spans with normalized boxes, recognition confidence,
line direction, and page dimensions. Boxes exist only in the draft and are never persisted.

`packages/desktop-client/src/receipt-ocr/parseReceiptOcr.ts`:

1. clusters spans into reading-order lines using vertical overlap;
2. preserves original line text while normalizing whitespace for comparisons;
3. treats the upper receipt region as merchant evidence;
4. parses locale-aware dates without silently resolving ambiguous day/month order;
5. ranks `TOTAL`, `GRAND TOTAL`, and `AMOUNT DUE`, excluding `SUBTOTAL`, `TAX`, `TIP`,
   `CHANGE`, `CASH`, and savings lines from the primary total;
6. derives currency from explicit codes/symbols and otherwise uses budget currency with an
   `assumed-currency` warning;
7. identifies line items from description text followed by a right-aligned amount while
   excluding header, total, payment, loyalty, and footer regions; and
8. extracts only bounded source hints such as card brand and last four digits.

Ambiguous dates/decimals, conflicting totals, missing fields, low confidence, and truncated
items produce visible warnings and prevent automatic candidate preselection. The user may
still correct and save the draft.

## 7. Draft schema, bounds, and redaction

`packages/loot-core/src/types/receipts.ts` owns shared types and limits.
`packages/loot-core/src/shared/receipts.ts` owns normalization, validation, redaction,
canonical serialization, and fingerprint helpers.

The draft contains source hash; normalized and original merchant; purchase date and
optional time; ISO currency; integer minor-unit total/subtotal/tax/tip; payment hint; line
items; redacted transcript; field confidence/warnings; OCR/model/parser revisions; and
temporary boxes.

| Field | Bound after normalization |
| --- | --- |
| Merchant | 256 Unicode code points |
| Transcript | 32,000 Unicode code points |
| Line items | 200 |
| Line-item label | 256 Unicode code points |
| Warnings | 32 entries of 256 code points |
| Payment/source hint | 128 Unicode code points |
| Integer amount | absolute value at most 10^12 minor units |
| Confidence | finite number from 0 through 1 |

Mask sequences resembling payment-card or bank identifiers before saving. Last four digits
may remain only in the bounded source hint. Redaction cannot be disabled in v1.

Saving drops boxes and adds UUID, review timestamp, timestamps, transcript revision, and a
fingerprint over canonical reviewed fields. Editing any reviewed field increments revision
and changes the fingerprint.

## 8. Persistence, sync, backup, and undo

FIN-85 adds an idempotent migration for one `receipts` row per reviewed receipt:

```text
id, transaction_id, source_hash, merchant, purchase_date, purchase_time,
currency, total, subtotal, tax, tip, payment_hint, line_items, transcript,
confidence, warnings, ocr_engine, ocr_revision, parser_revision,
transcript_revision, fingerprint, reviewed_at, created_at, updated_at, tombstone
```

Store bounded line items and warnings as validated JSON. Add the table to AQL/schema and
database types. Use `db.insert`, `db.update`, and `db.delete_` so CRDT messages are emitted.
Do not add foreign-key or unique constraints: concurrent device changes must never make
sync fail. Add non-unique indexes for active source hash and transaction lookups. Handlers
re-read current rows to enforce duplicate and link rules.

Typed handlers in `packages/loot-core/src/server/receipts/app.ts` are:

- `receipts/list` and `receipts/get`;
- `receipts/save-reviewed` and `receipts/delete`;
- `receipts/match-candidates`; and
- `receipts/link`, `receipts/unlink`, and `receipts/reassign`.

Reads require an open budget. User-visible mutations use `mutator(undoable(...))`, include
the expected budget ID, and re-read receipt, transaction, content hash, link state, and
fingerprints immediately before writing.

Because the table is in `db.sqlite`, close/reopen, backup/restore, cloud export, and CRDT
sync include reviewed receipts. Raw images are in none of those paths. Deletion tombstones
a receipt. A tombstoned transaction leaves its receipt visibly orphaned for reassignment.
A concurrent conflict that links two receipts to one transaction is shown as a conflict;
neither may enrich categorization until resolved.

## 9. State machine and cleanup

```text
selected -> validating -> queued -> initializing -> extracting -> review
review -> saving -> saved-unmatched -> matching -> linked
any transient state -> cancelled
validation/initialization/extraction/save/match -> error -> retry or remove
review/error -> optional-consent -> online-fallback -> review or error
linked -> editing -> linked
linked -> unlinking -> saved-unmatched
```

Only `saving` creates a row. Only explicit link/reassign/unlink actions change association.
Reloading during OCR loses the unsaved draft by design and leaves no partial record.

Cancellation aborts inference when supported and terminates/recreates the worker otherwise.
Every terminal path closes `ImageBitmap`, clears canvas/buffers, revokes object URLs, and
disposes an unsafe engine instance.

## 10. Optional OpenAI Vision fallback

Show the fallback only after local failure or low confidence. Before every upload show:

> This fallback sends this receipt image to OpenAI for transcription. It may contain
> merchant, purchase, and partial payment information and may incur API charges. Actual
> does not retain the image; the request uses OpenAI `store: false`.

Consent is per receipt and not remembered globally. Both browser and server validate MIME
signature, size, dimensions, and decoded pixels. The existing authenticated finance
gateway uses strict structured output, treats receipt text as untrusted data, redacts logs,
and records no provider IDs. Success returns an editable draft only.

Timeout, refusal, malformed output, cancellation, or exhausted retry releases buffers and
leaves any local draft intact. Provider output passes through the same validator and
redactor as local OCR.

## 11. Deterministic transaction matching

FIN-87 considers current expense transactions that are not tombstoned, transfers, starting
balances, split parents/children, or already linked to another active receipt. Return at
most 25 candidates. First filter by currency, positive receipt total versus Actual's signed
expense amount, and a seven-day date window. A near total differs by at most the greater of
100 minor units or 2% of the receipt total.

| Evidence | Score |
| --- | ---: |
| Exact total and currency | +50 |
| Same date | +20 |
| One day apart | +12 |
| Two or three days apart | +6 |
| Four through seven days apart | +2 |
| Normalized merchant/payee similarity | up to +20 |
| Account/payment-source agreement | up to +10 |
| Near rather than exact total | amount contribution capped at +20 |

Preselect only a unique candidate with exact total/currency, date within one day,
non-conflicting merchant evidence, score at least 80, and margin at least 15. Preselection
never writes. Near totals, ties, missing/ambiguous dates, merchant conflict, low-confidence
total, split tender, reused targets, and stale fingerprints require manual selection.
Confirmation re-reads both records and rejects changed, deleted, linked, or wrong-budget
targets without a partial write.

## 12. Native UI

FIN-88 adds `/receipts` to `FinancesApp`, a **Receipts** item under More, **Upload receipt**
from transaction surfaces, and a receipt indicator/viewer.

The page supports multi-image selection/drag-drop, sequential progress/cancellation, local
processing without an API key, editable structured fields and transcript, field-level
confidence/warnings, an in-memory image preview, ranked candidates/manual search, explicit
save/attach/reassign/unlink/delete, and optional fallback disclosure only when applicable.

The review is keyboard and screen-reader usable, restores focus after progress/errors, has
a scrollable transcript editor, and remains readable at 350 pixels and 125% zoom. Failed
images remain recoverable until removed or the page is left.

## 13. Auto-categorization enrichment

FIN-89 adds receipt evidence only when the receipt is reviewed, linked, non-conflicted,
and the existing OpenAI disclosure is accepted. At most send:

- receipt ID and revision/fingerprint for staleness;
- normalized merchant capped at 128 code points; and
- 40 line items with 120-code-point labels, optional quantity, and integer amount.

Exclude image, boxes, full transcript, warnings, payment hints, dates, card fragments, and
OCR/provider metadata. Cap evidence at 8 KiB per transaction and delimit receipt strings
as untrusted data.

Propose one allowed category only when it represents more than half of attributable item
spend; use item count only when reliable amounts are unavailable. Mixed, truncated,
low-confidence, or unclear baskets produce no receipt-driven category. Explain when receipt
evidence mattered.

Include receipt ID/revision/fingerprint in the preview fingerprint. Apply re-reads current
receipt and transaction state; edit, reassign, unlink, delete, or conflict makes the preview
stale. Existing preview, selection, apply, and undo behavior remains unchanged.

## 14. Privacy and security

- Local mode makes no third-party request. Network tests fail if it contacts anything
  except same-origin `/ocr/` assets.
- Assets are pinned and self-hosted; arbitrary model/runtime URLs are rejected.
- Image and OCR text are untrusted input and cannot instruct the parser, matcher, fallback,
  or categorizer.
- Logs contain event names, engine revision, duration buckets, and error codes only. Never
  log image/base64, transcript, merchant, amounts, hashes, keys, or provider IDs.
- Receipt handlers verify expected budget identity and current fingerprints before writes.
- Receipt CRUD never overwrites transaction Notes or financial values.
- Tests use synthetic receipt images and synthetic transactions only.

## 15. Quality and performance gates

FIN-86 benchmarks both local engines behind the same adapter using at least 30 deterministic
synthetic receipts: narrow/wide layouts, multiple fonts, rotation, perspective, low
contrast, shadows/noise, tax/tip, discounts, ambiguous totals, and missing fields.

PaddleOCR remains primary when the pinned browser build achieves:

- exact total on at least 95% of clear/medium fixtures;
- exact unambiguous date on at least 90%;
- usable merchant on at least 85%;
- no crash or silent success on degraded fixtures;
- cold initialization plus one image at p95 no slower than 20 seconds;
- warm extraction at p95 no slower than 10 seconds; and
- cancellation that releases worker and image resources.

Poor fixtures may require correction; they must warn rather than emit false high-confidence
fields. If PaddleOCR fails a gate and Tesseract passes, swap the adapter selection without
redesigning persistence, UI, matching, or categorization.

## 16. Verification

Unit/integration coverage includes input validation; orientation/preprocessing; worker
initialization, integrity, progress, timeout, cancellation, and disposal; parser date and
amount locales; totals/tax/tip/change; redaction/bounds; fingerprints/revisions; migration,
CRUD, duplicates, restart, backup/restore, CRDT sync, tombstone, undo, and link conflicts;
matcher exact/near/tie/stale cases; and categorization majority, truncation, injection-like
text, disclosure, staleness, apply, and undo.

Browser E2E uses synthetic images through the normal Actual URL to upload, OCR, correct,
save unmatched, rank/attach, manually resolve ambiguity, close/reopen, view/edit/reassign/
unlink/delete, categorize with and without receipt evidence, cancel, recover from local
failure, and mock optional Vision success/refusal/malformed/timeout/retry.

Network and log assertions prove local OCR does not upload images and sensitive fields are
absent. Production browser/server builds must contain the documented assets and start with
the existing Actual command and no companion process.

## 17. Ticket ownership and parallel execution

| Ticket | Ownership |
| --- | --- |
| FIN-84 | This contract and downstream assumption updates |
| FIN-85 | Migration/schema, CRDT receipt CRUD/link handlers, backup/sync tests |
| FIN-86 | Assets, worker, engine adapters, preprocessing/parser, optional Vision, benchmarks |
| FIN-87 | Matcher, scores/reasons, candidate query, stale confirmation |
| FIN-88 | Route/navigation, queue, review, matching UI, indicator/viewer |
| FIN-89 | Bounded evidence, disclosure, prompt/types, staleness, apply/undo |
| FIN-90 | Cross-ticket E2E, privacy/log audit, builds, README/user guide |

After FIN-84, FIN-85, FIN-86, and FIN-87 can run in parallel. FIN-88 integrates after
their contracts stabilize. FIN-89 starts from FIN-85's record contract. FIN-90 runs after
FIN-85 through FIN-89 merge.

## 18. Existing Actual seams to reuse

- `packages/loot-core/src/server/prefs.ts` and `types/prefs.ts` define the current
  `finance` metadata. It is backup metadata, not the receipt store, because only whitelisted
  metadata fields emit incremental sync messages.
- `packages/loot-core/src/server/budgetfiles/backups.ts` and
  `server/cloud-storage.ts` already carry `db.sqlite` through backup, restore, and export.
- `packages/loot-core/src/server/db/index.ts` emits CRDT messages for normal table writes;
  `server/sync/index.ts` applies table/row/column messages. FIN-85 must use these helpers.
- `packages/loot-core/migrations/`, `server/aql/schema/index.ts`, and
  `server/db/types/index.ts` are the migration, sync schema, and database type seams.
- `packages/loot-core/src/server/tags/app.ts` is the small typed read/mutator/undo handler
  pattern; `types/handlers.ts` and `server/main.ts` register the handler contract.
- `packages/loot-core/src/server/finance/reconciliation.ts` provides the closest existing
  pure evidence/score/reason/fingerprint matcher pattern. Receipt matching remains a
  separate module because its amount and date semantics differ.
- `packages/loot-core/src/shared/finance-categorization.ts`,
  `server/finance/categorization.ts`, `server/finance/app.ts`, and
  `packages/sync-server/src/app-finance.js` own candidate fingerprints, apply-time
  validation, the authenticated finance boundary, strict provider validation, and prompts.
- `packages/desktop-client/src/components/FinancesApp.tsx` and
  `components/sidebar/PrimaryButtons.tsx` own native route and More-navigation insertion.
- `packages/desktop-client/vite.config.mts` already stages worker/dependency assets and is
  the single build seam for same-origin OCR runtime/model files.

## 19. Non-goals for v1

- storing or synchronizing original images;
- PDF, HEIC, email, or camera-specific ingestion;
- automatic linking;
- split-tender or many-to-one receipt linking;
- cloud OCR as the default;
- model training/fine-tuning;
- a generic attachment framework; or
- a separate Finance Companion service.
