import {
  getFinanceMetadata,
  loadPrefs,
  saveFinanceMetadata,
  unloadPrefs,
} from './prefs';

afterEach(() => {
  unloadPrefs();
});

describe('native finance metadata preferences', () => {
  test('keeps reviewed-finance metadata in Actual budget preferences', async () => {
    await loadPrefs();
    await saveFinanceMetadata({
      reviewDecisions: [
        {
          candidateKey: 'reconciliation:duplicate-1',
          decision: 'keep-both',
          feature: 'reconciliation',
          updatedAt: '2026-08-01T12:00:00.000Z',
        },
      ],
      version: 1,
    });

    expect(getFinanceMetadata()).toEqual({
      reviewDecisions: [
        {
          candidateKey: 'reconciliation:duplicate-1',
          decision: 'keep-both',
          feature: 'reconciliation',
          updatedAt: '2026-08-01T12:00:00.000Z',
        },
      ],
      version: 1,
    });
  });
});
