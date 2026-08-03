import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAccountDb } from './account-db';
import {
  classifyOpenAiCategorizationModel,
  clearOpenAiModelListCache,
  extractResponseOutput,
  getConfiguredOpenAiKey,
  handlers,
  parseProposals,
  requestOpenAiCategorization,
  requestOpenAiCategorizationModels,
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
const ownerFileId = 'finance-owner-file';
const sharedFileId = 'finance-shared-file';
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  clearOpenAiModelListCache();
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
  getAccountDb().mutate('DELETE FROM user_access WHERE file_id IN (?, ?)', [
    ownerFileId,
    sharedFileId,
  ]);
  getAccountDb().mutate('DELETE FROM files WHERE id IN (?, ?)', [
    ownerFileId,
    sharedFileId,
  ]);
});

describe('OpenAI finance categorization', () => {
  it('lists official OpenAI-owned models and redacts provider metadata', async () => {
    secretsService.set(
      SecretName.openai_apiKey,
      'budget-model-list-key',
      'test-file-id',
    );
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              created: 123,
              id: 'gpt-5.6-luna',
              object: 'model',
              owned_by: 'openai',
            },
            {
              created: 456,
              id: 'gpt-5.6-sol',
              object: 'model',
              owned_by: 'openai',
            },
            {
              created: 789,
              id: 'gpt-experimental',
              object: 'model',
              owned_by: 'openai',
            },
            {
              created: 987,
              id: 'ft:gpt-5.6-luna:team:custom',
              object: 'model',
              owned_by: 'openai',
            },
            {
              created: 654,
              id: 'third-party-model',
              object: 'model',
              owned_by: 'other-provider',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', providerFetch);

    const response = await supertest(handlers)
      .get('/models')
      .set('X-Actual-File-Id', 'test-file-id')
      .set('x-actual-token', 'valid-token');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      data: {
        models: [
          {
            compatibility: 'compatible',
            id: 'gpt-5.6-sol',
            isRecommended: true,
            reason: null,
          },
          {
            compatibility: 'compatible',
            id: 'gpt-5.6-luna',
            isRecommended: true,
            reason: null,
          },
          {
            compatibility: 'incompatible',
            id: 'gpt-experimental',
            isRecommended: false,
            reason:
              'Model compatibility policy 1 has not verified this model for categorization.',
          },
        ],
      },
    });
    expect(JSON.stringify(response.body)).not.toContain(
      'budget-model-list-key',
    );
    expect(JSON.stringify(response.body)).not.toContain('owned_by');
    expect(JSON.stringify(response.body)).not.toContain('created');
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer budget-model-list-key' },
      }),
    );
  });

  it('uses a short model-list cache until the client forces a refresh', async () => {
    secretsService.set(
      SecretName.openai_apiKey,
      'budget-model-list-key',
      'test-file-id',
    );
    const providerFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-5.6-terra', object: 'model', owned_by: 'openai' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', providerFetch);

    const authenticatedRequest = () =>
      supertest(handlers)
        .get('/models')
        .set('X-Actual-File-Id', 'test-file-id')
        .set('x-actual-token', 'valid-token');

    expect((await authenticatedRequest()).statusCode).toBe(200);
    expect((await authenticatedRequest()).statusCode).toBe(200);
    secretsService.set(
      SecretName.openai_apiKey,
      'rotated-model-list-key',
      'test-file-id',
    );
    expect((await authenticatedRequest()).statusCode).toBe(200);
    expect(
      (
        await supertest(handlers)
          .get('/models?refresh=1')
          .set('X-Actual-File-Id', 'test-file-id')
          .set('x-actual-token', 'valid-token')
      ).statusCode,
    ).toBe(200);

    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it('fails malformed provider model metadata safely', async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 42, owned_by: 'openai' }] }), {
        status: 200,
      }),
    );

    await expect(
      requestOpenAiCategorizationModels('not-a-real-key', {
        fetchFunction: providerFetch,
      }),
    ).resolves.toEqual({ error: 'invalid-provider-response' });
    expect(classifyOpenAiCategorizationModel('unknown-model')).toEqual({
      compatibility: 'incompatible',
      id: 'unknown-model',
      isRecommended: false,
      reason:
        'Model compatibility policy 1 has not verified this model for categorization.',
    });
    expect(
      classifyOpenAiCategorizationModel('gpt-5.6-terra-2026-08-01'),
    ).toMatchObject({ compatibility: 'compatible', isRecommended: false });
    expect(
      classifyOpenAiCategorizationModel('gpt-4.1-mini-2025-04-14'),
    ).toMatchObject({ compatibility: 'compatible' });
    expect(classifyOpenAiCategorizationModel('gpt-5.4-mini')).toMatchObject({
      compatibility: 'compatible',
    });
    expect(
      classifyOpenAiCategorizationModel('gpt-5.5-pro-2026-08-01'),
    ).toMatchObject({ compatibility: 'compatible' });
    expect(
      classifyOpenAiCategorizationModel('gpt-5-chat-latest'),
    ).toMatchObject({ compatibility: 'compatible' });
    expect(
      classifyOpenAiCategorizationModel('gpt-5-chat-latest-2025-08-07'),
    ).toMatchObject({ compatibility: 'compatible' });
    expect(
      classifyOpenAiCategorizationModel('gpt-5.3-chat-latest'),
    ).toMatchObject({ compatibility: 'incompatible' });
    expect(classifyOpenAiCategorizationModel('gpt-5.3-codex')).toMatchObject({
      compatibility: 'incompatible',
    });
    expect(classifyOpenAiCategorizationModel('o3')).toMatchObject({
      compatibility: 'compatible',
    });
    expect(classifyOpenAiCategorizationModel('o4-deep-research')).toMatchObject(
      {
        compatibility: 'incompatible',
      },
    );
  });

  it('rejects duplicate model ids from the provider', async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-5.6-luna', owned_by: 'openai' },
            { id: 'gpt-5.6-luna', owned_by: 'openai' },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      requestOpenAiCategorizationModels('not-a-real-key', {
        fetchFunction: providerFetch,
      }),
    ).resolves.toEqual({ error: 'invalid-provider-response' });
  });

  it('requires an authenticated Actual session for model discovery', async () => {
    const response = await supertest(handlers)
      .get('/models')
      .set('X-Actual-File-Id', 'test-file-id');

    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({
      status: 'error',
      reason: 'unauthorized',
    });
  });

  it('rejects an incompatible categorization model before any provider call', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);

    const response = await supertest(handlers)
      .post('/categorize')
      .set('X-Actual-File-Id', 'test-file-id')
      .set('x-actual-token', 'valid-token')
      .send({ ...request, model: 'whisper-1' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      status: 'error',
      reason: 'incompatible-model',
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('maps provider model-list HTTP and parsing failures clearly', async () => {
    await expect(
      requestOpenAiCategorizationModels('not-a-real-key', {
        fetchFunction: vi
          .fn()
          .mockResolvedValue(new Response('', { status: 401 })),
      }),
    ).resolves.toEqual({ error: 'provider-authentication-failed' });
    await expect(
      requestOpenAiCategorizationModels('not-a-real-key', {
        fetchFunction: vi
          .fn()
          .mockResolvedValue(new Response('', { status: 503 })),
      }),
    ).resolves.toEqual({ error: 'provider-unavailable' });
    await expect(
      requestOpenAiCategorizationModels('not-a-real-key', {
        fetchFunction: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            throw abortError;
          },
        }),
      }),
    ).resolves.toEqual({ error: 'provider-timeout' });
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

  it('allows an owner but rejects a user with shared access', async () => {
    getAccountDb().mutate(
      'INSERT OR REPLACE INTO files (id, deleted, owner) VALUES (?, FALSE, ?)',
      [ownerFileId, 'genericUser'],
    );
    getAccountDb().mutate(
      'INSERT OR REPLACE INTO files (id, deleted, owner) VALUES (?, FALSE, ?)',
      [sharedFileId, 'genericAdmin'],
    );
    getAccountDb().mutate(
      'INSERT OR IGNORE INTO user_access (file_id, user_id) VALUES (?, ?)',
      [sharedFileId, 'genericUser'],
    );

    const ownerResponse = await supertest(handlers)
      .get('/status')
      .set('X-Actual-File-Id', ownerFileId)
      .set('x-actual-token', 'valid-token-user');
    const sharedUserResponse = await supertest(handlers)
      .get('/status')
      .set('X-Actual-File-Id', sharedFileId)
      .set('x-actual-token', 'valid-token-user');

    expect(ownerResponse.statusCode).toBe(200);
    expect(sharedUserResponse.statusCode).toBe(403);
    expect(sharedUserResponse.body).toEqual({
      status: 'error',
      reason: 'file-access-denied',
    });
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
    expect(
      validateCategorizationRequest({
        ...request,
        candidates: [{ ...request.candidates[0], transaction_id: 'actual-id' }],
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

  it('makes at most three attempts for transient provider failures', async () => {
    const parsedRequest = validateCategorizationRequest(request);
    if (!parsedRequest) throw new Error('Expected valid request');
    const fetchFunction = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      requestOpenAiCategorization('not-a-real-key', parsedRequest, {
        fetchFunction,
        sleep,
      }),
    ).resolves.toEqual({ error: 'provider-unavailable' });
    expect(fetchFunction).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
