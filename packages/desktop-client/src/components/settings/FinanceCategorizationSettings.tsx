import React, {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import {
  defaultFinanceCategorizationSettings,
  defaultOpenAiCategorizationModel,
} from '@actual-app/core/types/finance';
import type { FinanceCategorizationSettings } from '@actual-app/core/types/finance';

import { Link } from '#components/common/Link';
import { Checkbox, FormField, FormLabel } from '#components/forms';
import { useCategories } from '#hooks/useCategories';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { saveSyncedPrefs } from '#prefs/prefsSlice';
import { useDispatch } from '#redux';

import { OpenAIModelPicker } from './OpenAIModelPicker';
import { Setting } from './UI';

const masterPromptEditorKey = 'master-prompt';
const settingsAutoSaveDelay = 500;

type ExpandedGuidanceEditor =
  | { type: 'master' }
  | { type: 'category'; categoryId: string };

type SettingsSaveCandidate = {
  budgetId: string | undefined;
  editVersion: number;
  isValid: boolean;
  serializedSettings: string;
};

function serializeSettings(
  settings: FinanceCategorizationSettings,
  availableCategoryIds: string[],
) {
  const availableCategoryIdSet = new Set(availableCategoryIds);
  const categoryIds = settings.categoryIds.filter(categoryId =>
    availableCategoryIdSet.has(categoryId),
  );
  const categoryGuidance = Object.fromEntries(
    categoryIds.map(categoryId => [
      categoryId,
      settings.categoryGuidance[categoryId] || '',
    ]),
  );

  return JSON.stringify({
    ...settings,
    categoryGuidance,
    categoryIds,
    masterPrompt: settings.masterPrompt,
    model: settings.model.trim(),
  });
}

function parseSettings(
  value: string | undefined,
): FinanceCategorizationSettings {
  if (!value) return defaultFinanceCategorizationSettings;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultFinanceCategorizationSettings;
    }
    const categoryGuidance = Object.fromEntries(
      Object.entries(
        parsed.categoryGuidance &&
          typeof parsed.categoryGuidance === 'object' &&
          !Array.isArray(parsed.categoryGuidance)
          ? parsed.categoryGuidance
          : {},
      ).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const parsedCategoryIds: unknown[] = Array.isArray(parsed.categoryIds)
      ? parsed.categoryIds
      : [];
    const categoryIds = [
      ...new Set(
        parsedCategoryIds.filter(
          (id: unknown): id is string => typeof id === 'string',
        ),
      ),
    ];
    return {
      categoryGuidance,
      categoryIds,
      masterPrompt:
        typeof parsed.masterPrompt === 'string'
          ? parsed.masterPrompt
          : defaultFinanceCategorizationSettings.masterPrompt,
      model:
        typeof parsed.model === 'string' && parsed.model
          ? parsed.model
          : defaultOpenAiCategorizationModel,
    };
  } catch {
    return defaultFinanceCategorizationSettings;
  }
}

