# FIN-37 Amazon enrichment contract

This contract closes the implementation choices for FIN-38 through FIN-41.
It supplements, and does not change, the Amazon tables and general import,
receipt, privacy, and review rules in `data-model.md`,
`finance-companion-v1-contract.md`, and `architecture.md`.

## Scope and gates

Amazon enrichment is an optional, user-supplied, file-only feature. FIN-38
accepts one supported uncompressed Amazon export file; FIN-39 accepts one
RFC 5322 `.eml` confirmation, shipment, or refund message. There is no browser
automation, credential, mailbox, archive, forwarding-folder, currency
conversion, or Actual ledger write in this phase.

The first import for a user-selected Amazon profile creates one immutable
`source_namespaces` row with `kind = amazon_profile` and namespace
`amazon-profile/v1/<profile-key>`. `<profile-key>` is a lowercase UUID created
locally and displayed only through the sanitized `display_name`. The user must
select that profile for every later export and `.eml` import. Both adapters use
that one namespace across marketplaces and payment accounts; a marketplace is
part of an order identity, not a separate profile. A different profile never
merges with it.

FIN-38, FIN-39, FIN-40, and FIN-41 are read-only with respect to Actual:

- parsers use only the companion database and never call the Actual adapter;
- FIN-40 creates candidates and review records only, never holds or
  reservations; and
- FIN-41 may approve, reject, or defer a review and show manual Actual-edit
  guidance, but exposes no apply endpoint or control.

FIN-47 is the first ticket permitted to request an Amazon split or note write.
It remains gated on the conditional mutator and application-receipt work. It
must create one receipt and, if needed, one hold set for one Actual parent only;
a multi-parent candidate is visibly progressed one parent at a time.

## Canonical identity and observations

All adapter identifiers use Unicode NFC, trim leading/trailing ASCII whitespace,
and reject an empty result. Marketplace is ASCII lowercase. Amazon identifiers
otherwise preserve case. Currency is uppercase ISO 4217. Money is parsed once
into signed-safe integer minor units; floating-point values are rejected.

`sha256Parts(...)` below means SHA-256 of UTF-8, length-prefixed normalized
parts, rendered as lowercase hexadecimal. It is used only as an opaque key;
raw message IDs, tracking values, and source text are not retained.

Both adapters emit the following canonical keys before database access:

| Entity   | Key when Amazon supplies an identifier    | Fallback key                                                                                                                                                                                                  |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order    | `order/<marketplace>/<external-order-id>` | None; an order ID is required.                                                                                                                                                                                |
| Shipment | `shipment/<external-shipment-id>`         | `shipment-fallback/<sha256Parts(orderKey, shipmentDate, shipmentTotal, orderedItemSignatures)>/<occurrence>`                                                                                                  |
| Item     | `item/<external-item-id>`                 | `item-fallback/<sha256Parts(orderKey, shipmentKey-or-empty, asin-or-sku-or-empty, seller-or-empty, normalizedTitle, quantity, unitAmount, taxAmount, shippingAmount, discountAmount, currency)>/<occurrence>` |
| Refund   | `refund/<external-refund-id>`             | `refund-fallback/<sha256Parts(orderKey, itemKey-or-empty, refundDate, amount, currency, normalizedReason-or-empty)>/<occurrence>`                                                                             |

`normalizedTitle` collapses interior ASCII whitespace after NFC normalization;
it is used only when an identifier is absent and is never logged. An item
fallback requires at least one of ASIN/SKU, seller, or title in addition to the
numeric fields. A shipment fallback includes the ordered item signatures, so
date and total alone can never identify a shipment.

`occurrence` is a one-based decimal number with no leading zeroes. For otherwise identical
fallback fingerprints within one parent, adapters sort records by their
source-defined position: export record number within its named export section;
or message part/visible line position for `.eml`. They then assign occurrences
in that order. A parser must reject an input whose source position is absent or
duplicated rather than choose a non-deterministic order.

An export observation key is
`export/<section-name>/<one-based-record-number>`. An email observation key is
`eml/<sha256Parts(normalized-message-id-or-content-sha256)>/<entity-kind>/<source-position>`.
The message content hash is only used when `Message-ID` is absent and is not
stored separately. These are `amazon_source_observations.source_row_key` values,
not canonical entity keys.

For a record without an external shipment, item, or refund ID, the adapter first
uses its fallback key. If a record with an external ID and a keyless record have
the same parent plus exactly one compatible structural entity, the keyless
record resolves to that existing entity and records its fallback key only in the
observation payload hash calculation. Zero or multiple compatible entities are
an explicit `ambiguous_identity` conflict, never a fuzzy merge. This makes a
complete export and its matching email converge while keeping an ambiguous email
review-only.

Canonical entity values are immutable in v1. A compatible observation has the
same normalized identity, parent relationship, currency, and every field the
adapter supplies; it appends an observation and advances `last_observed_at`.
An observation may omit a field only when that entity is not emitted by that
message type. A changed immutable identity field, parent, currency, or supplied
amount/value is `conflicting_observation`: append no canonical row, overwrite
nothing, record a redacted conflict count, and return
`completed-with-conflicts`. Re-importing exact bytes returns the existing
receipt; reparse with a new parser version can add compatible observations only.

## Parsing, replay, currency, and privacy

FIN-38 owns a versioned export parser and FIN-39 owns a versioned `.eml` parser.
They share only the normalized Amazon-record DTO and canonical-key helper.
Their persistence seam is the existing `import_batches` repository operation:

