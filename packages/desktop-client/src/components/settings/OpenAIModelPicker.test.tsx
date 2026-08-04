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
  it('shows the current draft model while closed, even while models load', () => {
    render(
      <OpenAIModelPicker
        loadModels={() => new Promise<never>(() => undefined)}
        onChange={vi.fn()}
        value="gpt-draft-model"
      />,
      { wrapper: TestProviders },
    );

    const picker = screen.getByRole('combobox', { name: 'Model' });
    expect(picker).toHaveAttribute('aria-expanded', 'false');
    expect(picker).toHaveValue('gpt-draft-model');
  });

  it('uses a clear placeholder when no model is selected', () => {
    render(
      <OpenAIModelPicker
        loadModels={() => new Promise<never>(() => undefined)}
        onChange={vi.fn()}
        value=""
      />,
      { wrapper: TestProviders },
    );

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveAttribute(
      'placeholder',
      'Choose a model',
    );
  });

  it('shows a compact status for a recommended saved model', async () => {
    renderPicker({ value: 'gpt-5.6-terra' });

    expect(await screen.findByText('Recommended')).toHaveAttribute(
      'id',
      'openai-model-status',
    );
  });

  it('shows an incompatible saved model status', async () => {
    renderPicker({ value: 'unknown-model' });

    expect(await screen.findByText('Incompatible')).toHaveAttribute(
      'id',
      'openai-model-status',
    );
  });

  it('keeps the current draft model visible when the provider is unavailable', async () => {
    render(
      <OpenAIModelPicker
        isUnavailable
        loadModels={vi.fn()}
        onChange={vi.fn()}
        value="gpt-draft-model"
      />,
      { wrapper: TestProviders },
    );

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue(
      'gpt-draft-model',
    );
    expect(
      await screen.findByText(
        'OpenAI model selection is unavailable while the server is offline.',
      ),
    ).toHaveAttribute('role', 'alert');
  });

  it('ignores an older model response after the provider becomes unavailable', async () => {
    let resolveModels:
      | ((result: { models: FinanceCategorizationModel[] }) => void)
      | undefined;
    const pendingModels = new Promise<{
      models: FinanceCategorizationModel[];
    }>(resolve => {
      resolveModels = resolve;
    });
    const loadModels = vi.fn(() => pendingModels);
    const { rerender } = render(
      <OpenAIModelPicker
        loadModels={loadModels}
        onChange={vi.fn()}
        value="gpt-5.6-terra"
      />,
      { wrapper: TestProviders },
    );
    await waitFor(() => expect(loadModels).toHaveBeenCalledTimes(1));

    rerender(
      <OpenAIModelPicker
        isUnavailable
        loadModels={loadModels}
        onChange={vi.fn()}
        value="gpt-5.6-terra"
      />,
    );
    expect(
      await screen.findByText(
        'OpenAI model selection is unavailable while the server is offline.',
      ),
    ).toHaveAttribute('role', 'alert');

    resolveModels?.({ models });
    await Promise.resolve();

    expect(
      screen.getByText(
        'OpenAI model selection is unavailable while the server is offline.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Recommended')).toBeNull();
  });

  it('groups recommended, compatible, and incompatible models', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
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
      name: 'Model',
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
      name: 'Model',
    });
    await user.type(search, '4.1');

    screen.getByRole('option', { name: /gpt-4.1-mini/i });
    expect(screen.queryByRole('option', { name: /gpt-5.6-terra/i })).toBeNull();
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('gpt-4.1-mini');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('restores the current draft model without changing focus when Escape closes the picker', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: 'gpt-5.6-luna' });
    const search = await screen.findByRole('combobox', {
      name: 'Model',
    });

    await user.click(search);
    await screen.findByRole('listbox');
    await user.type(search, '4.1');
    await user.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(search).toHaveFocus();
    expect(search).toHaveValue('gpt-5.6-luna');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('scrolls the selected model row into view when opening the picker', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderPicker({ value: 'gpt-4.1-mini' });
      await user.click(screen.getByRole('combobox', { name: 'Model' }));

      const selectedModel = await screen.findByRole('option', {
        name: /gpt-4.1-mini/i,
      });
      await waitFor(() =>
        expect(scrollIntoView.mock.contexts).toContain(selectedModel),
      );
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          'scrollIntoView',
          originalScrollIntoView,
        );
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    }
  });

  it('refreshes the provider-backed list on demand', async () => {
    const user = userEvent.setup();
    const { loadModels } = renderPicker();

    await user.click(screen.getByRole('combobox', { name: 'Model' }));
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

    expect(await screen.findByText('Unavailable')).toHaveAttribute(
      'id',
      'openai-model-status',
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
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
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue(
      'gpt-5.6-luna',
    );
    expect(screen.queryByText(/gpt-5.6-luna.*Unavailable/i)).toBeNull();
  });
});

