# FIN-22 Classification and Narrow Rule-Write Contract

This contract defines review proposals now and the only rule shapes that may
later cross the gated Actual-write boundary. Actual remains authoritative. No
FIN-22, FIN-23, or FIN-24 path mutates Actual.

## Eligible evidence and proposals

The detector receives an injected `evaluatedAt`, the bound budget currency, and
the FIN-9 allowlisted account, payee, category, and transaction DTOs. It ignores
tombstones, starting balances, transfers, split parents, transactions outside
the bound currency, and rows without a usable payee/imported payee. A
reconciled transaction may be read as historical evidence, but can never be an
action target. Integer amounts and opaque Actual IDs remain unchanged.

Imported-payee comparison version 1 applies Unicode NFKC, trims leading and
trailing whitespace, collapses internal whitespace, and lowercases with the
locale-independent JavaScript mapping. The stored source spelling is retained
for review and is sensitive; it is never logged.

```ts
type ClassificationReasonCode =
  | 'consistent-imported-payee-alias'
  | 'conflicting-payee-alias'
  | 'dominant-category-history'
  | 'insufficient-history'
  | 'ambiguous-category-history'
  | 'target-already-categorized'
  | 'target-reconciled'
  | 'target-split'
  | 'target-stale'
  | 'payee-deleted'
  | 'category-deleted'
  | 'suppressed';

type MerchantAliasProposalV1 = Readonly<{
  kind: 'merchant-alias';
  proposalId: string;
  normalizedImportedPayee: string;
  sourceSpellings: readonly string[];
  proposedPayeeId: string;
  evidenceTransactionIds: readonly string[];
  confidence: number;
  reasonCodes: readonly ClassificationReasonCode[];
  detectorVersion: 1;
}>;

type CategoryProposalV1 = Readonly<{
  kind: 'category';
  reviewId: string;
  transactionId: string;
  targetVersionHash: string;
  accountId: string;
  payeeId: string;
  proposedCategoryId: string;
  eligibleHistoryCount: number;
  proposedCategoryCount: number;
  confidence: number;
  reasonCodes: readonly ClassificationReasonCode[];
  detectorVersion: 1;
}>;
```

A merchant alias proposal needs at least two distinct eligible transactions
whose same normalized imported payee resolves to one non-transfer Actual payee.
Any eligible row resolving that alias to another payee suppresses the proposal
as `conflicting-payee-alias`. Confidence is `min(100, 60 + 10 * evidenceCount)`
and is review ordering only.

A category proposal targets one current, unreconciled, unsplit, uncategorized
transaction. For the same payee and account it needs at least three other
eligible categorized transactions. One live category must own at least 80% of
that history and have at least three occurrences. Confidence is the rounded
integer percentage. A tie, a lower share, or a deleted payee/category yields no
actionable proposal. These thresholds do not change Actual's category-learning
settings or rules.

The repository keys pending merchant proposals by normalized alias plus payee,
and category reviews by target transaction, category, target hash, and detector
version. Rejection suppresses the same semantic proposal for 180 days. A new
detector version or a materially different target/category may create a new
review. Confidence never approves or writes anything.

## Decisions, staleness, and validation order

```ts
type ClassificationDecisionV1 = Readonly<
  | {
      kind: 'categorize_once';
      reviewId: string;
      transactionId: string;
      categoryId: string;
      targetVersionHash: string;
    }
  | {
      kind: 'create_category_rule';
      reviewId: string;
      transactionId: string;
      payeeId: string;
      accountId: string;
      categoryId: string;
      targetVersionHash: string;
      expectedRuleSetHash: string;
    }
  | {
      kind: 'create_payee_rename_rule';
      proposalId: string;
      sourceSpellings: readonly string[];
      payeeId: string;
      expectedRuleSetHash: string;
    }
>;
```

Approval first records the immutable decision. Until each separate write gate
lands, the response is `manual-in-actual` guidance. `categorize_once` never
creates or updates a rule and remains deferred to FIN-46's conditional
transaction mutator.

Before presenting or later applying an action, validation occurs in this order:

1. validate the closed DTO, stable principal, idempotency binding, and pending
   proposal/decision;
2. reload the exact Actual target graph, payee, category, and complete rule set;
3. reject a missing/deleted entity, reconciled/split/category-changed target,
   currency/budget mismatch, or changed target/rule-set hash as `stale`;
4. reject an equivalent existing rule as already satisfied and a competing
   rule as conflict;
5. after FIN-44 only, anchor the application receipt and acquire the approved
   remote fence before invoking one narrow operation; and
6. require authoritative sync/outcome evidence before marking `applied`.

An intervening Actual edit always wins. A stale approval is never silently
retargeted.

## The only supported rule shapes

Actual's current `api/rule-create` path validates and inserts a rule; it does
not call `rule-apply-actions` or update existing transactions. The companion
must expose neither generic endpoint. FIN-25 may add one closed core operation
that accepts only one of these projections after FIN-42/44 provide fencing and
receipts:

```ts
type SupportedClassificationRuleV1 = Readonly<
  | {
      kind: 'category';
      payeeId: string;
      accountId: string;
      categoryId: string;
    }
  | {
      kind: 'payee-rename';
      sourceSpellings: readonly string[];
      payeeId: string;
    }
>;
```

The exact Actual rules are:

- category: `stage: null`, `conditionsOp: 'and'`, exact `payee is payeeId`,
  exact `account is accountId`, `category is null`, and `reconciled is false`;
  the sole action is `set category = categoryId`;
- payee rename: `stage: 'pre'`, `conditionsOp: 'and'`, exact
  `imported_payee oneOf sourceSpellings` and `reconciled is false`; the sole
  action is `set payee = payeeId`.

Source spellings are sorted unique, non-empty, and capped at 20. No condition,
operator, action, formula, note, split, date, amount, schedule, priority, stage,
or arbitrary JSON is caller-selectable. The server rebuilds and validates the
rule. Creating it never runs it against history. The reconciled condition also
prevents a later manual bulk apply from matching reconciled transactions.

Idempotency is bound to budget, stable principal, operation version, decision,
canonical supported-rule projection, expected rule-set hash, and target hash
when present. A replay returns the original rule ID/outcome. A changed request
conflicts; a timeout never infers success from a similar current rule.

Undo guidance is deliberately narrow: disable or delete the created rule by
its returned ID in Actual. That stops future matches but does not rewrite any
transaction. Any transaction changed later by normal Actual use is undone in
Actual separately.

## Ticket seams and focused tests

- FIN-23 owns migration 004 rows plus private detector/repository files under
  `packages/finance-companion/src/reviews/`; it produces DTOs and never imports
  the Actual API or writes Actual.
- FIN-24 owns the existing companion review route/UI and clearly separates
  `categorize_once`, `create rule`, reject, and manual guidance.
- FIN-25 remains blocked on FIN-42/44. It owns the closed core adapter operation
  and receipt/replay integration; it may not wrap `api/rule-create` generically.
- FIN-26 enables the explicit confirmation UI only after FIN-25 passes.

Focused synthetic tests cover alias agreement/conflict, exact thresholds,
dominant/tied/deleted categories, reconciled/split/already-categorized targets,
180-day suppression and version reset, stale target/rule hashes, equivalent and
competing rules, exact serialization of both supported shapes, and privacy.
The later write suite additionally proves rule creation changes no historical
transaction (including reconciled rows), loses no remote rule edit, replays one
rule ID, handles unknown outcomes through receipts, and gives safe undo text.
