import React, { useCallback, useEffect, useState } from 'react';
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
    const categoryIds = Array.isArray(parsed.categoryIds)
      ? [...new Set(parsed.categoryIds.filter(id => typeof id === 'string'))]
      : [];
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
  const serverStatus = useSyncServerStatus();
  const [serializedSettings, setSerializedSettings] = useSyncedPref(
    'finance.openai-categorization',
  );
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

  useEffect(() => {
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

  const saveSettings = () => {
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
    setSerializedSettings(
      JSON.stringify({
        ...draftSettings,
        categoryGuidance,
        categoryIds,
        masterPrompt: draftSettings.masterPrompt.trim(),
        model: draftSettings.model.trim(),
      }),
    );
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
  };

  const categories = (categoryData?.list ?? []).filter(
    category => !category.hidden,
  );
  const selectedCategoryIds = new Set(draftSettings.categoryIds);
  const isEnvironmentManaged = keyStatus?.source === 'environment';
  const isServerOffline = serverStatus === 'offline';
  const canSaveSettings =
    draftSettings.model.trim().length > 0 &&
    draftSettings.masterPrompt.trim().length > 0 &&
    draftSettings.categoryIds.some(categoryId =>
      categories.some(category => category.id === categoryId),
    );

  if (serverStatus === 'no-server') return null;

  return (
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
                isSavingKey || isServerOffline || keyStatus?.source !== 'budget'
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
                The OpenAI API key is managed by the server operator and cannot
                be changed here.
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

          <FormField style={{ width: '100%' }}>
            <FormLabel title={t('Model')} />
            <Input
              value={draftSettings.model}
              onChange={event =>
                setDraftSettings({
                  ...draftSettings,
                  model: event.currentTarget.value,
                })
              }
            />
          </FormField>
          <FormField style={{ width: '100%' }}>
            <FormLabel title={t('Categorization instructions')} />
            <Input
              value={draftSettings.masterPrompt}
              onChange={event =>
                setDraftSettings({
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
                      setDraftSettings({ ...draftSettings, categoryIds });
                    }}
                  />
                  <label htmlFor={`finance-category-${category.id}`}>
                    {category.name}
                  </label>
                </Text>
                {selected && (
                  <Input
                    value={draftSettings.categoryGuidance[category.id] || ''}
                    onChange={event =>
                      setDraftSettings({
                        ...draftSettings,
                        categoryGuidance: {
                          ...draftSettings.categoryGuidance,
                          [category.id]: event.currentTarget.value,
                        },
                      })
                    }
                    placeholder={t('Optional guidance for this category')}
                  />
                )}
              </View>
            );
          })}
          <Button isDisabled={!canSaveSettings} onPress={saveSettings}>
            <Trans>Save categorization settings</Trans>
          </Button>
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
          category names and guidance, and your custom instruction to OpenAI to
          generate suggestions. No OpenAI API key, Actual transaction IDs,
          notes, attachments, balances, budget name, or unselected transactions
          are sent. OpenAI requests use no provider-side response storage.
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
  );
}
