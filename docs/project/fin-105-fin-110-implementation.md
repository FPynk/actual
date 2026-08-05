# FIN-105 and FIN-110 implementation design

This note records the smallest implementation that satisfies the two tickets. The Linear ticket descriptions remain the source of truth for acceptance criteria.

## FIN-105: reliable first navigation

The launcher keeps the existing build and four-process topology. It opens Actual only after two consecutive readiness rounds succeed through port `5006`.

Each round validates the response rather than accepting any HTTP 2xx result:

- `/info` must be parseable Actual server metadata.
- `/` must be the Actual HTML entry document.
- the backend and plugin worker URLs must be non-empty JavaScript responses with identifying content, never an HTML fallback.
- proxied responses must carry the cross-origin isolation headers required by the backend worker.

The automatically opened URL carries an `actual-launch` nonce through a small `/kcab/actual-launch.html` bootstrap served by the development frontend. That path is excluded from the prior PWA worker's navigation fallback, so on loopback development launches it can unregister stale same-origin service-worker registrations before opening the frontend. A session-scoped guard permits at most one cleanup and one transient `BackendInitFailure` recovery. It never clears IndexedDB, local storage, authentication state, budget data, or unrelated caches. Other fatal errors and production navigation retain their existing behavior.

## FIN-110: receipt review layout

The Receipts page remains one native Actual page and keeps the existing receipt state and commands. Its UI is reorganized into normal-flow sections:

1. compact upload control;
2. complete, scrollable processing queue;
3. preview card with status and rotation toolbar;
4. OCR warning and structured metadata cards;
5. responsive line-item editor;
6. editable raw transcript; and
7. a separate `Save receipt` action row followed by transaction matching.

Queue rows use stable filename/status/action columns and contextual controls. Metadata fields own their labels. Line items use non-shrinking desktop rows and stack at narrow widths. Images and text areas are contained without fixed page heights, so normal page scrolling reaches every control. Status changes use live regions, warnings appear beside affected fields where they can be identified, and repeated actions have contextual accessible names.

## Verification boundary

Focused automated tests cover launcher response validation and stability, bounded browser recovery, receipt interactions, accessibility names, and responsive layout rules. A production web build checks integration. Manual verification is limited to synthetic state: repeated local launches, a synthetic stale service worker, and receipt layouts at desktop, approximately `1234px`, tablet, and mobile widths. No real financial data or receipt images are used.
