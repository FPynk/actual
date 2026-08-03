import { send } from '@actual-app/core/platform/client/connection';
import type { FinanceCategorizationModelList } from '@actual-app/core/types/finance';

export type OpenAiCategorizationModelsResult =
  | FinanceCategorizationModelList
  | { error: string };

export async function getOpenAiCategorizationModels(
  refresh = false,
): Promise<OpenAiCategorizationModelsResult> {
  return await send('finance-categorization-models', { refresh });
}