export function FinanceCategorizationSettings() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const serverStatus = useSyncServerStatus();
  const [budgetId] = useMetadataPref('id');
  const [serializedSettings] = useSyncedPref('finance.openai-categorization');
  const [draftSettings, setDraftSettings] = useState(() =>
    parseSettings(serializedSettings),
  );
  const { data: categoryData } = useCategories();
  const [apiKey, setApiKey] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{
    configured: boolean;
    source: 'budget' | 'environment' | 'global' | 'none';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<
    'idle' | 'pending' | 'saved' | 'failed'
  >('idle');
  const [expandedGuidanceEditor, setExpandedGuidanceEditor] =
    useState<ExpandedGuidanceEditor | null>(null);
  const [modelListRevision, setModelListRevision] = useState(0);
  const [isSelectedModelCompatible, setIsSelectedModelCompatible] = useState<
    boolean | null
  >(null);
  const draftSettingsRef = useRef(draftSettings);
  const settingsEditVersion = useRef(0);
  const lastSettledEditVersion = useRef(0);
  const isSettingsSaveInFlight = useRef(false);
  const settingsAutoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const latestSaveCandidate = useRef<SettingsSaveCandidate | null>(null);
  const submittedSettings = useRef(new Map<string, number>());
  const selectedModelCompatibilityRef = useRef<boolean | null>(null);
  const isComponentMounted = useRef(true);
  const currentBudgetIdRef = useRef(budgetId);
  const previousBudgetIdRef = useRef(budgetId);
  currentBudgetIdRef.current = budgetId;
  const guidanceExpandButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const guidanceFocusToRestore = useRef<string | null>(null);
  const flushPendingSettingsSave = useEffectEvent(() => {
    clearSettingsAutoSaveTimer();
    requestSettingsSave();
  });

  useEffect(() => {
    if (previousBudgetIdRef.current !== budgetId) {
      previousBudgetIdRef.current = budgetId;
      clearSettingsAutoSaveTimer();
      settingsEditVersion.current = 0;
      lastSettledEditVersion.current = 0;
      latestSaveCandidate.current = null;
      submittedSettings.current.clear();
      selectedModelCompatibilityRef.current = null;
      const nextSettings = parseSettings(serializedSettings);
      draftSettingsRef.current = nextSettings;
      setDraftSettings(nextSettings);
      setIsSelectedModelCompatible(null);
      setSettingsSaveStatus('idle');
      return;
    }

    const submittedEditVersion =
      serializedSettings === undefined
        ? undefined
        : submittedSettings.current.get(serializedSettings);
    if (
      submittedEditVersion !== undefined &&
      serializedSettings !== undefined
    ) {
      submittedSettings.current.delete(serializedSettings);
      return;
    }

    const hasLocalChanges =
      settingsEditVersion.current !== lastSettledEditVersion.current;
    if (
      hasLocalChanges ||
      isSettingsSaveInFlight.current ||
      settingsAutoSaveTimer.current !== null
    ) {
      return;
    }

    const nextSettings = parseSettings(serializedSettings);
    draftSettingsRef.current = nextSettings;
    latestSaveCandidate.current = null;
    setDraftSettings(nextSettings);
    setSettingsSaveStatus('idle');
  }, [budgetId, serializedSettings]);

  useEffect(() => {
    isComponentMounted.current = true;
    return () => {
      isComponentMounted.current = false;
      flushPendingSettingsSave();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    const result = await send('finance-categorization-status');
    if ('error' in result) {
      setError(t('Unable to check the OpenAI API key status.'));
      setKeyStatus(null);
      return;
    }
    setError(null);
    setKeyStatus({ configured: result.configured, source: result.source });
  }, [t]);

  useEffect(() => {
    if (serverStatus === 'online') {
      void refreshStatus();
    }
  }, [budgetId, refreshStatus, serverStatus]);

  const categoryGroups = (categoryData?.grouped ?? [])
    .filter(group => !group.hidden)
    .map(group => ({
      ...group,
      categories: (group.categories ?? []).filter(category => !category.hidden),
    }))
    .filter(group => group.categories.length > 0);
  const categories = categoryGroups.flatMap(group => group.categories);
  const availableCategoryIds = categories.map(category => category.id);
  const availableCategoriesFingerprint =
    categoryData === undefined ? null : availableCategoryIds.join('\0');

  function createSettingsSaveCandidate(
    settings: FinanceCategorizationSettings,
    editVersion: number,
  ): SettingsSaveCandidate {
    return {
      budgetId,
      editVersion,
      isValid:
        budgetId !== undefined &&
        categoryData !== undefined &&
        selectedModelCompatibilityRef.current === true &&
        settings.model.trim().length > 0 &&
        settings.masterPrompt.trim().length > 0 &&
        settings.categoryIds.some(categoryId =>
          availableCategoryIds.includes(categoryId),
        ),
      serializedSettings: serializeSettings(settings, availableCategoryIds),
    };
  }

  function clearSettingsAutoSaveTimer() {
    if (settingsAutoSaveTimer.current !== null) {
      clearTimeout(settingsAutoSaveTimer.current);
      settingsAutoSaveTimer.current = null;
    }
  }

  function scheduleSettingsSave(candidate: SettingsSaveCandidate) {
    clearSettingsAutoSaveTimer();
    latestSaveCandidate.current = candidate;
    if (!candidate.isValid) {
      if (!isSettingsSaveInFlight.current) {
        setSettingsSaveStatus('idle');
      }
      return;
    }

    settingsAutoSaveTimer.current = setTimeout(() => {
      settingsAutoSaveTimer.current = null;
      requestSettingsSave();
    }, settingsAutoSaveDelay);
  }

  function updateDraftSettings(nextSettings: FinanceCategorizationSettings) {
    const editVersion = settingsEditVersion.current + 1;
    settingsEditVersion.current = editVersion;
    draftSettingsRef.current = nextSettings;
    setDraftSettings(nextSettings);
    setSettingsSaveStatus(status => (status === 'pending' ? status : 'idle'));
    scheduleSettingsSave(
      createSettingsSaveCandidate(nextSettings, editVersion),
    );
  }

  function requestSettingsSave() {
    clearSettingsAutoSaveTimer();
    const candidate = latestSaveCandidate.current;
    if (
      !candidate ||
      !candidate.isValid ||
      candidate.editVersion === lastSettledEditVersion.current
    ) {
      return;
    }
    if (isSettingsSaveInFlight.current) {
      return;
    }
    void persistSettings(candidate);
  }

  async function persistSettings(candidate: SettingsSaveCandidate) {
    if (isSettingsSaveInFlight.current) {
      return;
    }

    isSettingsSaveInFlight.current = true;
    submittedSettings.current.set(
      candidate.serializedSettings,
      candidate.editVersion,
    );
    if (isComponentMounted.current) {
      setSettingsSaveStatus('pending');
    }
    let didSave = false;
    try {
      const result = await dispatch(
        saveSyncedPrefs({
          expectedBudgetId: candidate.budgetId,
          prefs: {
            'finance.openai-categorization': candidate.serializedSettings,
          },
        }),
      ).unwrap();
      if (result?.saved === false) {
        submittedSettings.current.delete(candidate.serializedSettings);
      } else {
        didSave = true;
        if (candidate.budgetId === currentBudgetIdRef.current) {
          lastSettledEditVersion.current = Math.max(
            lastSettledEditVersion.current,
            candidate.editVersion,
          );
        }
      }
    } catch {
      submittedSettings.current.delete(candidate.serializedSettings);
    } finally {
      isSettingsSaveInFlight.current = false;
      const latestCandidate = latestSaveCandidate.current;
      if (!isComponentMounted.current) {
        if (
          latestCandidate !== null &&
          latestCandidate.isValid &&
          latestCandidate.budgetId === candidate.budgetId &&
          latestCandidate.editVersion > candidate.editVersion
        ) {
          void persistSettings(latestCandidate);
        }
      } else {
        const didBudgetChange =
          candidate.budgetId !== currentBudgetIdRef.current;
        const shouldSaveLatestBudget =
          latestCandidate !== null &&
          latestCandidate.budgetId === currentBudgetIdRef.current &&
          latestCandidate.isValid;

        if (didBudgetChange && shouldSaveLatestBudget) {
          clearSettingsAutoSaveTimer();
          void persistSettings(latestCandidate);
        } else if (didBudgetChange) {
          setSettingsSaveStatus('idle');
        } else if (
          shouldSaveLatestBudget &&
          latestCandidate.serializedSettings !== candidate.serializedSettings
        ) {
          clearSettingsAutoSaveTimer();
          void persistSettings(latestCandidate);
        } else if (
          latestCandidate !== null &&
          latestCandidate.serializedSettings === candidate.serializedSettings
        ) {
          if (didSave) {
            lastSettledEditVersion.current = Math.max(
              lastSettledEditVersion.current,
              latestCandidate.editVersion,
            );
          }
          setSettingsSaveStatus(
            latestCandidate.isValid ? (didSave ? 'saved' : 'failed') : 'idle',
          );
        } else if (latestCandidate !== null) {
          setSettingsSaveStatus('idle');
        } else {
          setSettingsSaveStatus(didSave ? 'saved' : 'failed');
        }
      }
    }
  }

  function flushSettingsSave() {
    requestSettingsSave();
  }

  function updateSelectedModelCompatibility(isCompatible: boolean | null) {
    selectedModelCompatibilityRef.current = isCompatible;
    setIsSelectedModelCompatible(isCompatible);
    if (isCompatible !== true && !isSettingsSaveInFlight.current) {
      setSettingsSaveStatus('idle');
    }
    if (settingsEditVersion.current !== lastSettledEditVersion.current) {
      scheduleSettingsSave(
        createSettingsSaveCandidate(
          draftSettingsRef.current,
          settingsEditVersion.current,
        ),
      );
    }
  }

  const reEvaluateSettingsAfterCategoriesChange = useEffectEvent(() => {
    if (settingsEditVersion.current !== lastSettledEditVersion.current) {
      scheduleSettingsSave(
        createSettingsSaveCandidate(
          draftSettingsRef.current,
          settingsEditVersion.current,
        ),
      );
    }
  });

  useEffect(() => {
    reEvaluateSettingsAfterCategoriesChange();
  }, [availableCategoriesFingerprint]);

  const saveApiKey = async () => {
    if (!apiKey.trim()) return;
    setIsSavingKey(true);
    setError(null);
    const result = await send('finance-categorization-api-key-set', {
      value: apiKey.trim(),
    });
    setIsSavingKey(false);
    if ('error' in result) {
      setError(t('Unable to save the OpenAI API key.'));
      return;
    }
    setApiKey('');
    await refreshStatus();
    selectedModelCompatibilityRef.current = null;
    setIsSelectedModelCompatible(null);
    setModelListRevision(revision => revision + 1);
  };

  const removeApiKey = async () => {
    setIsSavingKey(true);
    setError(null);
    const result = await send('finance-categorization-api-key-set', {
      value: null,
    });
    setIsSavingKey(false);
    if ('error' in result) {
      setError(t('Unable to remove the budget OpenAI API key.'));
      return;
    }
    await refreshStatus();
    selectedModelCompatibilityRef.current = null;
    setIsSelectedModelCompatible(null);
    setModelListRevision(revision => revision + 1);
  };

  const selectedCategoryIds = new Set(draftSettings.categoryIds);
  const areAllEligibleCategoriesSelected =
    categories.length > 0 &&
    categories.every(category => selectedCategoryIds.has(category.id));
  const expandedCategory =
    expandedGuidanceEditor?.type === 'category'
      ? categories.find(
          category => category.id === expandedGuidanceEditor.categoryId,
        )
      : undefined;
  const isMasterPromptExpanded = expandedGuidanceEditor?.type === 'master';
  const closeExpandedGuidance = () => {
    flushSettingsSave();
    guidanceFocusToRestore.current = isMasterPromptExpanded
      ? masterPromptEditorKey
      : expandedCategory?.id || null;
    setExpandedGuidanceEditor(null);
  };

  useEffect(() => {
    if (!expandedGuidanceEditor && guidanceFocusToRestore.current) {
      guidanceExpandButtonRefs.current
        .get(guidanceFocusToRestore.current)
        ?.focus();
      guidanceFocusToRestore.current = null;
    }
  }, [expandedGuidanceEditor]);

  const isEnvironmentManaged = keyStatus?.source === 'environment';
  const isServerOffline = serverStatus === 'offline';
  const canSaveSettings =
    budgetId !== undefined &&
    categoryData !== undefined &&
    isSelectedModelCompatible === true &&
    draftSettings.model.trim().length > 0 &&
    draftSettings.masterPrompt.trim().length > 0 &&
    draftSettings.categoryIds.some(categoryId =>
      categories.some(category => category.id === categoryId),
    );

  if (serverStatus === 'no-server') return null;

  return (
    <>
      <Setting
        primaryAction={
          <View style={{ alignItems: 'flex-start', gap: 12, width: '100%' }}>
            <FormField style={{ width: '100%' }}>
              <FormLabel title={t('OpenAI API key')} />
              <Input
                type="password"
                value={apiKey}
                onChange={event => setApiKey(event.currentTarget.value)}
                disabled={isEnvironmentManaged}
              />
            </FormField>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <ButtonWithLoading
                isDisabled={
                  isEnvironmentManaged ||
                  isServerOffline ||
                  apiKey.trim().length === 0
                }
                isLoading={isSavingKey}
                onPress={saveApiKey}
              >
                <Trans>Save API key</Trans>
              </ButtonWithLoading>
              <Button
                isDisabled={
                  isSavingKey ||
                  isServerOffline ||
                  keyStatus?.source !== 'budget'
                }
                onPress={removeApiKey}
              >
                <Trans>Remove budget key</Trans>
              </Button>
            </View>
            <Text
              style={{
                color:
                  keyStatus?.configured && !isServerOffline
                    ? theme.noticeText
                    : theme.warningText,
              }}
            >
              {isServerOffline ? (
                <Trans>
                  The Actual server is offline. OpenAI key settings are
                  unavailable.
                </Trans>
              ) : keyStatus?.source === 'environment' ? (
                <Trans>
                  The OpenAI API key is managed by the server operator and
                  cannot be changed here.
                </Trans>
              ) : keyStatus?.source === 'global' ? (
                <Trans>
                  A global OpenAI API key is configured. Saving a key here will
                  create an override for this budget.
                </Trans>
              ) : keyStatus?.source === 'budget' ? (
                <Trans>An OpenAI API key is configured for this budget.</Trans>
              ) : keyStatus ? (
                <Trans>No OpenAI API key is configured.</Trans>
              ) : (
                <Trans>Checking OpenAI API key statusâ€¦</Trans>
              )}
            </Text>
            {error && <Text style={{ color: theme.errorText }}>{error}</Text>}

            <OpenAIModelPicker
              key={`${budgetId ?? 'no-budget'}-${keyStatus?.configured ?? 'loading'}-${keyStatus?.source ?? 'loading'}-${modelListRevision}`}
              isDisabled={isServerOffline || isSavingKey}
              isUnavailable={isServerOffline}
              onSelectionValidityChange={updateSelectedModelCompatibility}
              value={draftSettings.model}
              onChange={model => {
                selectedModelCompatibilityRef.current = null;
                setIsSelectedModelCompatible(null);
                updateDraftSettings({ ...draftSettings, model });
              }}
            />
            {isSelectedModelCompatible === false && (
              <Text role="alert" style={{ color: theme.warningText }}>
                <Trans>Choose a compatible OpenAI model before saving.</Trans>
              </Text>
            )}
            <FormField
              style={{ alignItems: 'flex-start', gap: 4, width: '100%' }}
            >
              <FormLabel
                htmlFor="finance-categorization-instructions"
                title={t('Categorization instructions')}
              />
              <textarea
                id="finance-categorization-instructions"
                value={draftSettings.masterPrompt}
                onChange={event =>
                  updateDraftSettings({
                    ...draftSettings,
                    masterPrompt: event.currentTarget.value,
                  })
                }
                onBlur={flushSettingsSave}
                placeholder={t('Explain how to categorize your transactions')}
                style={{
                  backgroundColor: theme.tableBackground,
                  border: `1px solid ${theme.formInputBorder}`,
                  borderRadius: 4,
                  color: theme.tableText,
                  maxHeight: 160,
                  minHeight: 80,
                  overflowY: 'auto',
                  padding: 7,
                  resize: 'vertical',
                  width: '100%',
                }}
              />
              <Button
                ref={element => {
                  if (element) {
                    guidanceExpandButtonRefs.current.set(
                      masterPromptEditorKey,
                      element,
                    );
                  } else {
                    guidanceExpandButtonRefs.current.delete(
                      masterPromptEditorKey,
                    );
                  }
                }}
                variant="bare"
                aria-label={t('Expand categorization instructions')}
                onPress={() => setExpandedGuidanceEditor({ type: 'master' })}
              >
                <Trans>Expand</Trans>
              </Button>
            </FormField>

            <Text style={{ fontWeight: 600 }}>
              <Trans>Categories the AI may use for inflows and outflows</Trans>
            </Text>
            <Button
              isDisabled={
                categories.length === 0 || areAllEligibleCategoriesSelected
              }
              onPress={() =>
                updateDraftSettings({
                  ...draftSettings,
                  categoryIds: categories.map(category => category.id),
                })
              }
            >
              <Trans>Select all</Trans>
            </Button>
            <Text style={{ color: theme.warningText }}>
              <Trans>
                Keep guidance short and specific. Longer guidance increases API
                cost and may reduce classification consistency.
              </Trans>
            </Text>
            {categoryGroups.map(group => (
              <View key={group.id} style={{ gap: 8, width: '100%' }}>
                <Text style={{ fontWeight: 600 }}>{group.name}</Text>
                {group.categories.map(category => {
                  const selected = selectedCategoryIds.has(category.id);
                  return (
                    <View key={category.id} style={{ gap: 4, width: '100%' }}>
                      <Text style={{ display: 'flex' }}>
                        <Checkbox
                          id={`finance-category-${category.id}`}
                          checked={selected}
                          onChange={event => {
                            const categoryIds = event.currentTarget.checked
                              ? [...draftSettings.categoryIds, category.id]
                              : draftSettings.categoryIds.filter(
                                  id => id !== category.id,
                                );
                            updateDraftSettings({
                              ...draftSettings,
                              categoryIds,
                            });
                            if (
                              !event.currentTarget.checked &&
                              expandedGuidanceEditor?.type === 'category' &&
                              expandedGuidanceEditor.categoryId === category.id
                            ) {
                              closeExpandedGuidance();
                            }
                          }}
                        />
                        <label htmlFor={`finance-category-${category.id}`}>
                          {category.name}
                        </label>
                      </Text>
                      {selected && (
                        <View style={{ alignItems: 'flex-start', gap: 4 }}>
                          <textarea
                            aria-label={t('Guidance for {{categoryName}}', {
                              categoryName: category.name,
                            })}
                            value={
                              draftSettings.categoryGuidance[category.id] || ''
                            }
                            onChange={event =>
                              updateDraftSettings({
                                ...draftSettings,
                                categoryGuidance: {
                                  ...draftSettings.categoryGuidance,
                                  [category.id]: event.currentTarget.value,
                                },
                              })
                            }
                            onBlur={flushSettingsSave}
                            placeholder={t(
                              'Optional guidance for this category',
                            )}
                            style={{
                              backgroundColor: theme.tableBackground,
                              border: `1px solid ${theme.formInputBorder}`,
                              borderRadius: 4,
                              color: theme.tableText,
                              maxHeight: 160,
                              minHeight: 80,
                              overflowY: 'auto',
                              padding: 7,
                              resize: 'vertical',
                              width: '100%',
                            }}
                          />
                          <Button
                            ref={element => {
                              if (element) {
                                guidanceExpandButtonRefs.current.set(
                                  category.id,
                                  element,
                                );
                              } else {
                                guidanceExpandButtonRefs.current.delete(
                                  category.id,
                                );
                              }
                            }}
                            variant="bare"
                            aria-label={t(
                              'Expand guidance for {{categoryName}}',
                              { categoryName: category.name },
                            )}
                            onPress={() =>
                              setExpandedGuidanceEditor({
                                type: 'category',
                                categoryId: category.id,
                              })
                            }
                          >
                            <Trans>Expand</Trans>
                          </Button>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
            {settingsSaveStatus === 'pending' && (
              <Text role="status">
                <Trans>Savingâ€¦</Trans>
              </Text>
            )}
            {settingsSaveStatus === 'saved' && (
              <Text role="status" style={{ color: theme.noticeText }}>
                <Trans>Settings saved</Trans>
              </Text>
            )}
            {settingsSaveStatus === 'failed' && (
              <View style={{ alignItems: 'flex-start', gap: 8 }}>
                <Text role="alert" style={{ color: theme.errorText }}>
                  <Trans>Unable to save categorization settings.</Trans>
                </Text>
                <Button
                  isDisabled={!canSaveSettings}
                  onPress={flushSettingsSave}
                >
                  <Trans>Retry</Trans>
                </Button>
              </View>
            )}
            {!canSaveSettings && (
              <Text style={{ color: theme.warningText }}>
                <Trans>
                  Changes are not saved until you choose at least one category
                  and provide a compatible model and categorization
                  instructions.
                </Trans>
              </Text>
            )}
          </View>
        }
      >
        <Text>
          <Trans>
            <strong>AI transaction categorization</strong> sends descriptions,
            payees, dates, amounts, currency, account names, your selected
            category names and guidance, and your custom instruction to OpenAI
            to generate suggestions. No OpenAI API key, Actual transaction IDs,
            notes, attachments, balances, budget name, or transactions outside
            the scope you choose are sent. OpenAI requests use no provider-side
            response storage.
          </Trans>{' '}
          <Link
            variant="external"
            to="https://developers.openai.com/api/docs/guides/your-data"
            linkColor="purple"
          >
            <Trans>Learn about OpenAI data controls.</Trans>
          </Link>
        </Text>
      </Setting>
      {(isMasterPromptExpanded || expandedCategory) && (
        <ModalOverlay
          isOpen
          onOpenChange={isOpen => {
            if (!isOpen) closeExpandedGuidance();
          }}
          style={{
            alignItems: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            display: 'flex',
            inset: 0,
            justifyContent: 'center',
            position: 'fixed',
            zIndex: 3000,
          }}
        >
          <Modal isDismissable>
            <Dialog
              aria-label={
                isMasterPromptExpanded
                  ? t('Categorization instructions')
                  : t('Guidance for {{categoryName}}', {
                      categoryName: expandedCategory?.name || '',
                    })
              }
              style={{
                backgroundColor: theme.modalBackground,
                borderRadius: 6,
                color: theme.pageText,
                maxWidth: 'min(700px, 90vw)',
                outline: 'none',
                padding: 20,
                width: '100%',
              }}
            >
              <View style={{ alignItems: 'stretch', gap: 12 }}>
                <h2 style={{ fontSize: 20, margin: 0 }}>
                  {isMasterPromptExpanded ? (
                    <Trans>Categorization instructions</Trans>
                  ) : (
                    <Trans>
                      Guidance for {{ categoryName: expandedCategory?.name }}
                    </Trans>
                  )}
                </h2>
                <textarea
                  aria-label={
                    isMasterPromptExpanded
                      ? t('Categorization instructions')
                      : t('Guidance for {{categoryName}}', {
                          categoryName: expandedCategory?.name || '',
                        })
                  }
                  value={
                    isMasterPromptExpanded
                      ? draftSettings.masterPrompt
                      : expandedCategory
                        ? draftSettings.categoryGuidance[expandedCategory.id] ||
                          ''
                        : ''
                  }
                  onChange={event => {
                    if (isMasterPromptExpanded) {
                      updateDraftSettings({
                        ...draftSettings,
                        masterPrompt: event.currentTarget.value,
                      });
                    } else if (expandedCategory) {
                      updateDraftSettings({
                        ...draftSettings,
                        categoryGuidance: {
                          ...draftSettings.categoryGuidance,
                          [expandedCategory.id]: event.currentTarget.value,
                        },
                      });
                    }
                  }}
                  onBlur={flushSettingsSave}
                  placeholder={
                    isMasterPromptExpanded
                      ? t('Explain how to categorize your transactions')
                      : t('Optional guidance for this category')
                  }
                  style={{
                    backgroundColor: theme.tableBackground,
                    border: `1px solid ${theme.formInputBorder}`,
                    borderRadius: 4,
                    color: theme.tableText,
                    minHeight: 280,
                    overflowY: 'auto',
                    padding: 7,
                    resize: 'vertical',
                    width: '100%',
                  }}
                />
                <Button onPress={closeExpandedGuidance}>
                  <Trans>Close</Trans>
                </Button>
              </View>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
    </>
  );
}