1. stream and limit the file, calculate `content_sha256`, and create or recover
   the `parsing` receipt for the selected profile and parser version;
2. parse in memory into normalized records and detect conflicts before writes;
3. in one SQLite transaction, resolve/upsert compatible canonical entities,
   append observations, write counts/conflict status, and mark the receipt
   `parsed`; and
4. delete every owned temporary raw file on every exit path.

A crash before step 3 leaves only the resumable receipt. A crash during step 3
rolls back entities, observations, counts, and status together. A crash after
commit but before the response returns the committed receipt and graph on retry.
No parser writes `applied`, a review decision, a hold, a reservation, or Actual.

Every order and child uses the order's source currency. FIN-40 may build a
candidate only when that ISO code exactly equals the configured Actual budget
currency; otherwise it records a non-actionable `currency_mismatch` reason.
There is no exchange-rate lookup, rounding conversion, or cross-currency match.

Raw exports, mail bodies, headers, attachments, local paths, message IDs, and
temporary filenames are never stored in the database, logs, errors, fixtures,
or telemetry. Upload files are deleted after parse success, parse failure,
disconnect, or limit rejection. Normalized titles are sensitive: they appear
only in authenticated review detail and encrypted/protected companion backups,
never in summaries, diagnostics, or ordinary logs.

## Retention and tombstones

A daily retention job may purge an entire normalized Amazon order graph only
when its latest observation is older than 365 days and none of its entities is
referenced by a pending/deferred candidate or an `applying`, `outcome_unknown`,
or `failed_retryable` application receipt. It deletes the order, children,
observations, and terminal candidate detail through the declared foreign-key
rules. It preserves import receipts needed for replay, application receipts,
unresolved holds, and `amazon_applied_allocation_reservations`.

When retention removes a graph, its otherwise terminal import batches become
`discarded`. Resubmitting the same bytes and parser version reopens that same
receipt, re-normalizes it atomically, and returns it rather than creating a new
receipt. This is the sole exception to a normal parsed-receipt replay and does
not create a decision, hold, reservation, or Actual mutation.

Reservations are the non-sensitive tombstone. Their versioned
`source_identity_hash` is `sha256Parts(namespace, canonicalKey)` and is
recomputed on re-import. A later import may restore normalized detail, but FIN-40
must subtract every matching reservation and unresolved hold before proposing a
candidate; it cannot reapply a purged source component. A failed or blocked
purge changes nothing.

## Signed matching and capacity

Let `T` be an Actual parent amount in Actual's signed convention: a card charge
is negative and a refund is positive. Source purchase magnitudes are positive.
For an item, the signed source components are:

```text
merchandise = -(quantity * unit_amount)
tax         = -tax_amount
shipping    = -shipping_amount
discount    = +discount_amount
```

For order-level residuals, `gift_card = +gift_card_total`; unassigned tax and
shipping are negative; and a necessary integer remainder is a named `rounding`
adjustment with its explicit signed amount. A refund allocation is positive:
`refund = +refund.amount`. The matcher must never infer or hide a remainder.

For each candidate parent, the exact equation is:

```text
T = sum(item-component allocations)
  + sum(refund allocations)
  + sum(order-adjustment allocations)
```

Only charge parents may receive purchase/item/order-adjustment components; only
positive refund parents may receive refund components. Each allocation has the
same sign as its source component. For every source component `s`, the absolute
sum of its applied reservations plus active holds across _all_ match groups is
at most its normalized absolute capacity. For every Actual parent `t`, the
absolute sum of applied reservations plus active holds across all groups is at
most `abs(T)`; because an applied parent must satisfy the full equation above,
one existing applied reservation or active hold blocks a second application.
Pending candidates may overlap, but are revalidated before any future apply.

FIN-40 reads Actual targets through the serialized adapter, excludes reconciled
or stale targets, and writes candidate rows only. Similar dates and amounts are
ranking evidence, never allocation identity. The matcher exposes an explicit
rounding component and every competing candidate; it does not automatically
select a candidate or category.

## Delivery seams and fixtures

| Ticket | Owns                                                                                       | Required synthetic fixtures/tests                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-38 | Export DTO/parser, export observation keys, canonical upsert repository call               | `amazon-export-one-order.json`, `amazon-export-two-shipments.json`, `amazon-export-duplicate-fallback-lines.json`, conflict/reparse/crash/raw-delete cases                       |
| FIN-39 | `.eml` DTO/parser, message observation keys, common canonical-key helper                   | `amazon-order.eml`, `amazon-shipment.eml`, `amazon-refund.eml`, absent-message-id, same-export-and-email, ambiguous-keyless-identity, replay/crash cases                         |
| FIN-40 | Read-only target query, deterministic candidates, signed equations and capacity validation | charge/refund, gift-card, tax/shipping/discount/rounding, multi-order charge, multi-charge order, competing candidates, currency mismatch, cross-group reservation/hold fixtures |
| FIN-41 | Authenticated read-only review route and UI                                                | loading/empty/error/stale/competing states, sensitive-detail masking outside detail, approval/reject/defer leaves Actual unchanged                                               |

Fixtures contain invented orders, IDs, titles, addresses, and message content
only. They contain no real Amazon export, mailbox data, credentials, or account
numbers. FIN-47 adds the receipt/hold/reservation and one-parent application
tests after its separate mutation gate is complete.
