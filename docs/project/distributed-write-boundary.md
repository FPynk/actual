# Distributed-safe Actual write boundary

Status: FIN-42 decision, 2026-07-31

## Decision

The companion must keep `write_capability_state = disabled`. The current
Actual API and sync protocol cannot make a companion-led transaction, rule, or
schedule write safe across more than one client. Review approvals therefore
remain companion decisions with `manual-in-actual` guidance. Read-only imports,
matching, classification, subscription review, and Amazon review remain
available.

This is the smallest design that meets FIN-42's fail-closed acceptance rule.
It adds no partial local mutator and no receipt schema that could imply safety
which the authoritative Actual domain cannot yet prove.

Generation-zero companion backup and restore are unaffected. Paired restore of
an Actual budget remains disabled because the public `importBudget` operation
does not conditionally replace the bound remote budget or expose an
authoritative applied/not-applied outcome.

## Current behavior and evidence

- `packages/finance-companion/src/contracts/adapter.ts` exposes budget and
  target reads plus bank sync. It exposes no ledger mutator.
- `packages/finance-companion/src/actual/adapter.ts` and
  `operation-lock.ts` serialize one companion process and one owned Actual API
  directory. They cannot fence another Actual client.
- `packages/api/methods.ts` exposes unconditional transaction, rule, and
  schedule methods. None accepts an expected version, fence token, receipt ID,
  or canonical action hash.
- `packages/loot-core/src/server/api.ts` serializes a mutation in one local
  process. `batchBudgetUpdates` groups local sync messages but provides neither
  compare-and-set nor rollback across clients.
- `packages/sync-server/src/app-sync.ts` and `sync-simple.js` authenticate and
  relay opaque CRDT messages. They do not own a per-budget revision, lease,
  write epoch, conditional mutation, or durable operation outcome.
- `packages/loot-core/src/server/sync/index.ts` converges local and remote CRDT
  messages after the fact. It does not hold a stable remote revision across a
  read, local write, and post-write sync.

Consequently, pre-sync plus target-hash validation can still race an online
client. A server-only lease cannot stop an offline or legacy client from
creating a local write and syncing it later. A matching target hash after a
lost response is not commit proof because another client can edit or exactly
revert the target.

## Required future boundary

A future write-enabled release requires coordinated Actual core, sync-server,
and supported-client protocol work. The companion alone cannot supply it.

### Closed operation

The boundary accepts one versioned discriminated action, never a generic
patch:

```ts
type ConditionalActualActionV1 =
  | CategorizeOneTransactionV1
  | ApplyOneReconciliationV1
  | ApplyOneAmazonParentV1
  | CreateCategoryRuleV1
  | CreatePayeeRenameRuleV1
  | CreateSubscriptionScheduleV1;
```

The owning feature contract defines each payload. Every action targets one
transaction parent, one rule, or one schedule. A receipt-derived operation ID
determines every created ID. A shared canonicalizer derives the immutable
action hash and exact before/expected-after hashes. No caller supplies raw
Actual patches, child IDs, or an outcome.

Conceptually, the only write entry point is:

```ts
conditionalApply({
  operationId,
  actionHash,
  fenceEpoch,
  targetKind,
  targetId,
  expectedBeforeHash,
  expectedAfterHash,
  action,
});
```

Inside one authoritative Actual transaction it must re-read and validate the
complete target, reject stale or reconciled state, re-derive deterministic
IDs and hashes, apply all of the closed action or nothing, and insert the
durable operation outcome. Replaying the same operation ID and action hash
returns that outcome without another mutation. Reusing the ID with another
hash fails.

### Distributed fence

The sync service must own a versioned per-budget fence epoch. Every supported
client must negotiate the protocol, reject normal writes while another writer
holds the fence, and reject synchronization of a stale epoch. The companion
must acquire the fence before its final pre-sync and retain it through the
authoritative outcome sync and post-sync verification.

Supporting a legacy or offline client which may later synchronize an unfenced
write is incompatible with this guarantee. A future rollout must either
upgrade/reject such clients or leave companion writes disabled.

### Durable outcome and interrupted worker

The Actual-side outcome contains the operation ID, action hash, target kind and
ID, accepted before hash, committed after hash, outcome hash, and commit time.
It is stored atomically with the financial mutation, synchronized to supported
clients, queryable after restart, and retained in export and backup while a
companion receipt depends on it.

The companion records and anchors its immutable intent before calling Actual.
If its worker dies after a local commit but before outcome synchronization, the
receipt-derived operation directory is permission-restricted, quarantined,
included in paired backup, and never deleted or reused. Recovery reacquires the
queue, local lock, and remote fence, then queries the authoritative outcome. An
unavailable or ambiguous result remains `outcome_unknown`; no retry or later
write may consume the affected target or Amazon capacity.

## Alternatives rejected

| Alternative                             | Why it is insufficient                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Companion queue and file lock           | Protects only participating local companion processes.                                                          |
| Pre-sync, local write, post-sync        | Another client can write between each step.                                                                     |
| Expected target hash in the companion   | A read-then-write check is not atomic with Actual's mutation.                                                   |
| Current state equals expected-after     | Does not prove which caller committed; exact reverts are possible.                                              |
| Idempotency only in companion SQLite    | A killed worker can commit Actual before the companion records success.                                         |
| Sync-server receipt table alone         | The server relays opaque CRDT messages and cannot atomically bind the receipt to the encrypted ledger mutation. |
| Server lease without client enforcement | Offline and legacy clients can write locally and synchronize later.                                             |
| Compensating writes                     | A second financial mutation is not rollback and can race again.                                                 |

## Data, API, UI, and migration impact

- No FIN-42 migration is added. Reserved `application_receipts` storage stays
  unimplemented until the authoritative Actual outcome and fence exist.
- HTTP review responses continue to return `mode: 'manual-in-actual'`.
- UI approval language must say that the decision was saved and the user must
  complete the change in Actual. It must not say `applied`.
- `write_capability_state` remains `disabled` in both companion metadata and
  the integrity anchor. No capability-generation event is issued.
- No credentials, raw financial data, target payload, or sensitive source text
  is added to logs or outcomes.
- A future protocol needs a coordinated migration for Actual outcomes, sync
  negotiation, export/backup retention, companion receipts, and a paired
  restore contract. It cannot be rolled out as a companion-only migration.

## Race and failure acceptance matrix

Before enabling any write, deterministic synthetic tests must prove:

1. Two approvals with one before hash produce exactly one committed outcome.
2. Online edits before, during, and after the operation never get silently
   overwritten.
3. An offline client later presenting a stale epoch is rejected.
4. A worker killed after local commit is finalized exactly once through outcome
   lookup after restart.
5. A lost response followed by an edit or exact revert is resolved only by the
   durable outcome, never by current state.
6. Replaying one operation ID/hash returns the same outcome; changing the hash
   is rejected.
7. Failure at each internal boundary leaves either the complete action and
   outcome or neither.
8. Fence loss or sync-version change during paired backup/restore discards the
   set without replacing live state.
9. An unresolved receipt or quarantine blocks the related target and source
   capacity.

## Rollout and ticket disposition

FIN-43 through FIN-47 remain deferred rather than agent-ready. FIN-25 and any
schedule-creation work remain manual-in-Actual. Companion-only schedule
association may proceed because it changes only companion metadata after live
read validation. FIN-50 may verify generation-zero companion backup/restore,
but paired Actual replacement remains deferred.

A future project may reopen the write phase only after it explicitly accepts
the coordinated Actual protocol change and the incompatibility policy for
legacy/offline clients. Until then, rollback is simply to revert this document;
there is no dormant write code or schema to unwind.
