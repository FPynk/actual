import type { ComponentProps } from 'react';

import type { FinanceCategorizationModel } from '@actual-app/core/types/finance';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { OpenAIModelPicker } from './OpenAIModelPicker';

const models: FinanceCategorizationModel[] = [
  {
    compatibility: 'compatible',
    id: 'gpt-4.1-mini',
    isRecommended: false,
    reason: null,
  },
  {
    compatibility: 'incompatible',
    id: 'unknown-model',
    isRecommended: false,
    reason: 'Not verified for categorization.',
  },
  {
    compatibility: 'compatible',
    id: 'gpt-5.6-terra',
    isRecommended: true,
    reason: null,
  },
];

function renderPicker(
  props: Partial<ComponentProps<typeof OpenAIModelPicker>> = {},
) {
  const onChange = vi.fn();
  const loadModels = vi.fn().mockResolvedValue({ models });
  render(
    <OpenAIModelPicker
      loadModels={loadModels}
      onChange={onChange}
      value="gpt-5.6-luna"
      {...props}
    />,
    { wrapper: TestProviders },
  );
  return { loadModels, onChange };
}

describe('OpenAIModelPicker', () => {
  it('groups recommended, compatible, and incompatible models', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(
      screen.getByRole('combobox', { name: 'Search OpenAI models' }),
    );
    await screen.findByRole('option', { name: /gpt-5.6-terra/i });

    expect(screen.getByRole('heading', { name: 'Recommended' })).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Other compatible models' }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Incompatible models' }),
    ).toBeVisible();
    expect(
      screen.getByRole('option', { name: /unknown-model/i }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps grouped variable-height options in a scrollable readable layout', async () => {
    const user = userEvent.setup();
    const longCompatibleModelId =
      'gpt-compatible-model-with-a-very-long-provider-generated-identifier';
    const longIncompatibleModelId =
      'gpt-incompatible-model-with-a-very-long-provider-generated-identifier';
    const longCompatibilityReason =
      'This model cannot accept the text categorization request shape required by this feature and should remain readable on multiple lines.';
    renderPicker({
      loadModels: async () => ({
        models: [
          models[2]!,
          {
            compatibility: 'compatible',
            id: longCompatibleModelId,
            isRecommended: false,
            reason: null,
          },
          {
            compatibility: 'incompatible',
            id: longIncompatibleModelId,
            isRecommended: false,
            reason: longCompatibilityReason,
          },
        ],
      }),
    });

    const search = screen.getByRole('combobox', {
      name: 'Search OpenAI models',
    });
    expect(search).toHaveStyle({ flex: '1 1 180px', minWidth: 0 });
    await user.click(search);

    const listbox = await screen.findByRole('listbox', {
      name: 'Available OpenAI models',
    });
    expect(listbox).toHaveStyle({
      maxHeight: 220,
      overflowY: 'auto',
      width: '100%',
    });

    for (const groupName of [
      'Recommended',
      'Other compatible models',
      'Incompatible models',
    ]) {
      expect(screen.getByRole('group', { name: groupName })).toHaveStyle({
        flexShrink: 0,
        width: '100%',
      });
    }

    const incompatibleOption = screen.getByRole('option', {
      name: new RegExp(longIncompatibleModelId, 'i'),
    });
    expect(incompatibleOption).toHaveStyle({
      flexShrink: 0,
      width: '100%',
    });
    expect(within(incompatibleOption).getByRole('button')).toHaveStyle({
      alignItems: 'stretch',
      whiteSpace: 'normal',
      width: '100%',
    });
    expect(
      within(incompatibleOption).getByText(longCompatibilityReason),
    ).toHaveStyle({ overflowWrap: 'anywhere', width: '100%' });
  });

  it('searches and selects a compatible model with the keyboard', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    const search = await screen.findByRole('combobox', {
      name: 'Search OpenAI models',
    });
    await user.type(search, '4.1');

    screen.getByRole('option', { name: /gpt-4.1-mini/i });
    expect(screen.queryByRole('option', { name: /gpt-5.6-terra/i })).toBeNull();
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('gpt-4.1-mini');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('refreshes the provider-backed list on demand', async () => {
    const user = userEvent.setup();
    const { loadModels } = renderPicker();

    await user.click(
      screen.getByRole('combobox', { name: 'Search OpenAI models' }),
    );
    await screen.findByRole('option', { name: /gpt-5.6-terra/i });
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));

    await waitFor(() => expect(loadModels).toHaveBeenCalledTimes(2));
    expect(loadModels).toHaveBeenNthCalledWith(1, false);
    expect(loadModels).toHaveBeenNthCalledWith(2, true);
  });

  it('keeps a saved unavailable model visible and unchanged', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <OpenAIModelPicker
        loadModels={async () => ({ models: [] })}
        onChange={onChange}
        value="gpt-legacy-saved"
      />,
      { wrapper: TestProviders },
    );

    await user.click(
      screen.getByRole('combobox', { name: 'Search OpenAI models' }),
    );
    const unavailableModel = await screen.findByRole('option', {
      name: /gpt-legacy-saved.*unavailable/i,
    });
    expect(unavailableModel).toHaveAttribute('aria-disabled', 'true');
    await user.click(unavailableModel);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('explains when an OpenAI API key is required', async () => {
    render(
      <OpenAIModelPicker
        loadModels={async () => ({ error: 'not-configured' })}
        onChange={vi.fn()}
        value="gpt-5.6-luna"
      />,
      { wrapper: TestProviders },
    );

    expect(
      await screen.findByText('Add an OpenAI API key before choosing a model.'),
    ).toHaveAttribute('role', 'alert');
  });

  it('does not claim the saved model is unavailable during a provider error', async () => {
    render(
      <OpenAIModelPicker
        loadModels={async () => ({ error: 'provider-unavailable' })}
        onChange={vi.fn()}
        value="gpt-5.6-luna"
      />,
      { wrapper: TestProviders },
    );

    expect(
      await screen.findByText(
        'OpenAI is unavailable. Try refreshing the model list.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/gpt-5.6-luna.*Unavailable/i)).toBeNull();
  });
});
