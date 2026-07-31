import type {
  ActualAdapterRequest,
  ActualAdapterResponse,
} from '#contracts/adapter';

export type AdapterWorkerStartMessage = Readonly<{
  kind: 'start';
  operationDirectory: string;
  operationOwnerMarker: string;
  ownershipNonce: string;
  workerOperationId: string;
  configuration: Readonly<{
    actualApiDirectory: string;
    actualApiDirectoryNonce: string;
    budgetBindingHash: string;
    companionInstanceId: string;
    serviceInstanceNonce: string;
    actualServerUrl: string;
    actualPassword: string;
    actualBudgetId: string;
    actualBudgetCurrency: string;
    actualBudgetEncryptionPassword?: string;
  }>;
}>;

export type AdapterWorkerParentMessage =
  | AdapterWorkerStartMessage
  | Readonly<{ kind: 'request'; request: ActualAdapterRequest }>
  | Readonly<{ kind: 'terminate' }>;

export type AdapterWorkerMessage =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'result'; response: ActualAdapterResponse }>
  | Readonly<{
      kind: 'problem';
      code: 'adapter_unhealthy' | 'actual_conflict' | 'payload_too_large';
    }>
  | Readonly<{ kind: 'shutdown-complete' }>;
