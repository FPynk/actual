import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { loadPrefs, savePrefs } from '#server/prefs';

describe('preferences/save budget fence', () => {
  beforeEach(async () => {
    await global.emptyDatabase()();
    await loadPrefs();
    await savePrefs({ id: 'budget-a' }, { avoidSync: true });
    await db.update('preferences', {
      id: 'finance.openai-categorization',
      value: 'original-settings',
    });
  });

  it('does not mutate the active budget when the expected budget differs', async () => {
    const result = await runHandler(handlers['preferences/save'], {
      expectedBudgetId: 'budget-b',
      id: 'finance.openai-categorization',
      value: 'wrong-budget-settings',
    });

    expect(result).toEqual({ saved: false });
    expect(
      await db.first<{ value: string }>(
        'SELECT value FROM preferences WHERE id = ?',
        ['finance.openai-categorization'],
      ),
    ).toEqual({ value: 'original-settings' });
  });

  it('saves when the expected budget is still active', async () => {
    const result = await runHandler(handlers['preferences/save'], {
      expectedBudgetId: 'budget-a',
      id: 'finance.openai-categorization',
      value: 'updated-settings',
    });

    expect(result).toEqual({ saved: true });
    expect(
      await db.first<{ value: string }>(
        'SELECT value FROM preferences WHERE id = ?',
        ['finance.openai-categorization'],
      ),
    ).toEqual({ value: 'updated-settings' });
  });
});
