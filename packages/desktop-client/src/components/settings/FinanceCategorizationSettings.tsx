import React, { useEffect, useMemo, useState } from 'react';
import { Trans } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  defaultFinanceCategorizationSettings,
  defaultOpenAiCategorizationModel,
  type FinanceCategorizationSettings,
} from '@actual-app/core/types/finance';
import { send } from '@actual-app/core/platform/client/connection';

import { Checkbox, FormField, FormLabel } from '#components/forms';
import { useCategories } from '#hooks/useCategories';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { Setting } from './UI';

function parseSettings(value: string | undefined): FinanceCategorizationSettings {
  if (!value) return defaultFinanceCategorizationSettings;
  try {
    const parsed = JSON.parse(value);
    return {
      categoryGuidance:
        parsed.categoryGuidance && typeof parsed.categoryGuidance === 'object'
          ? parsed.categoryGuidance
          : {},
      categoryIds: Array.isArray(parsed.categoryIds) ? parsed.categoryIds : [],
      masterPrompt:
        typeof parsed.masterPrompt === 'string' ? parsed.masterPrompt : '',
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
  const [serializedSettings, setSerializedSettings] = useSyncedPref(
    'finance.openai-categorization',
  );
  const settings = useMemo(
    () => parseSettings(serializedSettings),
    [serializedSettings],
  );
  const { data: categoryData } = useCategories();
  const [apiKey, setApiKey] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [status, setStatus] = useState<'unknown' | 'configured' | 'missing'>(
    'unknown',
  );
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = async () => {
    const result = await send('finance-categorization-status');
    setStatus('configured' in result && result.configured ? 'configured' : 'missing');
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const saveSettings = () => {
    setIsSavingSettings(true);
    setSerializedSettings(JSON.stringify(settings));
    setIsSavingSettings(false);
  };

  const updateSettings = (next: FinanceCategorizationSettings) => {
    setSerializedSettings(JSON.stringify(next));
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
      setError(String(result.error));
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
      setError(String(result.error));
      return;
    }
    await refreshStatus();
  };

  const categories = categoryData?.list ?? [];
  const selectedCategoryIds = new Set(settings.categoryIds);

  return (
    <Setting
      primaryAction={
        <View style={{ alignItems: 'flex-start', gap: 12, width: '100%' }}>
          <FormField style={{ width: '100%' }}>
            <FormLabel title="OpenAI API key" />
            <Input
              type="password"
              value={apiKey}
              onChange={event => setApiKey(event.currentTarget.value)}
              placeholder="sk-..."
            />
          </FormField>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <ButtonWithLoading isLoading={isSavingKey} onPress={saveApiKey}>
              <Trans>Save API key</Trans>
            </ButtonWithLoading>
            <Button isDisabled={isSavingKey || status !== 'configured'} onPress={removeApiKey}>
              <Trans>Remove key</Trans>
            </Button>
          </View>
          <Text style={{ color: status === 'configured' ? theme.noticeText : theme.warningText }}>
            {status === 'configured' ? (
              <Trans>OpenAI API key is configured for this budget.</Trans>
            ) : (
              <Trans>No OpenAI API key is configured for this budget.</Trans>
            )}
          </Text>
          {error && <Text style={{ color: theme.errorText }}>{error}</Text>}

          <FormField style={{ width: '100%' }}>
            <FormLabel title="Model" />
            <Input
              value={settings.model}
              onChange={event =>
                updateSettings({ ...settings, model: event.currentTarget.value })
              }
            />
          </FormField>
          <FormField style={{ width: '100%' }}>
            <FormLabel title="Categorization instructions" />
            <Input
              value={settings.masterPrompt}
              onChange={event =>
                updateSettings({
                  ...settings,
                  masterPrompt: event.currentTarget.value,
                })
              }
              placeholder="Explain how to classify your spending"
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
                        ? [...settings.categoryIds, category.id]
                        : settings.categoryIds.filter(id => id !== category.id);
                      updateSettings({ ...settings, categoryIds });
                    }}
                  />
                  <label htmlFor={`finance-category-${category.id}`}>
                    {category.name}
                  </label>
                </Text>
                {selected && (
                  <Input
                    value={settings.categoryGuidance[category.id] || ''}
                    onChange={event =>
                      updateSettings({
                        ...settings,
                        categoryGuidance: {
                          ...settings.categoryGuidance,
                          [category.id]: event.currentTarget.value,
                        },
                      })
                    }
                    placeholder="Optional guidance for this category"
                  />
                )}
              </View>
            );
          })}
          <ButtonWithLoading isLoading={isSavingSettings} onPress={saveSettings}>
            <Trans>Save categorization settings</Trans>
          </ButtonWithLoading>
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>AI transaction categorization</strong> sends selected transaction descriptions, amounts, dates, payees, accounts, notes, and your category instructions to OpenAI when you run categorization. Your API key is stored only on your Actual server and is never sent back to this app. OpenAI requests use no provider-side storage.
        </Trans>
      </Text>
    </Setting>
  );
}
