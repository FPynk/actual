import { isValidElement } from 'react';
import type { ReactNode } from 'react';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { FinanceCategorizationSettings } from './FinanceCategorizationSettings';

type PendingSave = {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
};

let pendingSaves: PendingSave[];

function createCategoryData() {
  return {
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
  };
}

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  send: vi.fn(),
  state: {
    budgetId: 'budget-a',
    categoryData: undefined as
      | ReturnType<typeof createCategoryData>
      | undefined,
    serializedSettings: undefined as string | undefined,
    serverStatus: 'online' as 'offline' | 'online',
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

vi.mock('react-i18next', () => {
  const t = (value: string, options?: { categoryName?: string }) =>
    value.replace('{{categoryName}}', options?.categoryName ?? '');
  return {
    Trans: ({ children }: { children: ReactNode }) => (
      <>{mockTransChildren(children)}</>
    ),
    useTranslation: () => ({ t }),
  };
});

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mocks.send,
}));

vi.mock('#hooks/useCategories', () => ({
  useCategories: () => ({
    data: mocks.state.categoryData,
  }),
}));

vi.mock('#hooks/useMetadataPref', () => ({
  useMetadataPref: () => [mocks.state.budgetId],
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

function createPendingSave(): PendingSave {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    reject: error => reject?.(error),
    resolve: () => resolve?.(),
  };
}

async function advanceAutosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

async function settleSave(save: PendingSave, outcome: 'resolve' | 'reject') {
  await act(async () => {
    if (outcome === 'resolve') {
      save.resolve();
    } else {
      save.reject(new Error('save failed'));
    }
    await Promise.resolve();
  });
}

async function waitForCompatibleSettings() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(
    screen.queryByText(
      'Changes are not saved until you choose at least one category and provide a compatible model and categorization instructions.',
    ),
  ).toBeNull();
}

describe('FinanceCategorizationSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mocks.state.budgetId = 'budget-a';
    mocks.state.categoryData = createCategoryData();
    mocks.state.serverStatus = 'online';
    mocks.state.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries'],
      masterPrompt: 'Choose a category.',
      model: 'gpt-5.6-luna',
    });
    pendingSaves = [];
    mocks.dispatch.mockReset();
    mocks.dispatch.mockImplementation(() => {
      const pendingSave = createPendingSave();
      pendingSaves.push(pendingSave);
      return { unwrap: () => pendingSave.promise };
    });
    mocks.send.mockReset();
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
          ],
        };
      }
      return { error: 'unexpected-request' };
    });
  });

  it('selects every eligible category and autosaves individual deselection', async () => {
    vi.useFakeTimers();
    render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

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

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rent' }));
    expect(screen.getByRole('checkbox', { name: 'Rent' })).not.toBeChecked();

    await advanceAutosave();

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

  it('keeps expanded guidance bound to the inline draft and flushes it on close', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

    fireEvent.click(
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
    fireEvent.change(expandedGuidance, {
      target: {
        value: 'Use for supermarket purchases.\nInclude pantry staples.',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
    ).toHaveValue('Use for supermarket purchases.\nInclude pantry staples.');

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const savedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];
    expect(savedSettings).toContain(
      'Use for supermarket purchases.\\nInclude pantry staples.',
    );

    mocks.state.serializedSettings = savedSettings;
    await settleSave(pendingSaves[0], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
    unmount();
    render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

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

  it('flushes blur and exactly persists multiline categorization instructions', async () => {
    vi.useFakeTimers();
    render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();
    const categorizationInstructions = screen.getByRole('textbox', {
      name: 'Categorization instructions',
    });
    const multilineInstructions =
      '\nFirst paragraph.\n\nSecond paragraph with more detail.\n';

    expect(categorizationInstructions.tagName).toBe('TEXTAREA');
    fireEvent.change(categorizationInstructions, {
      target: { value: multilineInstructions },
    });

    fireEvent.blur(categorizationInstructions);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    const savedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];
    expect(JSON.parse(savedSettings).masterPrompt).toBe(multilineInstructions);

    mocks.state.serializedSettings = savedSettings;
    await settleSave(pendingSaves[0], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
      { target: { value: 'Edited after save' } },
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('debounces saves, coalesces newer edits, and ignores its own preference echo', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();
    const guidance = screen.getByRole('textbox', {
      name: 'Guidance for Groceries',
    });

    fireEvent.change(guidance, { target: { value: 'First draft' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await advanceAutosave();
    const firstSavedSettings =
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'];
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');

    fireEvent.change(guidance, { target: { value: 'Newer draft' } });
    await advanceAutosave();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    mocks.state.serializedSettings = firstSavedSettings;
    rerender(<FinanceCategorizationSettings />);
    expect(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
    ).toHaveValue('Newer draft');

    await settleSave(pendingSaves[0], 'resolve');
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(
      mocks.dispatch.mock.calls[1][0].prefs['finance.openai-categorization'],
    ).toContain('Newer draft');
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');

    await settleSave(pendingSaves[1], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });

  it('fences an in-flight save from a newly opened budget', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
      { target: { value: 'Old budget draft' } },
    );
    await advanceAutosave();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0][0]).toEqual(
      expect.objectContaining({ expectedBudgetId: 'budget-a' }),
    );

    mocks.state.budgetId = 'budget-b';
    mocks.state.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries'],
      masterPrompt: 'New budget instructions.',
      model: 'gpt-5.6-luna',
    });
    rerender(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();
    expect(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
    ).toHaveValue('New budget instructions.');

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
      { target: { value: 'New budget draft' } },
    );
    await advanceAutosave();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);

    await settleSave(pendingSaves[0], 'resolve');
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        expectedBudgetId: 'budget-b',
        prefs: {
          'finance.openai-categorization':
            expect.stringContaining('New budget draft'),
        },
      }),
    );

    await settleSave(pendingSaves[1], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });

  it('waits for model compatibility before autosaving and retries when it becomes known', async () => {
    vi.useFakeTimers();
    let resolveModels:
      | ((value: {
          models: Array<{
            compatibility: 'compatible';
            id: string;
            isRecommended: boolean;
            reason: null;
          }>;
        }) => void)
      | undefined;
    const models = new Promise<{
      models: Array<{
        compatibility: 'compatible';
        id: string;
        isRecommended: boolean;
        reason: null;
      }>;
    }>(resolve => {
      resolveModels = resolve;
    });
    mocks.send.mockImplementation(async name => {
      if (name === 'finance-categorization-status') {
        return { configured: true, source: 'budget' };
      }
      if (name === 'finance-categorization-models') {
        return models;
      }
      return { error: 'unexpected-request' };
    });
    render(<FinanceCategorizationSettings />);

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
      { target: { value: 'Wait for a verified model.' } },
    );
    await advanceAutosave();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await act(async () => {
      resolveModels?.({
        models: [
          {
            compatibility: 'compatible',
            id: 'gpt-5.6-luna',
            isRecommended: true,
            reason: null,
          },
        ],
      });
      await Promise.resolve();
    });
    await waitForCompatibleSettings();
    await advanceAutosave();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'],
    ).toContain('Wait for a verified model.');
  });

  it('re-evaluates edits made while categories are loading', async () => {
    vi.useFakeTimers();
    mocks.state.categoryData = undefined;
    const { rerender } = render(<FinanceCategorizationSettings />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Recommended')).toBeVisible();

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
      { target: { value: 'Save after categories load.' } },
    );
    await advanceAutosave();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    mocks.state.categoryData = createCategoryData();
    rerender(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();
    await advanceAutosave();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'],
    ).toContain('Save after categories load.');
  });

  it('flushes a pending valid debounced edit when navigating away', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

    fireEvent.change(
      screen.getByRole('textbox', { name: 'Categorization instructions' }),
      { target: { value: 'Flush before unmount.' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();

    unmount();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        expectedBudgetId: 'budget-a',
        prefs: {
          'finance.openai-categorization': expect.stringContaining(
            'Flush before unmount.',
          ),
        },
      }),
    );
  });

  it('does not autosave invalid settings and retries the latest failed save', async () => {
    vi.useFakeTimers();
    render(<FinanceCategorizationSettings />);
    await waitForCompatibleSettings();

    const instructions = screen.getByRole('textbox', {
      name: 'Categorization instructions',
    });
    fireEvent.change(instructions, { target: { value: '' } });
    await advanceAutosave();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    fireEvent.change(instructions, {
      target: { value: 'Retry this setting.' },
    });
    await advanceAutosave();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await settleSave(pendingSaves[0], 'reject');

    expect(
      screen.getByText('Unable to save categorization settings.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(
      mocks.dispatch.mock.calls[1][0].prefs['finance.openai-categorization'],
    ).toContain('Retry this setting.');

    await settleSave(pendingSaves[1], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
  });

  it('persists a compatible model chosen from the provider-backed picker', async () => {
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
      name: 'Model',
    });
    fireEvent.focus(search);
    const selectedOption = await screen.findByRole('option', {
      name: 'gpt-4.1-mini',
    });
    fireEvent.click(within(selectedOption).getByRole('button'));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });

    expect(
      mocks.dispatch.mock.calls[0][0].prefs['finance.openai-categorization'],
    ).toContain('"model":"gpt-4.1-mini"');
    await settleSave(pendingSaves[0], 'resolve');
    expect(screen.getByRole('status')).toHaveTextContent('Settings saved');
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
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Guidance for Groceries' }),
      { target: { value: 'Do not save this invalid model.' } },
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
