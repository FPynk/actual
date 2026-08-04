import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mocks.send,
}));

describe('saveSyncedPrefs', () => {
  it('does not merge a completed save into a different budget', async () => {
    vi.resetModules();
    const { createTestAppStore } = await import('#mocks');
    const { saveSyncedPrefs, setPrefs } = await import('./prefsSlice');
    let resolveSave: (() => void) | undefined;
    mocks.send.mockReturnValue(
      new Promise<void>(resolve => {
        resolveSave = resolve;
      }),
    );
    const store = createTestAppStore();
    store.dispatch(
      setPrefs({ local: { id: 'budget-a' }, global: {}, synced: {} }),
    );
    expect(store.getState().prefs.local.id).toBe('budget-a');

    const save = store.dispatch(
      saveSyncedPrefs({
        expectedBudgetId: 'budget-a',
        prefs: { 'finance.openai-categorization': 'settings-for-budget-a' },
      }),
    );

    await vi.waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith('preferences/save', {
        expectedBudgetId: 'budget-a',
        id: 'finance.openai-categorization',
        value: 'settings-for-budget-a',
      });
    });

    store.dispatch(
      setPrefs({ local: { id: 'budget-b' }, global: {}, synced: {} }),
    );
    resolveSave?.();

    expect(await save).toMatchObject({ payload: { saved: false } });
    expect(
      store.getState().prefs.synced['finance.openai-categorization'],
    ).toBeUndefined();
  });
});
