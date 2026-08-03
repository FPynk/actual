import { isValidElement } from 'react';
import type { ReactNode } from 'react';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { FinanceCategorizationSettings } from './FinanceCategorizationSettings';

let saveSettingsPromise: Promise<void>;
let resolveSaveSettings: (() => void) | undefined;
let rejectSaveSettings: ((error: Error) => void) | undefined;

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  send: vi.fn(),
  state: {
    serializedSettings: undefined as string | undefined,
    serverStatus: 'offline' as 'offline' | 'online',
  },
}));

function mockTransChildren(children: ReactNode): ReactNode {
  if (Array.isArray(children)) {
    return children.map(mockTransChildren);
  }
  if (
    children !== null &&
    typeof children === 'object' &&
    !isValidElement(children)
  ) {
    return null;
  }
  return children;
}

vi.mock('react-i18next', () => ({
  Trans: ({ children }: { children: ReactNode }) => (
    <>{mockTransChildren(children)}</>
  ),
  useTranslation: () => ({
    t: (value: string, options?: { categoryName?: string }) =>
      value.replace('{{categoryName}}', options?.categoryName ?? ''),
  }),
}));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mocks.send,
}));

vi.mock('#hooks/useCategories', () => ({
  useCategories: () => ({
    data: {
      list: [
        { id: 'groceries', name: 'Groceries', is_income: false },
        { id: 'rent', name: 'Rent', is_income: false },
        { id: 'income', name: 'Income', is_income: true },
        { id: 'hidden', name: 'Hidden', hidden: true },
        {
          id: 'hidden-group-visible',
          name: 'Hidden group visible',
          is_income: false,
        },
      ],
      grouped: [
        {
          id: 'expenses',
          name: 'Expenses',
          categories: [
            { id: 'groceries', name: 'Groceries', is_income: false },
            { id: 'rent', name: 'Rent', is_income: false },
            { id: 'hidden', name: 'Hidden', hidden: true },
          ],
        },
        {
          id: 'hidden-group',
          name: 'Hidden group',
          hidden: true,
          categories: [
            {
              id: 'hidden-group-visible',
              name: 'Hidden group visible',
              is_income: false,
            },
          ],
        },
        {
          id: 'income-group',
          name: 'Income',
          is_income: true,
          categories: [{ id: 'income', name: 'Income', is_income: true }],
        },
      ],
    },
  }),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: () => [mocks.state.serializedSettings],
}));

vi.mock('#hooks/useSyncServerStatus', () => ({
  useSyncServerStatus: () => mocks.state.serverStatus,
}));

vi.mock('#prefs/prefsSlice', () => ({
  saveSyncedPrefs: vi.fn(value => value),
}));

vi.mock('#redux', () => ({ useDispatch: () => mocks.dispatch }));

function createPendingSave() {
  saveSettingsPromise = new Promise<void>((resolve, reject) => {
    resolveSaveSettings = resolve;
    rejectSaveSettings = reject;
  });
}

