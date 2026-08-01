import express from 'express';
import type { Express, RequestHandler, Response } from 'express';

import type { ActualAdapter } from '#actual/adapter';
import { AmazonReviewConflictError } from '#service/amazon-review-repository';
import type {
  AmazonReviewAction,
  AmazonReviewRepository,
} from '#service/amazon-review-repository';
import {
  decideAmazonReview,
  readAmazonReviewDetail,
  readAmazonReviewList,
} from '#service/amazon-review-service';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_LIMIT = 256 * 1024;

export type AmazonReviewRouteDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: AmazonReviewRepository;
  now?: () => Date;
}>;

export function addAmazonReviewRoutes(
  application: Express,
  configuration: Readonly<{
    budgetKeyHash: string;
    budgetCurrencyCode: string;
  }>,
  dependencies: AmazonReviewRouteDependencies,
  boundaries: Readonly<{
    readSession: RequestHandler;
    decisionSecurity: readonly RequestHandler[];
    sendProblem(
      response: Response,
      code: 'invalid_request' | 'not_found' | 'review_conflict',
    ): void;
  }>,
): void {
  const route = '/api/v1/amazon-reviews';
  const reviewDependencies = {
    adapter: dependencies.adapter,
    repository: dependencies.repository,
    budgetKeyHash: configuration.budgetKeyHash,
    currencyCode: configuration.budgetCurrencyCode,
    now: dependencies.now,
  };

  application.get(route, boundaries.readSession, async (_request, response) => {
    response.json(await readAmazonReviewList(reviewDependencies));
  });
  application.get(
    `${route}/:reviewRef`,
    boundaries.readSession,
    async (request, response) => {
      const detail = await readAmazonReviewDetail(
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
      const action = readAction(request.body);
      if (action === null) {
        boundaries.sendProblem(response, 'invalid_request');
        return;
      }
      try {
        const detail = await decideAmazonReview(
          {
            reviewRef: request.params.reviewRef,
            action,
            decidedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          },
          reviewDependencies,
        );
        if (detail === null) {
          boundaries.sendProblem(response, 'not_found');
          return;
        }
        response.json(detail);
      } catch (error) {
        if (error instanceof AmazonReviewConflictError) {
          boundaries.sendProblem(response, 'review_conflict');
          return;
        }
        throw error;
      }
    },
  );
}

function readAction(value: unknown): AmazonReviewAction | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('kind' in value)
  ) {
    return null;
  }
  const kind = value.kind;
  return kind === 'approve' ||
    kind === 'reject' ||
    kind === 'defer' ||
    kind === 'reopen'
    ? { kind }
    : null;
}
