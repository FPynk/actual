import express from 'express';
import type { Express, RequestHandler, Response } from 'express';

import type { ActualAdapter } from '#actual/adapter';
import {
  decideSubscriptionReview,
  readSubscriptionReviewDetail,
  readSubscriptionReviewList,
  SubscriptionReviewConflictError,
} from '#subscriptions/subscription-review-service';
import type {
  SubscriptionReviewAction,
  SubscriptionReviewRepository,
} from '#subscriptions/subscription-review-service';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_LIMIT = 256 * 1024;

export type SubscriptionReviewRouteDependencies = Readonly<{
  adapter: ActualAdapter;
  repository: SubscriptionReviewRepository;
  now?: () => Date;
}>;

export function addSubscriptionReviewRoutes(
  application: Express,
  configuration: Readonly<{
    budgetKeyHash: string;
    budgetCurrencyCode: string;
  }>,
  dependencies: SubscriptionReviewRouteDependencies,
  boundaries: Readonly<{
    readSession: RequestHandler;
    decisionSecurity: readonly RequestHandler[];
    sendProblem(
      response: Response,
      code: 'invalid_request' | 'not_found' | 'review_conflict',
    ): void;
  }>,
): void {
  const route = '/api/v1/subscription-reviews';
  const reviewDependencies = {
    adapter: dependencies.adapter,
    repository: dependencies.repository,
    budgetKeyHash: configuration.budgetKeyHash,
    currencyCode: configuration.budgetCurrencyCode,
    now: dependencies.now,
  };

  application.get(route, boundaries.readSession, async (_request, response) => {
    response.json(await readSubscriptionReviewList(reviewDependencies));
  });
  application.get(
    `${route}/:reviewRef`,
    boundaries.readSession,
    async (request, response) => {
      const detail = await readSubscriptionReviewDetail(
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
        const detail = await decideSubscriptionReview(
          {
            action,
            reviewRef: request.params.reviewRef,
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
        if (error instanceof SubscriptionReviewConflictError) {
          boundaries.sendProblem(response, 'review_conflict');
          return;
        }
        throw error;
      }
    },
  );
}

function readAction(value: unknown): SubscriptionReviewAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'approve') {
    if (
      !hasExactKeys(record, ['kind', 'userSelectedType']) ||
      !isCandidateType(record.userSelectedType)
    ) {
      return null;
    }
    return {
      kind: 'approve',
      userSelectedType: record.userSelectedType,
    };
  }
  if (record.kind === 'defer' || record.kind === 'reopen') {
    return hasExactKeys(record, ['kind']) ? { kind: record.kind } : null;
  }
  if (record.kind === 'reject') {
    if (!hasOnlyKeys(record, ['kind', 'reasonCode'])) return null;
    if (
      record.reasonCode !== undefined &&
      record.reasonCode !== 'not-recurring' &&
      record.reasonCode !== 'other'
    ) {
      return null;
    }
    return record.reasonCode === undefined
      ? { kind: 'reject' }
      : { kind: 'reject', reasonCode: record.reasonCode };
  }
  return null;
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(record).length === keys.length &&
    Object.keys(record).every(key => keys.includes(key))
  );
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(record).every(key => keys.includes(key));
}

function isCandidateType(
  value: unknown,
): value is 'subscription' | 'household_bill' | 'financial_bill' | 'unknown' {
  return (
    value === 'subscription' ||
    value === 'household_bill' ||
    value === 'financial_bill' ||
    value === 'unknown'
  );
}