describe('FinanceCategorizationSettings', () => {
  beforeEach(() => {
    mocks.state.serverStatus = 'offline';
    mocks.state.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries'],
      masterPrompt: 'Choose a category.',
      model: 'gpt-5.6-luna',
    });
    createPendingSave();
    mocks.dispatch.mockReset();
    mocks.dispatch.mockReturnValue({ unwrap: () => saveSettingsPromise });
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ configured: false, source: 'none' });
  });

  it('selects every eligible category and persists individual deselection', async () => {
    const user = userEvent.setup();
    render(<FinanceCategorizationSettings />);

    await user.click(screen.getByRole('button', { name: 'Select all' }));

    expect(screen.getByRole('checkbox', { name: 'Groceries' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rent' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Income' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Hidden' })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: 'Hidden group visible' }),
    ).toBeNull();
    expect(screen.getByText('Expenses')).toBeVisible();
    expect(screen.getAllByText('Income')).toHaveLength(2);
    expect(
      screen.getAllByText(
        'Keep guidance short and specific. Longer guidance increases API cost and may reduce classification consistency.',
      ),
    ).toHaveLength(1);

    await user.click(screen.getByRole('checkbox', { name: 'Rent' }));
    expect(screen.getByRole('checkbox', { name: 'Rent' })).not.toBeChecked();

    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );

    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        prefs: {
          'finance.openai-categorization': expect.stringContaining(
            '"categoryIds":["groceries","income"]',
          ),
        },
      }),
    );
  });

  it('keeps expanded guidance bound to the unsaved inline draft', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FinanceCategorizationSettings />);

    await user.click(
      screen.getByRole('button', { name: 'Expand guidance for Groceries' }),
    );

    const dialog = screen.getByRole('dialog', {
      name: 'Guidance for Groceries',
    });
    expect(
      screen.getAllByText(
        'Keep guidance short and specific. Longer guidance increases API cost and may reduce classification consistency.',
      ),
    ).toHaveLength(1);
    expect(
      within(dialog).queryByText(
        'Keep guidance short and specific. Longer guidance increases API cost and may reduce classification consistency.',
      ),
    ).toBeNull();
    const expandedGuidance = within(dialog).getByRole('textbox');
    await user.type(
      expandedGuidance,
      'Use for supermarket purchases.\nInclude pantry staples.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
    ).toHaveValue('Use for supermarket purchases.\nInclude pantry staples.');

    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );
    const savedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];
    expect(savedSettings).toContain(
      'Use for supermarket purchases.\\nInclude pantry staples.',
    );

    mocks.state.serializedSettings = savedSettings;
    act(() => resolveSaveSettings?.());
    await screen.findByRole('status');
    unmount();
    render(<FinanceCategorizationSettings />);

    expect(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
    ).toHaveValue('Use for supermarket purchases.\nInclude pantry staples.');
  });

  it('closes the expanded guidance dialog with Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<FinanceCategorizationSettings />);

    const expandButton = screen.getByRole('button', {
      name: 'Expand guidance for Groceries',
    });
    await user.click(expandButton);
    expect(
      screen.getByRole('dialog', { name: 'Guidance for Groceries' }),
    ).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Guidance for Groceries' }),
      ).toBeNull();
    });
    expect(expandButton).toHaveFocus();
  });

  it('expands and exactly persists multiline categorization instructions', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FinanceCategorizationSettings />);
    const categorizationInstructions = screen.getByRole('textbox', {
      name: 'Categorization instructions',
    });
    const multilineInstructions =
      '\nFirst paragraph.\n\nSecond paragraph with more detail.\n';

    expect(categorizationInstructions.tagName).toBe('TEXTAREA');
    await user.clear(categorizationInstructions);
    await user.type(categorizationInstructions, multilineInstructions);

    const expandButton = screen.getByRole('button', {
      name: 'Expand categorization instructions',
    });
    await user.click(expandButton);
    const dialog = screen.getByRole('dialog', {
      name: 'Categorization instructions',
    });
    expect(within(dialog).getByRole('textbox')).toHaveValue(
      multilineInstructions,
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(expandButton).toHaveFocus());
    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );

    const savedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];
    expect(JSON.parse(savedSettings).masterPrompt).toBe(multilineInstructions);

    mocks.state.serializedSettings = savedSettings;
    act(() => resolveSaveSettings?.());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Settings saved',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
      'Edited after save',
    );
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
    render(<FinanceCategorizationSettings />);
    expect(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
    ).toHaveValue(multilineInstructions);
  });

  it('shows Settings saved only after persistence succeeds and clears it on edits', async () => {
    const user = userEvent.setup();
    render(<FinanceCategorizationSettings />);

    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );
    expect(screen.queryByRole('status')).toBeNull();

    act(() => resolveSaveSettings?.());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Settings saved',
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
      'Food only',
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not show Settings saved when persistence fails', async () => {
    const user = userEvent.setup();
    render(<FinanceCategorizationSettings />);

    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );
    act(() => rejectSaveSettings?.(new Error('save failed')));

    await waitFor(() => {
      expect(
        screen.getByText('Unable to save categorization settings.'),
      ).toHaveAttribute('role', 'alert');
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps newer edits while a save is pending and serializes repeated saves', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FinanceCategorizationSettings />);
    const guidance = screen.getByRole('textbox', {
      name: 'Guidance for Groceries',
    });

    await user.type(guidance, 'First draft');
    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );
    const firstSavedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];

    await user.clear(guidance);
    await user.type(guidance, 'Newer draft');
    expect(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    ).toBeDisabled();

    mocks.state.serializedSettings = firstSavedSettings;
    rerender(<FinanceCategorizationSettings />);
    expect(guidance).toHaveValue('Newer draft');

    act(() => resolveSaveSettings?.());
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Save categorization settings' }),
      ).toBeEnabled();
    });
    expect(screen.queryByRole('status')).toBeNull();

    createPendingSave();
    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(
      mocks.dispatch.mock.calls[1][0].prefs['finance.openai-categorization'],
    ).toContain('Newer draft');

    act(() => resolveSaveSettings?.());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Settings saved',
    );
  });

  it('persists a compatible model chosen from the provider-backed picker', async () => {
    const user = userEvent.setup();
    mocks.state.serverStatus = 'online';
    mocks.send.mockImplementation(async name => {
      if (name === 'finance-categorization-status') {
        return { configured: true, source: 'budget' };
      }
      if (name === 'finance-categorization-models') {
        return {
          models: [
            {
              compatibility: 'compatible',
              id: 'gpt-5.6-luna',
              isRecommended: true,
              reason: null,
            },
            {
              compatibility: 'compatible',
              id: 'gpt-4.1-mini',
              isRecommended: false,
              reason: null,
            },
          ],
        };
      }
      return { error: 'unexpected-request' };
    });
    render(<FinanceCategorizationSettings />);

    await screen.findByText('An OpenAI API key is configured for this budget.');
    const search = screen.getByRole('combobox', {
      name: 'Search OpenAI models',
    });
    await user.click(search);
    const selectedOption = await screen.findByRole('option', {
      name: 'gpt-4.1-mini',
    });
    await user.click(within(selectedOption).getByRole('button'));
    await user.click(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    );

    expect(
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'],
    ).toContain('"model":"gpt-4.1-mini"');
    act(() => resolveSaveSettings?.());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Settings saved',
    );
  });

  it('does not save a model that the compatibility policy rejects', async () => {
    mocks.state.serverStatus = 'online';
    mocks.state.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries'],
      masterPrompt: 'Choose a category.',
      model: 'whisper-1',
    });
    mocks.send.mockImplementation(async name => {
      if (name === 'finance-categorization-status') {
        return { configured: true, source: 'budget' };
      }
      if (name === 'finance-categorization-models') {
        return {
          models: [
            {
              compatibility: 'incompatible',
              id: 'whisper-1',
              isRecommended: false,
              reason: 'Not a text categorization model.',
            },
          ],
        };
      }
      return { error: 'unexpected-request' };
    });
    render(<FinanceCategorizationSettings />);

    expect(
      await screen.findByText(
        'Choose a compatible OpenAI model before saving.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(
      screen.getByRole('button', { name: 'Save categorization settings' }),
    ).toBeDisabled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
