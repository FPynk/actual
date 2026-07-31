# FIN-33 Subscription Candidate Contract

This contract refines FIN-9 for FIN-34 through FIN-36. Actual remains the
authoritative owner of schedules and transactions. FIN-34 and FIN-35 are
read-only with respect to Actual. FIN-36 may record an association with an
already-existing schedule, but must not create, update, or delete one.

## Closed read inputs

FIN-33 adds these closed FIN-9 adapter result DTOs. They are data only: callers
cannot choose fields, queries, or schedule operations.

```ts
type SubscriptionHistoryTransactionV1 = Readonly<{
  id: string;
  accountId: string;
  payeeId: string | null;
  date: string; // YYYY-MM-DD
  amount: number; // Actual integer money
  isReconciled: boolean;
  isTransfer: boolean;
  isSplitParent: boolean;
  isStartingBalance: boolean;
  isTombstone: boolean;
}>;

type SubscriptionScheduleSnapshotV1 = Readonly<{
  id: string;
  accountId: string | null;
  payeeId: string | null;
  amount: number | Readonly<{ num1: number; num2: number }> | null;
  amountOperator: 'is' | 'isapprox' | 'isbetween';
  recurrence:
    | Readonly<{ kind: 'one-time'; date: string }>
    | Readonly<{
        kind: 'recurring';
        frequency: 'weekly' | 'monthly' | 'yearly';
        interval: number;
        start: string;
      }>;
  isCompleted: boolean;
}>;
```

The transaction snapshot uses the existing FIN-9 transaction range and its
redaction limits. The schedule snapshot is a separate `schedules` section. It
maps `getSchedules()` to the DTO above and omits schedule name, rule ID,
next-date, conditions, actions, notes, and all raw API objects. A failed
schedule read fails the scan before changing candidates.

Eligible history has a non-empty payee ID, a negative non-zero amount, and is
not a transfer, split parent, starting balance, or tombstone. Closed and
off-budget accounts are not specially excluded. Split children are eligible
once. Reconciled transactions are also eligible, but set
`reconciled-history`; their candidates never authorize an Actual schedule
write. Positive refunds and zero values are not observations.

## Detector v1

All dates are parsed as calendar dates with an injected UTC clock. Sort each
account/payee group by date and then transaction ID. The signature is the
lowercase SHA-256 of RFC 8785 JSON for:

```ts
[
  'finance-companion/subscription-signature/v1',
  { accountId, payeeId, cadence },
];
```

`cadence` is `weekly`, `monthly`, `quarterly`, `annual`, or `unknown`.
Accounts never combine, and payee display names never enter the signature.

For a regular run, each next date must equal the previous date plus the stated
calendar cadence within its tolerance. One missed occurrence is allowed when
the next date equals two cadence steps within twice that tolerance; it emits
`gap-detected`. More than one missed occurrence, a longer gap, or an
out-of-tolerance date rejects that run.

| Cadence   | Calendar step | Minimum observations | Date tolerance |
| --------- | ------------- | -------------------: | -------------: |
| weekly    | 1 week        |                    4 |         2 days |
| monthly   | 1 month       |                    3 |         4 days |
| quarterly | 3 months      |                    3 |         4 days |
| annual    | 1 year        |                    2 |         7 days |

The detector tests every cadence. Distinct, non-overlapping qualifying runs
at one account/payee produce separate signatures. If qualifying runs share an
observation, emit one `unknown` cadence candidate with `cadence-ambiguous`;
it can be reviewed but cannot be linked or used to create a schedule.

`median_amount` is the integer median of absolute observation amounts. The
even case is `Math.round((left + right) / 2)`. `amount_variance_basis_points`
is the largest rounded `abs(amount - median) * 10000 / max(1, median)`.
`date_variance_days` is the largest calendar-day residual from the relevant
one- or two-step expected date. A normal run is eligible when amount variance
is at most 3,500 basis points.

A recent price change preserves eligibility up to 5,000 basis points only when
all observations before the last one are within 750 basis points and the last
amount differs from their median by 1,000 through 5,000 basis points. Store
that last difference as `recent_price_change_basis_points` and emit
`price-change`. Otherwise it is null. This deliberately recognizes one recent
price increase or decrease, not an evolving price series.

Confidence is a review-order score, never a type or permission. Start at 50;
add `min(20, (occurrenceCount - minimumCount) * 10)`, add 15 when date
variance is at most the cadence tolerance, add 15 when amount variance is at
most 750 basis points, add 5 for one exact existing schedule match, subtract
15 for other eligible amount variance, subtract 10 for a gap, and subtract 10
for a price change. Clamp the result to 0 through 100.

Reason codes are unique and stored in this fixed order when applicable:
`cadence-weekly`, `cadence-monthly`, `cadence-quarterly`,
`cadence-annual`, `cadence-ambiguous`, `minimum-occurrences`,
`billing-date-variance`, `stable-amount`, `amount-variance`, `price-change`,
`gap-detected`, `reconciled-history`, `existing-schedule`, and
`schedule-ambiguous`.

