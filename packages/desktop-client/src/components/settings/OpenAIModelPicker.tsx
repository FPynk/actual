import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { FinanceCategorizationModel } from '@actual-app/core/types/finance';

import { FormField, FormLabel } from '#components/forms';

import { getOpenAiCategorizationModels } from './openAiCategorizationModels';
import type { OpenAiCategorizationModelsResult } from './openAiCategorizationModels';

type OpenAIModelPickerProps = {
  isDisabled?: boolean;
  isUnavailable?: boolean;
  loadModels?: (refresh?: boolean) => Promise<OpenAiCategorizationModelsResult>;
  onChange: (modelId: string) => void;
  onSelectionValidityChange?: (isCompatible: boolean) => void;
  value: string;
};

type PickerState =
  | { status: 'loading' }
  | { status: 'ready'; models: FinanceCategorizationModel[] }
  | { status: 'error'; reason: string };

const recommendedModelIds = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

function getModelOptionId(modelId: string) {
  return `openai-model-${modelId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function getErrorMessage(reason: string, t: (key: string) => string) {
  switch (reason) {
    case 'not-configured':
      return t('Add an OpenAI API key before choosing a model.');
    case 'unavailable':
      return t(
        'OpenAI model selection is unavailable while the server is offline.',
      );
    case 'provider-authentication-failed':
      return t('OpenAI rejected this API key. Check the key and refresh.');
    case 'provider-timeout':
    case 'provider-unavailable':
      return t('OpenAI is unavailable. Try refreshing the model list.');
    case 'invalid-provider-response':
      return t('OpenAI returned an invalid model list. Try refreshing it.');
    default:
      return t('Unable to load OpenAI models. Try refreshing the list.');
  }
}

function addUnavailableSavedModel(
  models: FinanceCategorizationModel[],
  selectedModelId: string,
): FinanceCategorizationModel[] {
  if (!selectedModelId || models.some(model => model.id === selectedModelId)) {
    return models;
  }
  return [
    ...models,
    {
      compatibility: 'incompatible',
      id: selectedModelId,
      isRecommended: false,
      reason: 'The saved model is not available for this OpenAI API key.',
    },
  ];
}

function sortModels(models: FinanceCategorizationModel[]) {
  return [...models].sort((left, right) => {
    const leftRecommendationIndex = recommendedModelIds.indexOf(left.id);
    const rightRecommendationIndex = recommendedModelIds.indexOf(right.id);
    if (leftRecommendationIndex !== -1 || rightRecommendationIndex !== -1) {
      return (
        (leftRecommendationIndex === -1
          ? Number.MAX_SAFE_INTEGER
          : leftRecommendationIndex) -
        (rightRecommendationIndex === -1
          ? Number.MAX_SAFE_INTEGER
          : rightRecommendationIndex)
      );
    }
    if (left.compatibility !== right.compatibility) {
      return left.compatibility === 'compatible' ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export function OpenAIModelPicker({
  isDisabled = false,
  isUnavailable = false,
  loadModels = getOpenAiCategorizationModels,
  onChange,
  onSelectionValidityChange,
  value,
}: OpenAIModelPickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [pickerState, setPickerState] = useState<PickerState>({
    status: 'loading',
  });
  const onSelectionValidityChangeRef = useRef(onSelectionValidityChange);
  onSelectionValidityChangeRef.current = onSelectionValidityChange;

  const load = useCallback(
    async (refresh = false) => {
      if (isUnavailable) {
        setPickerState({ status: 'error', reason: 'unavailable' });
        return;
      }
      setPickerState({ status: 'loading' });
      const result = await loadModels(refresh);
      if ('error' in result) {
        setPickerState({ status: 'error', reason: result.error });
        return;
      }
      setPickerState({ status: 'ready', models: result.models });
    },
    [isUnavailable, loadModels],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const loadedModels = pickerState.status === 'ready' ? pickerState.models : [];
  const hasUnavailableSavedModel =
    pickerState.status === 'ready' &&
    Boolean(value) &&
    !loadedModels.some(model => model.id === value);
  const selectedModel = loadedModels.find(model => model.id === value);
  const selectedModelStatus = hasUnavailableSavedModel
    ? t('Unavailable')
    : selectedModel?.isRecommended
      ? t('Recommended')
      : selectedModel?.compatibility === 'incompatible'
        ? t('Incompatible')
        : null;
  const models =
    pickerState.status === 'ready'
      ? sortModels(addUnavailableSavedModel(loadedModels, value))
      : [];
  const visibleModels = models.filter(model =>
    model.id.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const isLoading = pickerState.status === 'loading';
  const noModelsAreAvailable =
    pickerState.status === 'ready' && pickerState.models.length === 0;
  const selectableVisibleModels = useMemo(
    () => visibleModels.filter(model => model.compatibility === 'compatible'),
    [visibleModels],
  );

  useEffect(() => {
    if (pickerState.status !== 'ready') return;
    onSelectionValidityChangeRef.current?.(
      pickerState.models.find(model => model.id === value)?.compatibility ===
        'compatible',
    );
  }, [pickerState, value]);

  useEffect(() => {
    const modelIdToScrollIntoView = activeModelId ?? (isOpen ? value : null);
    if (!modelIdToScrollIntoView) return;
    document
      .getElementById(getModelOptionId(modelIdToScrollIntoView))
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeModelId, isOpen, pickerState, value]);

  const moveActiveModel = (direction: 1 | -1) => {
    if (selectableVisibleModels.length === 0) return;
    const currentIndex = selectableVisibleModels.findIndex(
      model => model.id === activeModelId,
    );
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : selectableVisibleModels.length - 1
        : (currentIndex + direction + selectableVisibleModels.length) %
          selectableVisibleModels.length;
    setActiveModelId(selectableVisibleModels[nextIndex].id);
  };

  const selectModel = (modelId: string) => {
    onChange(modelId);
    setSearch('');
    setActiveModelId(null);
    setIsOpen(false);
  };

  return (
    <FormField style={{ width: '100%' }}>
      <FormLabel title={t('Model')} htmlFor="openai-model-search" />
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Input
            id="openai-model-search"
            aria-describedby={
              selectedModelStatus ? 'openai-model-status' : undefined
            }
            aria-label={t('Model')}
            aria-activedescendant={
              activeModelId ? getModelOptionId(activeModelId) : undefined
            }
            aria-autocomplete="list"
            aria-controls="openai-model-listbox"
            aria-expanded={isOpen}
            disabled={isDisabled || isUnavailable}
            onChange={event => {
              setSearch(event.currentTarget.value);
              setActiveModelId(null);
              setIsOpen(true);
            }}
            onFocus={() => {
              setSearch('');
              setIsOpen(true);
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setIsOpen(true);
                moveActiveModel(event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter' && activeModelId) {
                event.preventDefault();
                selectModel(activeModelId);
              } else if (event.key === 'Escape') {
                setActiveModelId(null);
                setSearch('');
                setIsOpen(false);
              }
            }}
            placeholder={
              isOpen ? t('Search available OpenAI models') : t('Choose a model')
            }
            role="combobox"
            style={{ flex: '1 1 180px', minWidth: 0 }}
            value={isOpen ? search : value}
          />
          <Button
            isDisabled={isDisabled || isUnavailable || isLoading}
            onPress={() => void load(true)}
          >
            <Trans>Refresh models</Trans>
          </Button>
        </View>

        {!isOpen && selectedModelStatus && (
          <Text
            id="openai-model-status"
            style={{ color: theme.pageTextSubdued }}
          >
            {selectedModelStatus}
          </Text>
        )}

        {isLoading && (
          <Text role="status">
            <Trans>Loading OpenAI modelsâ€¦</Trans>
          </Text>
        )}
        {pickerState.status === 'error' && (
          <Text role="alert" style={{ color: theme.warningText }}>
            {getErrorMessage(pickerState.reason, t)}
          </Text>
        )}
        {noModelsAreAvailable && (
          <Text style={{ color: theme.warningText }}>
            <Trans>No OpenAI models are available for this API key.</Trans>
          </Text>
        )}
        {!isLoading && isOpen && visibleModels.length > 0 && (
          <View
            id="openai-model-listbox"
            aria-label={t('Available OpenAI models')}
            role="listbox"
            style={{
              border: `1px solid ${theme.tableBorder}`,
              borderRadius: 4,
              maxHeight: 220,
              overscrollBehavior: 'contain',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            {[
              {
                label: t('Recommended'),
                models: visibleModels.filter(model => model.isRecommended),
              },
              {
                label: t('Other compatible models'),
                models: visibleModels.filter(
                  model =>
                    !model.isRecommended &&
                    model.compatibility === 'compatible',
                ),
              },
              {
                label: t('Incompatible models'),
                models: visibleModels.filter(
                  model => model.compatibility === 'incompatible',
                ),
              },
            ].map(group =>
              group.models.length > 0 ? (
                <View
                  key={group.label}
                  aria-label={group.label}
                  role="group"
                  style={{ flexShrink: 0, width: '100%' }}
                >
                  <h3
                    style={{
                      color: theme.pageTextSubdued,
                      fontWeight: 600,
                      lineHeight: 1.35,
                      margin: 0,
                      padding: '8px 10px',
                    }}
                  >
                    {group.label}
                  </h3>
                  {group.models.map(model => {
                    const isCompatible = model.compatibility === 'compatible';
                    const isSelected = model.id === value;
                    const isUnavailableSavedModel =
                      hasUnavailableSavedModel && model.id === value;
                    return (
                      <div
                        key={model.id}
                        id={getModelOptionId(model.id)}
                        aria-label={`${model.id}${
                          model.isRecommended ? ` (${t('Recommended')})` : ''
                        }${
                          isUnavailableSavedModel
                            ? ` (${t('Unavailable')})`
                            : ''
                        }${model.reason ? `: ${model.reason}` : ''}`}
                        aria-selected={isSelected}
                        aria-disabled={isDisabled || !isCompatible}
                        role="option"
                        style={{ flexShrink: 0, width: '100%' }}
                      >
                        <Button
                          isDisabled={isDisabled || !isCompatible}
                          onPress={() => selectModel(model.id)}
                          style={{
                            alignItems: 'stretch',
                            borderRadius: 0,
                            boxSizing: 'border-box',
                            flexDirection: 'column',
                            gap: 4,
                            justifyContent: 'flex-start',
                            minWidth: 0,
                            padding: 8,
                            textAlign: 'left',
                            whiteSpace: 'normal',
                            width: '100%',
                          }}
                          variant={
                            isSelected || activeModelId === model.id
                              ? 'menuSelected'
                              : 'menu'
                          }
                        >
                          <Text
                            style={{
                              display: 'block',
                              fontWeight: 600,
                              lineHeight: 1.35,
                              overflowWrap: 'anywhere',
                              width: '100%',
                            }}
                          >
                            {model.id}
                            {model.isRecommended && ` (${t('Recommended')})`}
                            {isUnavailableSavedModel &&
                              ` (${t('Unavailable')})`}
                          </Text>
                          {model.reason && (
                            <Text
                              style={{
                                color: theme.pageTextSubdued,
                                display: 'block',
                                lineHeight: 1.35,
                                overflowWrap: 'anywhere',
                                width: '100%',
                              }}
                            >
                              {model.reason}
                            </Text>
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </View>
              ) : null,
            )}
          </View>
        )}
        {!isLoading &&
          isOpen &&
          models.length > 0 &&
          visibleModels.length === 0 && (
            <Text>
              <Trans>No OpenAI models match your search.</Trans>
            </Text>
          )}
      </View>
    </FormField>
  );
}

