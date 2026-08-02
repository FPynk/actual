import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseSuggestions,
  requestOpenAiCategorization,
  validateCategorizationRequest,
} from './app-finance';

const request = {
  model: 'gpt-5.6-luna',
  masterPrompt: 'Use the closest category.',
  categories: [{ id: 'groceries', name: 'Groceries' }],
  transactions: [
    {
      id: 'transaction-1',
      description: 'Market',
      amount: -2499,
      date: '2026-08-02',
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI finance categorization', () => {
  it('rejects malformed categorization input before calling a provider', () => {
    expect(validateCategorizationRequest({ ...request, categories: [] })).toBeNull();
    expect(
      validateCategorizationRequest({
        ...request,
        transactions: [{ ...request.transactions[0], amount: '2499' }],
      }),
    ).toBeNull();
  });

  it('uses a non-stored strict structured Responses request', async () => {
    const parsedRequest = validateCategorizationRequest(request);
    if (!parsedRequest) throw new Error('Expected valid request');
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            suggestions: [
              {
                transactionId: 'transaction-1',
                categoryId: 'groceries',
                confidence: 0.94,
                reason: 'Grocery merchant',
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      requestOpenAiCategorization('not-a-real-key', parsedRequest),
    ).resolves.toEqual({
      suggestions: [
        {
          transactionId: 'transaction-1',
          categoryId: 'groceries',
          confidence: 0.94,
          reason: 'Grocery merchant',
        },
      ],
    });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer not-a-real-key');
    expect(JSON.parse(options.body)).toMatchObject({
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
  });

  it('does not accept categories invented by a provider response', () => {
    expect(
      parseSuggestions(
        {
          output_text: JSON.stringify({
            suggestions: [
              {
                transactionId: 'transaction-1',
                categoryId: 'invented-category',
                confidence: 0.8,
                reason: 'Nope',
              },
            ],
          }),
        },
        new Set(['transaction-1']),
        new Set(['groceries']),
      ),
    ).toBeNull();
  });
});
