# Native receipt ingestion and OCR pipeline

Status: implementation contract for FIN-83 through FIN-90  
Design owner: FIN-84  
Target: the single native Actual application
Revision: 2026-08-04, one local PaddleOCR path

## 1. Outcome and non-negotiable behavior

Actual will accept receipt images, transcribe them locally, let the user correct the
result, persist the reviewed text and structured fields in the open budget, rank matching
transactions, and link a receipt only after explicit confirmation. A linked, reviewed
receipt can provide bounded evidence to the existing preview-first OpenAI categorization
workflow.

The OCR operation never uploads the image or OCR text. Raw image bytes are temporary and
are never stored in the budget, backups, sync messages, browser storage, logs, analytics,
or the transaction Notes field. Receipt OCR works without an API key, companion process,
second database, login, or URL. The existing auto-categorization workflow may later send
only the bounded reviewed receipt evidence defined in section 13.

## 2. Decisions

1. **OCR:** use the official
   [`@paddleocr/paddleocr-js`](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js)
   in its built-in worker mode. Pin the SDK and PP-OCRv5 mobile detection and
   recognition models. PaddleOCR is the only OCR engine in v1; there is no alternate local
   engine or cloud-image transcription path.
2. **Integration:** call `PaddleOCR.create({ worker: true })` behind one thin
   receipt-specific module. Do not create a vendor-neutral engine framework or a second
   application-owned inference worker.
3. **Input preparation:** Actual validates and decodes the image, honors EXIF orientation,
   downsizes it once, and flattens transparency onto white. PaddleOCR.js owns its
   model-specific OpenCV preprocessing, text detection, text-region rectification, and
   recognition. V1 does not add automatic enhancement, orientation classification,
   unwarping, or deskewing.
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

### Why PaddleOCR

PaddleOCR was chosen because PaddlePaddle publishes an official browser SDK that:

- runs detection and recognition locally through ONNX Runtime Web and OpenCV.js;
- has a supported dedicated-worker mode and accepts browser-native image inputs;
- returns polygon coordinates, text, and confidence scores needed for receipt review and
  deterministic field parsing; and
- avoids a Python OCR service, a second application, and receipt-image uploads.

This choice is based on its simple browser integration and privacy fit, not an assumption
that it is universally the most accurate OCR engine. FIN-86 must benchmark the pinned SDK
and model pair against synthetic receipt fixtures before the feature is accepted. The
current browser SDK implements detection and recognition; unlike PaddleOCR's Python
pipeline, it does not currently implement document orientation classification, document
unwarping, or text-line direction classification.

## 3. End-to-end architecture

```text
local image
  -> UI validation and decode
  -> bounded browser preparation
  -> PaddleOCR.js built-in worker
  -> word boxes and confidence
  -> deterministic parser and sensitive-number redaction
  -> editable unsaved draft
  -> explicit Save receipt
  -> native receipts table and CRDT sync
  -> deterministic ranked transaction candidates
  -> explicit Attach receipt
  -> optional bounded receipt evidence in auto-categorization preview
```

There is no alternate OCR path. Low-confidence output remains an editable draft; the user
can rotate the preview in 90-degree steps and rerun the same PaddleOCR pipeline, choose a
clearer image, enter or correct text manually, or remove the image.

## 4. Input contract

| Limit                 | v1 contract                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| Formats               | JPEG, PNG, non-animated WebP                                                    |
| Per-image source size | 8 MiB maximum                                                                   |
| Decoded size          | 24 megapixels; neither dimension over 8192 pixels                               |
| OCR working image     | Downscale to 2400-pixel longest edge; never upscale                             |
| Batch                 | 10 images maximum, processed sequentially                                       |
| Concurrency           | One active OCR job per Actual tab                                               |
| OCR timeout           | 30 seconds after models are ready                                               |
| Retry                 | Same pinned PaddleOCR pipeline after manual rotation or worker reinitialization |

The UI verifies the declared MIME type, magic bytes, decoded frame count, dimensions, and
pixel count before inference. Decode failure, animation, unsupported data, or a limit
failure stops locally. Extensions alone are never trusted.

Compute SHA-256 over source bytes for duplicate detection. A temporary object URL may be
used for preview and must be revoked on removal, navigation, successful save, cancellation,
or failure cleanup.

## 5. PaddleOCR worker integration

Create `packages/desktop-client/src/receipt-ocr/receiptOcr.ts` as a thin receipt-specific
wrapper around the SDK. Use PaddleOCR.js's built-in worker mode rather than layering an
additional inference worker:

