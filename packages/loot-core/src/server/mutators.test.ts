import { afterEach, describe, expect, it, vi } from 'vitest';

import { mutator, runHandler } from './mutators';

describe('runHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a running mutator before closing the budget', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    let finishMutation: (() => void) | undefined;
    const mutationCanFinish = new Promise<void>(resolve => {
      finishMutation = resolve;
    });
    const blockedMutation = mutator(async () => {
      events.push('mutation-started');
      await mutationCanFinish;
      events.push('mutation-finished');
    });
    const closeBudget = async () => {
      events.push('budget-closed');
    };

    const mutation = runHandler(blockedMutation, undefined, {
      name: 'blocked-mutation',
    });
    await Promise.resolve();
    const close = runHandler(closeBudget, undefined, { name: 'close-budget' });

    await vi.advanceTimersByTimeAsync(200);
    expect(events).toEqual(['mutation-started']);

    finishMutation?.();
    await mutation;
    await vi.advanceTimersByTimeAsync(100);
    await close;

    expect(events).toEqual([
      'mutation-started',
      'mutation-finished',
      'budget-closed',
    ]);
  });
});