The detector always persists `candidate_type: 'unknown'`. The only source of
`subscription`, `household_bill`, or `financial_bill` is an explicit user
choice. Confidence and reason codes must not silently change that choice.

## Schedule matching, suppression, and stale state

An active exact schedule match has the same account and payee and one of these
recurrences: weekly/1, monthly/1, monthly/3, or yearly/1 for the corresponding
candidate cadence. Its start date and amount do not need to match. A single
match sets `actual_schedule_id` and `existing-schedule`. Multiple matches add
`schedule-ambiguous` and leave it null. Completed and one-time schedules never
match.

`rejected` is the suppression record for `(signature, detector_version)`.
Scans leave it unchanged until the user reopens it or the detector version is
intentionally increased. A version increase creates a new signature/version
candidate; it is not an automatic reset of an existing decision.

Pending and deferred candidates refresh their evidence on a matching scan;
deferred remains deferred. A missing matching run makes either stale. A stale
candidate becomes pending if a later scan qualifies it again. Approved
candidates become stale if their eligible history no longer qualifies or their
previously linked schedule is deleted, completed, or no longer an exact match.
The detector never substitutes a different schedule for an approved link.
Rejected candidates remain rejected. No status transition changes Actual.

## Decisions and the only allowed schedule operation

FIN-35 uses the existing review route and these closed subscription actions:

```ts
type SubscriptionReviewAction =
  | Readonly<{
      kind: 'approve';
      userSelectedType:
        'subscription' | 'household_bill' | 'financial_bill' | 'unknown';
    }>
  | Readonly<{ kind: 'defer' }>
  | Readonly<{ kind: 'reject'; reasonCode?: 'not-recurring' | 'other' }>
  | Readonly<{ kind: 'reopen' }>;
```

Approve records the chosen type and changes only companion metadata. Defer
keeps the candidate out of the pending queue. Reject creates the suppression.
Reopen is the undo action: it clears an approval/defer choice or removes the
rejection suppression, sets the type to `unknown`, and returns the candidate
to pending. It never changes a transaction or schedule.

FIN-36 may additionally provide the idempotent, companion-only action:

```ts
type LinkExistingSubscriptionScheduleV1 = Readonly<{
  candidateId: string;
  candidateVersionHash: string;
  scheduleId: string;
}>;
```

It accepts exactly one current, active exact match after re-reading the
candidate history and schedule DTO. Same candidate/version/schedule replays
successfully; a different schedule, changed version, missing target, ambiguous
target, or stale candidate conflicts without a write. It updates only
`actual_schedule_id` in companion SQLite. `unlink-existing` is its undo and
only clears that companion field. Reconciled-derived candidates may display an
automatically found association but FIN-36 must not create a schedule for them.

The current public API offers `getSchedules`, `createSchedule`,
`updateSchedule`, and `deleteSchedule`, but its mutations have no conditional
version, remote fence, deterministic target ID, durable receipt, or replayable
outcome. Therefore FIN-36 must not call `createSchedule`, `updateSchedule`, or
`deleteSchedule`. It shows manual Actual Schedule guidance instead. A later
ticket may propose a `create-subscription-schedule` operation only after
FIN-42 and FIN-44 provide the conditional mutation, durable outcome, recovery,
and remote-concurrency gate; that work is outside FIN-36.

## Implementation handoff

| Ticket | Exact files and focused tests                                                                                                                                                                                                                                                                                                      | Scope and undo                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-34 | `packages/finance-companion/migrations/004-review-candidates.sql`; `packages/finance-companion/src/subscriptions/subscription-detector.ts`; `packages/finance-companion/src/subscriptions/subscription-scan-service.ts`; `packages/finance-companion/src/subscriptions/subscription-detector.test.ts`                              | Add the closed read mapping, migration-owned candidate upsert, detector, and tests for every cadence, variance, price change, gap, reconciled history, ambiguity, suppression, and stale refresh. No UI or Actual mutation. |
| FIN-35 | `packages/finance-companion/src/subscriptions/subscription-review-service.ts`; `packages/finance-companion/src/subscriptions/subscription-review-service.test.ts`; `packages/finance-companion/src/ui/subscriptions/SubscriptionReviewPage.tsx`; `packages/finance-companion/src/ui/subscriptions/SubscriptionReviewPage.test.tsx` | Render evidence, schedule association/manual guidance, and approve/defer/reject/reopen. Test all decision and undo transitions; Actual remains unchanged.                                                                   |
| FIN-36 | `packages/finance-companion/src/subscriptions/link-existing-schedule.ts`; `packages/finance-companion/src/subscriptions/link-existing-schedule.test.ts`; `packages/finance-companion/src/subscriptions/subscription-schedule-actions.ts`                                                                                           | Add only local, idempotent link/unlink after live revalidation. Test replay, mismatch, schedule deletion/edit race, ambiguity, reconciled-derived no-create, and that no API schedule mutation is called.                   |

Logs, route errors, and test fixtures use only FIN-9 allowlisted metadata and
synthetic account, payee, and schedule IDs. They never log payee names,
schedule names, transaction notes, raw API objects, or financial history.
