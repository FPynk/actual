export type ActualAdapterRequest =
  | ReadBudgetSnapshotRequest
  | ReadActualTargetRequest
  | RunAccountBankSyncRequest;

export type ReadBudgetSnapshotRequest = Readonly<{
  kind: 'read-budget-snapshot';
  sections: readonly ('accounts' | 'payees' | 'categories' | 'schedules')[];
  transactionRange?: Readonly<{
    startDate: string;
    endDateExclusive: string;
    accountIds?: readonly string[];
  }>;
}>;

export type ReadActualTargetRequest = Readonly<{
  kind: 'read-actual-target';
  target: Readonly<{ kind: 'transaction'; id: string }>;
}>;

export type RunAccountBankSyncRequest = Readonly<{
  kind: 'run-account-bank-sync';
  accountId: string;
}>;

export type ActualAccountV1 = Readonly<{
  id: string;
  name: string;
  offBudget: boolean;
  closed: boolean;
  syncSource:
    | 'goCardless'
    | 'simpleFin'
    | 'pluggyai'
    | 'enableBanking'
    | 'akahu'
    | null;
  lastSync: string | null;
  syncStatus:
    | 'ok'
    | 'pending'
    | 'sync-requested'
    | 'failed'
    | 'reauth-required'
    | 'attention-required'
    | 'rate-limit-exceeded'
    | 'timed-out'
    | 'account-missing'
    | null;
}>;

export type ActualPayeeV1 = Readonly<{
  id: string;
  name: string;
  transferAccountId: string | null;
}>;

export type ActualCategoryGroupV1 = Readonly<{
  id: string;
  name: string;
  isIncome: boolean;
  hidden: boolean;
}>;

export type ActualCategoryV1 = Readonly<{
  id: string;
  name: string;
  groupId: string;
  isIncome: boolean;
  hidden: boolean;
}>;

export type ActualTransactionV1 = Readonly<{
  id: string;
  accountId: string;
  parentId: string | null;
  transferId: string | null;
  date: string;
  amountMinorUnits: number;
  payeeId: string | null;
  categoryId: string | null;
  notes: string | null;
  importedId: string | null;
  importedPayee: string | null;
  cleared: boolean;
  reconciled: boolean;
  isParent: boolean;
  isChild: boolean;
  isStartingBalance: boolean;
  tombstone: boolean;
}>;

export type SubscriptionScheduleSnapshotV1 = Readonly<{
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

export type ActualBudgetSnapshotV1 = Readonly<{
  contractVersion: 1;
  budget: Readonly<{
    budgetKeyHash: string;
    currencyCode: string;
    capturedAt: string;
  }>;
  accounts?: readonly ActualAccountV1[];
  payees?: readonly ActualPayeeV1[];
  categoryGroups?: readonly ActualCategoryGroupV1[];
  categories?: readonly ActualCategoryV1[];
  schedules?: readonly SubscriptionScheduleSnapshotV1[];
  transactions?: readonly ActualTransactionV1[];
}>;

export type ActualTransactionGraphV1 = Readonly<{
  contractVersion: 1;
  parent: ActualTransactionV1;
  children: readonly ActualTransactionV1[];
  targetVersionHash: string;
}>;

export type AccountBankSyncOutcomeCode =
  | 'succeeded'
  | 'authentication-required'
  | 'rate-limited'
  | 'timed-out'
  | 'configuration-error'
  | 'provider-error'
  | 'final-sync-failed'
  | 'skipped'
  | 'canceled'
  | 'outcome-unknown';

export type AccountBankSyncResultV1 = Readonly<{
  contractVersion: 1;
  accountId: string;
  startedAt: string;
  completedAt: string;
  outcomeCode: AccountBankSyncOutcomeCode;
  transactionCounts: null;
  finalSyncCode: 'succeeded' | 'failed' | 'not-attempted' | 'outcome-unknown';
}>;

export type ActualAdapterResponse =
  | Readonly<{ kind: 'read-budget-snapshot'; snapshot: ActualBudgetSnapshotV1 }>
  | Readonly<{ kind: 'read-actual-target'; target: ActualTransactionGraphV1 }>
  | Readonly<{
      kind: 'run-account-bank-sync';
      result: AccountBankSyncResultV1;
    }>;

export type AdapterProblemCode =
  | 'adapter_timeout'
  | 'adapter_unhealthy'
  | 'payload_too_large'
  | 'invalid_adapter_request'
  | 'actual_conflict';

export class ActualAdapterError extends Error {
  readonly code: AdapterProblemCode;
  bankSyncWorkBegan = false;
  quarantineBundleHash: string | undefined;

  constructor(code: AdapterProblemCode) {
    super(code);
    this.code = code;
    this.name = 'ActualAdapterError';
  }
}
