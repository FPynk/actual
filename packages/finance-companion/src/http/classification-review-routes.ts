import express from 'express';
import type { Express, RequestHandler, Response } from 'express';

import type { ActualAdapter } from '#actual/adapter';
import {
  decideClassificationReview,
  readClassificationReviewDetail,
  readClassificationReviewList,
} from '#reviews/classification-review';
import type {
  ClassificationReviewAction,
  ClassificationReviewRepository,
} from '#reviews/classification-review';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_LIMIT = 256 * 1024;

export type ClassificationReviewRouteDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: ClassificationReviewRepository;
  now?: () => Date;
}>;

export function addClassificationReviewRoutes(
  application: Express,
  configuration: Readonly<{
    budgetKeyHash: string;
    budgetCurrencyCode: string;
  }>,
  dependencies: ClassificationReviewRouteDependencies,
  boundaries: Readonly<{
    readSession: RequestHandler;
    decisionSecurity: readonly RequestHandler[];
    sendProblem(
      response: Response,
      code: 'invalid_request' | 'not_found',
    ): void;
  }>,
): void {
  const route = '/api/v1/classification-reviews';
  const reviewDependencies = {
    adapter: dependencies.adapter,
    repository: dependencies.repository,
    budgetKeyHash: configuration.budgetKeyHash,
    currencyCode: configuration.budgetCurrencyCode,
  };

  application.get(route, boundaries.readSession, async (_request, response) => {
    response.json(await readClassificationReviewList(reviewDependencies));
  });
  application.get(
    `${route}/:reviewRef`,
    boundaries.readSession,
    async (request, response) => {
      const detail = await readClassificationReviewDetail(
        request.params.reviewRef,
        reviewDependencies,
      );
      if (detail === null) {
        boundaries.sendProblem(response, 'not_found');
        return;
      }
      response.json(detail);
    },
  );
  application.post(
    `${route}/:reviewRef/decision`,
    ...boundaries.decisionSecurity,
    express.json({
      limit: JSON_LIMIT,
      strict: true,
      type: request => request.headers['content-type'] === JSON_CONTENT_TYPE,
    }),
    async (request, response) => {
      const decision = readDecision(request.body);
      if (decision === null) {
        boundaries.sendProblem(response, 'invalid_request');
        return;
      }
      const detail = await decideClassificationReview(
        {
          reviewRef: request.params.reviewRef,
          decidedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          ...decision,
        },
        reviewDependencies,
      );
      if (detail === null) {
        boundaries.sendProblem(response, 'not_found');
        return;
      }
      response.json(detail);
    },
  );
}

function readDecision(value: unknown): Readonly<{
  decision: 'approve' | 'reject';
  action: ClassificationReviewAction | null;
}> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !Object.keys(record).every(key => key === 'decision' || key === 'action')
  ) {
    return null;
  }
  if (record.decision === 'reject' && record.action === undefined) {
    return { action: null, decision: 'reject' };
  }
  if (
    record.decision === 'approve' &&
    (record.action === 'categorize_once' || record.action === 'create_rule')
  ) {
    return { action: record.action, decision: 'approve' };
  }
  return null;
}