```ts
const paddleOcr = await PaddleOCR.create({
  textDetectionModelName: 'PP-OCRv5_mobile_det',
  textDetectionModelAsset: { url: '/ocr/models/pp-ocrv5-mobile-det.tar' },
  textRecognitionModelName: 'PP-OCRv5_mobile_rec',
  textRecognitionModelAsset: { url: '/ocr/models/pp-ocrv5-mobile-rec.tar' },
  worker: true,
  ortOptions: { backend: 'wasm', wasmPaths: '/ocr/ort/' },
});
```

The wrapper owns initialization, one `predict` call at a time, conversion of SDK results
to Actual's bounded draft type, stale-job rejection, and `dispose`. PaddleOCR.js returns
pixel polygons, text, and confidence; Actual normalizes polygon coordinates before using
them. Errors contain a bounded code and safe message, never image or OCR content.

The SDK has no documented `AbortSignal` extraction API. Cancellation therefore marks the
job stale, disposes the SDK worker/runtime, releases the image, and lazily initializes a
fresh instance for the next job.

### Self-hosted assets

All JavaScript, WASM, and model files are pinned and served from the same Actual
origin under `/ocr/`. Runtime CDN URLs are forbidden. Add a focused staging step to
`packages/desktop-client/vite.config.mts` that copies assets into browser and desktop
builds and emits a manifest containing path, size, SDK/model revision, and SHA-256.
Explicit same-origin model URLs and `ortOptions.wasmPaths` are mandatory because the SDK's
defaults may otherwise download models or worker WASM from third-party hosts. Model archives
remain in the SDK's documented uncompressed tar format and contain `inference.onnx` and
`inference.yml`.

Load assets lazily on first receipt use. Cache same-origin model responses only after
integrity verification. Do not add large `.onnx` files to the current PWA precache until
its extension and size rules are deliberately updated. Use single-threaded WASM when
`crossOriginIsolated` is false; otherwise cap OCR at two threads.

Production verification must prove every asset is packaged and that OCR never contacts
GitHub, jsDelivr, unpkg, or another third party.

## 6. Preprocessing and parsing

Actual performs only conventional, bounded preparation before OCR:

1. validate and decode with browser APIs while honoring EXIF orientation;
2. downscale once to the working-image limit with high-quality canvas resampling; and
3. flatten transparency onto a white background.

