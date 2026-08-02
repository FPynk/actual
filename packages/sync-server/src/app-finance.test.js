import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractResponseOutput,
  getConfiguredOpenAiKey,
  handlers,
  parseProposals,
  requestOpenAiCategorization,
  validateCategorizationRequest,
} from './app-finance';
import { SecretName, secretsService } from './services/secrets-service';

const request = {
  model: 'gpt-5.6-luna',
  categorization_instruction: 'Use the closest category.',
  categories: [{ category_id: 'category-1', name: 'Groceries' }],
  candidates: [
    {
      candidate_id: 'candidate-1',
      description: 'Market',
      amount: '-24.99',
      currency: 'USD',
      date: '2026-08-02',
    },
  ],
};
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOpenAiApiKey == null) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  secretsService.reset(SecretName.openai_apiKey);
  secretsService.reset(SecretName.openai_apiKey, 'budget-file');
  secretsService.reset(SecretName.openai_apiKey, 'test-file-id');
});

describe('OpenAI finance categorization', () => {
  it('requires an authenticated Actual session', async () => {
    const response = await supertest(handlers)
      .get('/status')
      .set('X-Actual-File-Id', 'test-file-id');

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({
      status: 'error',
      reason: 'unauthorized',
    });
  });

  it('reports budget key status without returning any key material', async () => {
    secretsService.set(
      SecretName.openai_apiKey,
      'budget-test-key',
      'test-file-id',
    );

    const response = await supertest(handlers)
      .get('/status')
      .set('X-Actual-File-Id', 'test-file-id')
      .set('x-actual-token', 'valid-token');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      data: { configured: true, source: 'budget' },
    });
    expect(JSON.stringify(response.body)).not.toContain('budget-test-key');
  });

  it('uses environment, budget, then global key precedence without returning a key', () => {
    secretsService.set(SecretName.openai_apiKey, 'global-test-key');
    secretsService.set(
      SecretName.openai_apiKey,
      'budget-test-key',
      'budget-file',
    );

    expect(getConfiguredOpenAiKey('budget-file')).toEqual({
      key: 'budget-test-key',
      source: 'budget',
    });
    process.env.OPENAI_API_KEY = 'environment-test-key';
    expect(getConfiguredOpenAiKey('budget-file')).toEqual({
      key: 'environment-test-key',
      source: 'environment',
    });
  });

  it('rejects malformed categorization input before calling a provider', () => {
    expect(
      validateCategorizationRequest({ ...request, categories: [] }),
    ).toBeNull();
    expect(
      validateCategorizationRequest({ ...request, model: ' ' }),
    ).toBeNull();
    expect(
      validateCategorizationRequest({
        ...request,
        categorization_instruction: '',
      }),
    ).toBeNull();
    expect(
      validateCategorizationRequest({
        ...request,
        candidates: [{ ...request.candidates[0], amount: -2499 }],
      }),
    ).toBeNull();
    expect(
      validateCategorizationRequest({
        ...request,
        candidates: [
          { ...request.candidates[0], notes: 'must not leave Actual' },
        ],
      }),
    ).toBeNull();
  });

  it('uses a non-stored strict structured Responses request', async () => {
    const parsedRequest = validateCategorizationRequest(request);
    if (!parsedRequest) throw new Error('Expected valid request');
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output_text: JSON.stringify({
            proposals: [
              {
                candidate_id: 'candidate-1',
                category_id: 'category-1',
                confidence: 'high',
                explanation: 'Grocery merchant',
              },
            ],
          }),
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      requestOpenAiCategorization('not-a-real-key', parsedRequest),
    ).resolves.toEqual({
      proposals: [
        {
          candidate_id: 'candidate-1',
          category_id: 'category-1',
          confidence: 'high',
          explanation: 'Grocery merchant',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
      },
    });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer not-a-real-key');
    expect(JSON.parse(options.body)).toMatchObject({
      store: false,
      text: {
        format: {
          name: 'transaction_category_proposals',
          type: 'json_schema',
          strict: true,
        },
      },
    });
    expect(options.body).not.toContain('notes');
  });

  it('does not accept categories invented by a provider response', () => {
    expect(
      parseProposals(
        {
          status: 'completed',
          output_text: JSON.stringify({
            proposals: [
              {
                candidate_id: 'candidate-1',
                category_id: 'invented-category',
                confidence: 'high',
                explanation: 'Nope',
              },
            ],
          }),
        },
        new Set(['candidate-1']),
        new Set(['category-1']),
      ),
    ).toEqual({ error: 'invalid-provider-response' });
  });

  it('requires exactly one proposal for every candidate', () => {
    expect(
      parseProposals(
        {
          status: 'completed',
          output_text: JSON.stringify({
            proposals: [
              {
                candidate_id: 'candidate-1',
                category_id: null,
                confidence: 'low',
                explanation: 'Insufficient detail',
              },
            ],
          }),
        },
        new Set(['candidate-1', 'candidate-2']),
        new Set(['category-1']),
      ),
    ).toEqual({ error: 'invalid-provider-response' });
  });

  it('rejects incomplete and refused Responses before parsing output text', () => {
    expect(
      extractResponseOutput({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ).toEqual({ error: 'provider-incomplete' });
    expect(
      extractResponseOutput({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'not returned to caller' }],
          },
        ],
      }),
    ).toEqual({ error: 'provider-refused' });
  });

  it('honors Retry-After before retrying a rate-limited request', async () => {
    const parsedRequest = validateCategorizationRequest(request);
    if (!parsedRequest) throw new Error('Expected valid request');
    const successfulResponse = new Response(
      JSON.stringify({
        status: 'completed',
        output_text: JSON.stringify({
          proposals: [
            {
              candidate_id: 'candidate-1',
              category_id: null,
              confidence: 'low',
              explanation: 'Insufficient detail',
            },
          ],
        }),
      }),
      { status: 200 },
    );
    const fetchFunction = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '2' },
        }),
      )
      .mockResolvedValueOnce(successfulResponse);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      requestOpenAiCategorization('not-a-real-key', parsedRequest, {
        fetchFunction,
        sleep,
      }),
    ).resolves.toMatchObject({
      proposals: [{ candidate_id: 'candidate-1', category_id: null }],
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchFunction).toHaveBeenCalledTimes(2);
  });
});
