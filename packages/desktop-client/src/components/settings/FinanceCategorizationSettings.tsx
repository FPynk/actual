import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useSyncedPref } from '#hooks/useSyncedPref';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { saveSyncedPrefs } from '#prefs/prefsSlice';
import { useDispatch } from '#redux';

import { OpenAIModelPicker } from './OpenAIModelPicker';
import { Setting } from './UI';

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
  const [expandedCategoryId, setExpandedCategoryId] = useState<string | null>(
    null,
  );
  const [modelListRevision, setModelListRevision] = useState(0);
  const [isSelectedModelCompatible, setIsSelectedModelCompatible] = useState<
    boolean | null
  >(null);
  const settingsEditVersion = useRef(0);
  const isSettingsSaveInFlight = useRef(false);
  const lastSubmittedSettings = useRef<{
    editVersion: number;
    serializedSettings: string;
  } | null>(null);
  const guidanceExpandButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const guidanceFocusToRestore = useRef<string | null>(null);

  useEffect(() => {
    const submittedSettings = lastSubmittedSettings.current;
    if (
      submittedSettings !== null &&
      submittedSettings.serializedSettings === serializedSettings
    ) {
      lastSubmittedSettings.current = null;
      if (settingsEditVersion.current !== submittedSettings.editVersion) {
        return;
      }
    }
    setDraftSettings(parseSettings(serializedSettings));
  }, [serializedSettings]);

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
  }, [refreshStatus, serverStatus]);

  const updateDraftSettings = (nextSettings: FinanceCategorizationSettings) => {
    settingsEditVersion.current += 1;
    setDraftSettings(nextSettings);
    setSettingsSaveStatus(status => (status === 'pending' ? status : 'idle'));
  };

  const saveSettings = async () => {
    if (isSettingsSaveInFlight.current || isSelectedModelCompatible === false) {
      return;
    }

    const saveVersion = settingsEditVersion.current;
    const availableCategoryIds = new Set(
      categories.map(category => category.id),
    );
    const categoryIds = draftSettings.categoryIds.filter(categoryId =>
      availableCategoryIds.has(categoryId),
    );
    const categoryGuidance = Object.fromEntries(
      categoryIds.map(categoryId => [
        categoryId,
        draftSettings.categoryGuidance[categoryId] || '',
      ]),
    );
    const serializedSettingsToSave = JSON.stringify({
      ...draftSettings,
      categoryGuidance,
      categoryIds,
      masterPrompt: draftSettings.masterPrompt.trim(),
      model: draftSettings.model.trim(),
    });
    isSettingsSaveInFlight.current = true;
    lastSubmittedSettings.current = {
      editVersion: saveVersion,
      serializedSettings: serializedSettingsToSave,
    };
    setSettingsSaveStatus('pending');
    try {
      await dispatch(
        saveSyncedPrefs({
          prefs: {
            'finance.openai-categorization': serializedSettingsToSave,
          },
        }),
      ).unwrap();
      setSettingsSaveStatus(
        settingsEditVersion.current === saveVersion ? 'saved' : 'idle',
      );
    } catch {
      if (
        lastSubmittedSettings.current?.serializedSettings ===
        serializedSettingsToSave
      ) {
        lastSubmittedSettings.current = null;
      }
      setSettingsSaveStatus(
        settingsEditVersion.current === saveVersion ? 'failed' : 'idle',
      );
    } finally {
      isSettingsSaveInFlight.current = false;
    }
  };

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
    setIsSelectedModelCompatible(null);
    setModelListRevision(revision => revision + 1);
  };

  const categories = (categoryData?.grouped ?? [])
    .filter(group => !group.hidden && !group.is_income)
    .flatMap(group => group.categories ?? [])
    .filter(category => !category.hidden && !category.is_income);
  const selectedCategoryIds = new Set(draftSettings.categoryIds);
  const areAllEligibleCategoriesSelected =
    categories.length > 0 &&
    categories.every(category => selectedCategoryIds.has(category.id));
  const expandedCategory = categories.find(
    category => category.id === expandedCategoryId,
  );
  const closeExpandedGuidance = () => {
    guidanceFocusToRestore.current = expandedCategoryId;
    setExpandedCategoryId(null);
  };

  useEffect(() => {
    if (!expandedCategoryId && guidanceFocusToRestore.current) {
      guidanceExpandButtonRefs.current
        .get(guidanceFocusToRestore.current)
        ?.focus();
      guidanceFocusToRestore.current = null;
    }
  }, [expandedCategoryId]);

  const isEnvironmentManaged = keyStatus?.source === 'environment';
  const isServerOffline = serverStatus === 'offline';
  const canSaveSettings =
    isSelectedModelCompatible !== false &&
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
                <Trans>Checking OpenAI API key status…</Trans>
              )}
            </Text>
            {error && <Text style={{ color: theme.errorText }}>{error}</Text>}

            <OpenAIModelPicker
              key={`${keyStatus?.configured ?? 'loading'}-${keyStatus?.source ?? 'loading'}-${modelListRevision}`}
              isDisabled={
                isServerOffline ||
                isSavingKey ||
                settingsSaveStatus === 'pending'
              }
              isUnavailable={isServerOffline}
              onSelectionValidityChange={setIsSelectedModelCompatible}
              value={draftSettings.model}
              onChange={model =>
                updateDraftSettings({ ...draftSettings, model })
              }
            />
            {isSelectedModelCompatible === false && (
              <Text role="alert" style={{ color: theme.warningText }}>
                <Trans>Choose a compatible OpenAI model before saving.</Trans>
              </Text>
            )}
            <FormField style={{ width: '100%' }}>
              <FormLabel title={t('Categorization instructions')} />
              <Input
                value={draftSettings.masterPrompt}
                onChange={event =>
                  updateDraftSettings({
                    ...draftSettings,
                    masterPrompt: event.currentTarget.value,
                  })
                }
                placeholder={t('Explain how to classify your spending')}
              />
            </FormField>

            <Text style={{ fontWeight: 600 }}>
              <Trans>Categories the AI may use</Trans>
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
            {categories.map(category => {
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
                        if (!event.currentTarget.checked) {
                          if (expandedCategoryId === category.id) {
                            closeExpandedGuidance();
                          }
                        }
                        updateDraftSettings({ ...draftSettings, categoryIds });
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
                        placeholder={t('Optional guidance for this category')}
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
                      <Text style={{ color: theme.warningText }}>
                        <Trans>
                          Keep guidance short and specific. Longer guidance
                          increases API cost and may reduce classification
                          consistency.
                        </Trans>
                      </Text>
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
                        aria-label={t('Expand guidance for {{categoryName}}', {
                          categoryName: category.name,
                        })}
                        onPress={() => setExpandedCategoryId(category.id)}
                      >
                        <Trans>Expand</Trans>
                      </Button>
                    </View>
                  )}
                </View>
              );
            })}
            <ButtonWithLoading
              isDisabled={!canSaveSettings || settingsSaveStatus === 'pending'}
              isLoading={settingsSaveStatus === 'pending'}
              onPress={saveSettings}
            >
              <Trans>Save categorization settings</Trans>
            </ButtonWithLoading>
            {settingsSaveStatus === 'saved' && (
              <Text role="status" style={{ color: theme.noticeText }}>
                <Trans>Settings saved</Trans>
              </Text>
            )}
            {settingsSaveStatus === 'failed' && (
              <Text role="alert" style={{ color: theme.errorText }}>
                <Trans>Unable to save categorization settings.</Trans>
              </Text>
            )}
            {!canSaveSettings && (
              <Text style={{ color: theme.warningText }}>
                <Trans>
                  Choose at least one category and provide a model and
                  categorization instructions.
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
      {expandedCategory && (
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
              aria-label={t('Guidance for {{categoryName}}', {
                categoryName: expandedCategory.name,
              })}
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
                  <Trans>
                    Guidance for {{ categoryName: expandedCategory.name }}
                  </Trans>
                </h2>
                <textarea
                  aria-label={t('Guidance for {{categoryName}}', {
                    categoryName: expandedCategory.name,
                  })}
                  value={
                    draftSettings.categoryGuidance[expandedCategory.id] || ''
                  }
                  onChange={event =>
                    updateDraftSettings({
                      ...draftSettings,
                      categoryGuidance: {
                        ...draftSettings.categoryGuidance,
                        [expandedCategory.id]: event.currentTarget.value,
                      },
                    })
                  }
                  placeholder={t('Optional guidance for this category')}
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
                <Text style={{ color: theme.warningText }}>
                  <Trans>
                    Keep guidance short and specific. Longer guidance increases
                    API cost and may reduce classification consistency.
                  </Trans>
                </Text>
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