PaddleOCR.js then performs the model-required OpenCV color conversion, resizing and
normalization, detects text polygons, rectifies detected text regions, and recognizes
their contents. It returns polygon coordinates, text, confidence, and page dimensions.
Actual does not add automatic grayscale/contrast/sharpen passes, orientation inference,
unwarping, or deskewing in v1. A simple **Rotate left**/**Rotate right** action applies a
90-degree canvas transform and reruns the same PaddleOCR pipeline when EXIF orientation is
missing or wrong. Low-confidence text is warned and remains editable.

Boxes exist only in the draft and are never persisted.

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

| Field               | Bound after normalization                |
| ------------------- | ---------------------------------------- |
| Merchant            | 256 Unicode code points                  |
| Transcript          | 32,000 Unicode code points               |
| Line items          | 200                                      |
| Line-item label     | 256 Unicode code points                  |
| Warnings            | 32 entries of 256 code points            |
| Payment/source hint | 128 Unicode code points                  |
| Integer amount      | absolute value at most 10^12 minor units |
| Confidence          | finite number from 0 through 1           |

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
confidence, warnings, ocr_revision, parser_revision,
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
validation/initialization/extraction -> error -> retry same pipeline, replace image, manual entry, or remove
save/match -> error -> retry or remove
linked -> editing -> linked
linked -> unlinking -> saved-unmatched
```

Only `saving` creates a row. Only explicit link/reassign/unlink actions change association.
Reloading during OCR loses the unsaved draft by design and leaves no partial record.

Cancellation rejects stale results and disposes/recreates the PaddleOCR worker/runtime.
Every terminal path closes `ImageBitmap`, clears canvas/buffers, revokes object URLs, and
disposes an unsafe runtime instance.

## 10. OCR failure and low-confidence behavior

There is no alternate OCR engine and no cloud-image transcription. An initialization,
timeout, extraction, or low-confidence result leaves the temporary image preview available
and presents four bounded choices:

- retry the same pinned PaddleOCR pipeline after worker reinitialization;
- rotate the image left or right by 90 degrees and rerun PaddleOCR;
- choose a clearer image; or
- continue with an empty or partial editable draft and enter/correct the text manually.

Retry never changes the engine, model pair, or privacy boundary. Nothing is persisted until
the user reviews and explicitly saves the draft. Removing the image or leaving the page
releases all temporary image and worker resources.

## 11. Deterministic transaction matching

FIN-87 considers current expense transactions that are not tombstoned, transfers, starting
balances, split parents/children, or already linked to another active receipt. Return at
most 25 candidates. First filter by currency, positive receipt total versus Actual's signed
expense amount, and a seven-day date window. A near total differs by at most the greater of
100 minor units or 2% of the receipt total.

| Evidence                             |                             Score |
| ------------------------------------ | --------------------------------: |
| Exact total and currency             |                               +50 |
| Same date                            |                               +20 |
| One day apart                        |                               +12 |
| Two or three days apart              |                                +6 |
| Four through seven days apart        |                                +2 |
| Normalized merchant/payee similarity |                         up to +20 |
| Account/payment-source agreement     |                         up to +10 |
| Near rather than exact total         | amount contribution capped at +20 |

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
save/attach/reassign/unlink/delete, manual 90-degree rotation, and same-Paddle retry.

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
OCR model/runtime metadata. Cap evidence at 8 KiB per transaction and delimit receipt strings
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
- Image and OCR text are untrusted input and cannot instruct the parser, matcher, or
  categorizer.
- Logs contain event names, OCR revision, duration buckets, and error codes only. Never log
  image/base64, transcript, merchant, amounts, hashes, or keys.
- Receipt handlers verify expected budget identity and current fingerprints before writes.
- Receipt CRUD never overwrites transaction Notes or financial values.
- Tests use synthetic receipt images and synthetic transactions only.

## 15. Quality and performance gates

FIN-86 benchmarks the pinned PaddleOCR.js SDK and model pair using at least 30
deterministic synthetic receipts: narrow/wide layouts, multiple fonts, rotation,
perspective, low contrast, shadows/noise, tax/tip, discounts, ambiguous totals, and
missing fields.

The pinned browser build must achieve:

- exact total on at least 95% of clear/medium fixtures;
- exact unambiguous date on at least 90%;
- usable merchant on at least 85%;
- no crash or silent success on degraded fixtures;
- cold initialization plus one image at p95 no slower than 20 seconds;
- warm extraction at p95 no slower than 10 seconds; and
- cancellation that releases worker and image resources.

Poor fixtures may require correction; they must warn rather than emit false high-confidence
fields. If PaddleOCR fails a gate, FIN-86 must tune the pinned model/configuration and rerun
the benchmark or return to FIN-84 for an explicit design change. It must not silently add a
second OCR engine or cloud-image path.

## 16. Verification

Unit/integration coverage includes input validation; EXIF orientation, resize,
white-background preparation, and manual rotation; worker initialization, integrity,
progress, timeout, cancellation, and disposal; parser date and
amount locales; totals/tax/tip/change; redaction/bounds; fingerprints/revisions; migration,
CRUD, duplicates, restart, backup/restore, CRDT sync, tombstone, undo, and link conflicts;
matcher exact/near/tie/stale cases; and categorization majority, truncation, injection-like
text, disclosure, staleness, apply, and undo.

Browser E2E uses synthetic images through the normal Actual URL to upload, OCR, correct,
save unmatched, rank/attach, manually resolve ambiguity, close/reopen, view/edit/reassign/
unlink/delete, categorize with and without receipt evidence, cancel, recover from local
failure, rotate and rerun, replace the image, and continue with manual correction.

Network and log assertions prove local OCR does not upload images and sensitive fields are
absent. Production browser/server builds must contain the documented assets and start with
the existing Actual command and no companion process.

## 17. Ticket ownership and parallel execution

| Ticket | Ownership                                                                    |
| ------ | ---------------------------------------------------------------------------- |
| FIN-84 | This contract and downstream assumption updates                              |
| FIN-85 | Migration/schema, CRDT receipt CRUD/link handlers, backup/sync tests         |
| FIN-86 | Assets, PaddleOCR worker integration, bounded preparation/parser, benchmarks |
| FIN-87 | Matcher, scores/reasons, candidate query, stale confirmation                 |
| FIN-88 | Route/navigation, queue, review, matching UI, indicator/viewer               |
| FIN-89 | Bounded evidence, disclosure, prompt/types, staleness, apply/undo            |
| FIN-90 | Cross-ticket E2E, privacy/log audit, builds, README/user guide               |

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
- alternate OCR engines or cloud-image transcription;
- automatic contrast enhancement, orientation inference, unwarping, or deskewing;
- model training/fine-tuning;
- a generic attachment framework; or
- a separate Finance Companion service.
