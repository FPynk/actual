import express from 'express';

import { isAdmin } from './account-db';
import { SecretName, secretsService } from './services/secrets-service';
import * as UserService from './services/user-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';
import { isValidFileId } from './util/paths';

const maxConcurrentRequests = 2;
const maxTransactionsPerRequest = 100;
const requestTimeoutMs = 30_000;
let activeRequests = 0;

const suggestionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['transactionId', 'categoryId', 'confidence', 'reason'],
        properties: {
          transactionId: { type: 'string' },
          categoryId: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
  },
};

function canAccessBudget(fileId, userId) {
  return (
    isAdmin(userId) ||
    (UserService.checkFilePermission(fileId, userId)?.granted ?? 0) > 0
  );
}

function getConfiguredOpenAiKey(fileId) {
  const environmentKey = process.env.OPENAI_API_KEY?.trim();
  if (environmentKey) return { key: environmentKey, source: 'environment' };

  const budgetKey = secretsService.get(SecretName.openai_apiKey, fileId);
  if (budgetKey) return { key: budgetKey, source: 'budget' };

  const globalKey = secretsService.get(SecretName.openai_apiKey);
  if (globalKey) return { key: globalKey, source: 'global' };

  return { key: null, source: 'none' };
}

function validString(value, maximumLength) {
  return typeof value === 'string' && value.length <= maximumLength;
}

function validateCategorizationRequest(value) {
  if (!value || typeof value !== 'object') return null;
  const { model, masterPrompt, categories, transactions } = value;
  if (
    !validString(model, 100) ||
    !validString(masterPrompt, 8_000) ||
    !Array.isArray(categories) ||
    !Array.isArray(transactions) ||
    categories.length === 0 ||
    categories.length > 200 ||
    transactions.length === 0 ||
    transactions.length > maxTransactionsPerRequest
  ) {
    return null;
  }

  const categoryIds = new Set();
  for (const category of categories) {
    if (
      !category ||
      !validString(category.id, 100) ||
      !validString(category.name, 200) ||
      (category.guidance != null && !validString(category.guidance, 1_000)) ||
      categoryIds.has(category.id)
    ) {
      return null;
    }
    categoryIds.add(category.id);
  }

  const transactionIds = new Set();
  for (const transaction of transactions) {
    if (
      !transaction ||
      !validString(transaction.id, 100) ||
      !validString(transaction.description, 1_000) ||
      !validString(transaction.date, 20) ||
      typeof transaction.amount !== 'number' ||
      !Number.isFinite(transaction.amount) ||
      transactionIds.has(transaction.id) ||
      (transaction.payee != null && !validString(transaction.payee, 500)) ||
      (transaction.account != null && !validString(transaction.account, 500)) ||
      (transaction.notes != null && !validString(transaction.notes, 1_000))
    ) {
      return null;
    }
    transactionIds.add(transaction.id);
  }

  return { model, masterPrompt, categories, transactions, categoryIds, transactionIds };
}

function getOutputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return null;
}

function parseSuggestions(response, transactionIds, categoryIds) {
  const outputText = getOutputText(response);
  if (!outputText) return null;

  try {
    const parsed = JSON.parse(outputText);
    if (!Array.isArray(parsed.suggestions)) return null;
    const suggestions = [];
    const seen = new Set();
    for (const suggestion of parsed.suggestions) {
      if (
        !suggestion ||
        !transactionIds.has(suggestion.transactionId) ||
        seen.has(suggestion.transactionId) ||
        (suggestion.categoryId !== null && !categoryIds.has(suggestion.categoryId)) ||
        typeof suggestion.confidence !== 'number' ||
        suggestion.confidence < 0 ||
        suggestion.confidence > 1 ||
        !validString(suggestion.reason, 500)
      ) {
        return null;
      }
      seen.add(suggestion.transactionId);
      suggestions.push(suggestion);
    }
    return suggestions;
  } catch {
    return null;
  }
}

export async function requestOpenAiCategorization(apiKey, request) {
  const body = {
    model: request.model,
    store: false,
    instructions:
      'You categorize personal-finance expense transactions. Return only the required JSON. Use only a supplied category ID, or null when no category is justified.',
    input: JSON.stringify({
      masterPrompt: request.masterPrompt,
      categories: request.categories,
      transactions: request.transactions,
    }),
    max_output_tokens: Math.min(1_200, Math.max(200, request.transactions.length * 60)),
    text: {
      format: {
        type: 'json_schema',
        name: 'finance_categorization_suggestions',
        strict: true,
        schema: suggestionSchema,
      },
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          continue;
        }
        return { error: 'provider-request-failed', status: response.status };
      }
      const suggestions = parseSuggestions(
        await response.json(),
        request.transactionIds,
        request.categoryIds,
      );
      return suggestions ? { suggestions } : { error: 'invalid-provider-response' };
    } catch {
      if (attempt === 0) continue;
      return { error: 'provider-unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

const app = express();

export { app as handlers, getConfiguredOpenAiKey, parseSuggestions, validateCategorizationRequest };
app.use(express.json({ limit: '1mb' }));
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

app.use((req, res, next) => {
  const fileId = req.get('X-Actual-File-Id');
  if (!fileId || !isValidFileId(fileId)) {
    res.status(400).send({ status: 'error', reason: 'invalid-file-id' });
    return;
  }
  if (!canAccessBudget(fileId, res.locals.user_id)) {
    res.status(403).send({ status: 'error', reason: 'file-access-denied' });
    return;
  }
  res.locals.fileId = fileId;
  next();
});

app.get('/status', (req, res) => {
  const { key, source } = getConfiguredOpenAiKey(res.locals.fileId);
  res.status(200).send({ status: 'ok', data: { configured: Boolean(key), source } });
});

app.post('/categorize', async (req, res) => {
  const request = validateCategorizationRequest(req.body);
  if (!request) {
    res.status(400).send({ status: 'error', reason: 'invalid-request' });
    return;
  }
  const { key } = getConfiguredOpenAiKey(res.locals.fileId);
  if (!key) {
    res.status(409).send({ status: 'error', reason: 'not-configured' });
    return;
  }
  if (activeRequests >= maxConcurrentRequests) {
    res.status(429).send({ status: 'error', reason: 'busy' });
    return;
  }

  activeRequests++;
  try {
    const result = await requestOpenAiCategorization(key, request);
    if ('error' in result) {
      res.status(result.status || 502).send({ status: 'error', reason: result.error });
      return;
    }
    res.status(200).send({ status: 'ok', data: { suggestions: result.suggestions } });
  } finally {
    activeRequests--;
  }
});
