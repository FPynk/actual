import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readdir, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import type { ActualAdapter } from '#actual/adapter';
import type { FinanceCompanionConfiguration } from '#config';
import type { SourceIdentityRepository } from '#database/source-identity-repository';
import { calculateRequestReplayHash } from '#http/request-idempotency';
import type { AmazonUploadSemanticRequest } from '#http/request-idempotency';
import {
  createReconciliationReviewCandidateDto,
  createReconciliationReviewListDto,
  readReconciliationReviewCandidate,
  readReconciliationReviewEvidence,
} from '#reconciliation-review';
import { decideReconciliationCandidate } from '#reconciliation/candidates';
import type { ReconciliationCandidateRepository } from '#reconciliation/candidates';
import type { FinanceCompanionSecurity } from '#security/local-security';
import { createFinanceCompanionHealth } from '#service/health';
import { validateIdempotencyKey } from '#service/request-replay-repository';
import type { RequestReplayRepository } from '#service/request-replay-repository';

const SESSION_COOKIE_NAME = 'finance_companion_session';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const JSON_LIMIT = 256 * 1024;
const UPLOAD_LIMIT = 10 * 1024 * 1024;
const UPLOAD_TEMPORARY_DIRECTORY_PREFIX = 'finance-companion-upload-';

type FinanceCompanionListenerConfiguration = Readonly<{
  bindAddress: string;
  budgetKeyHash: FinanceCompanionConfiguration['budgetKeyHash'];
  budgetCurrencyCode: FinanceCompanionConfiguration['budgetCurrencyCode'];
  origin: FinanceCompanionConfiguration['origin'];
  port: number;
}>;

export type ReconciliationReviewDependencies = Readonly<{
  adapter: ActualAdapter;
  candidateRepository: ReconciliationCandidateRepository;
  sourceIdentityRepository: SourceIdentityRepository;
  now?: () => Date;
}>;

type IdempotentRequest = Request & {
  financeCompanionAmazonUpload?: AmazonUploadSemanticRequest;
};

export function createFinanceCompanionHttpApplication(
  configuration: FinanceCompanionListenerConfiguration,
  staticUiDirectory: string,
  security: FinanceCompanionSecurity,
  requestReplayRepository: RequestReplayRepository,
  uploadTemporaryParentDirectory = tmpdir(),
  reconciliationReview?: ReconciliationReviewDependencies,
): Express {
  if (configuration.bindAddress !== '127.0.0.1') {
    throw new Error(
      'Finance Companion only supports the 127.0.0.1 bind address.',
    );
  }
  const application = express();
  application.disable('x-powered-by');
  application.disable('etag');
  application.use(createLoopbackBoundary(configuration));
  application.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  application.get('/health', (_request, response) =>
    response.json(createFinanceCompanionHealth()),
  );
  application.post(
    '/api/v1/session',
    requireExactOrigin(configuration.origin),
    requireJsonContentType,
    express.json({
      limit: JSON_LIMIT,
      strict: true,
      type: request => request.headers['content-type'] === JSON_CONTENT_TYPE,
    }),
    async (request, response) => {
      const credential = readStringProperty(request.body, 'credential');
      if (credential === null || Object.keys(request.body).length !== 1) {
        sendProblem(response, 'invalid_request');
        return;
      }
      const login = await security.login(credential);
      if (login === 'rate-limited') {
        sendProblem(response, 'rate_limited');
        return;
      }
      if (login === null) {
        sendProblem(response, 'unauthenticated');
        return;
      }
      response
        .status(201)
        .setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE_NAME}=${login.sessionId}; HttpOnly; SameSite=Strict; Path=/`,
        )
        .json({
          csrfToken: login.csrfToken,
          expiresAt: login.expiresAt,
          principal: { id: login.principalId, role: 'owner' },
        });
    },
  );
  application.delete(
    '/api/v1/session',
    requireExactOrigin(configuration.origin),
    requireSession(security, true),
    async (request, response) => {
      security.revokeSession(readSessionId(request));
      response
        .status(204)
        .setHeader(
          'Set-Cookie',
          `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        )
        .end();
    },
  );
  if (reconciliationReview !== undefined) {
    addReconciliationReviewRoutes(
      application,
      configuration,
      security,
      reconciliationReview,
    );
  }
  application.post(
    '/api/v1/imports/amazon',
    requireExactOrigin(configuration.origin),
    requireSession(security, true),
    requireAmazonUpload(uploadTemporaryParentDirectory),
    requireRequestReplay(
      configuration,
      requestReplayRepository,
      'amazon-import/v1',
      request => request.financeCompanionAmazonUpload,
    ),
    (_request, response) =>
      sendIdempotentProblem(response, 'feature_not_implemented'),
  );
  application.use('/api', (request, response) => {
    if (isMutation(request.method)) {
      requireExactOrigin(configuration.origin)(request, response, () => {
        requireSession(security, true)(request, response, () =>
          requireJsonContentType(request, response, () =>
            sendProblem(response, 'not_found'),
          ),
        );
      });
      return;
    }
    requireSession(security, false)(request, response, () =>
      sendProblem(response, 'not_found'),
    );
  });
  application.use(
    express.static(path.resolve(staticUiDirectory), { index: 'index.html' }),
  );
  application.get(
    ['/reconciliation', '/reconciliation/:reviewId'],
    (_request, response) =>
      response.sendFile(path.resolve(staticUiDirectory, 'index.html')),
  );
  application.use((_request, response) => sendProblem(response, 'not_found'));
  application.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (response.headersSent) return;
      if (error instanceof SyntaxError || isRequestTooLargeError(error)) {
        sendProblem(
          response,
          isRequestTooLargeError(error)
            ? 'payload_too_large'
            : 'invalid_request',
        );
        return;
      }
      sendProblem(response, 'internal_error');
    },
  );
  return application;
}

export async function startFinanceCompanionHttpServer(
  configuration: FinanceCompanionListenerConfiguration,
  staticUiDirectory: string,
  security: FinanceCompanionSecurity,
  requestReplayRepository: RequestReplayRepository,
  reconciliationReview?: ReconciliationReviewDependencies,
): Promise<Server> {
  requestReplayRepository.recoverCompanionOnlyInterruptedRequests();
  const server = createServer(
    createFinanceCompanionHttpApplication(
      configuration,
      staticUiDirectory,
      security,
      requestReplayRepository,
      undefined,
      reconciliationReview,
    ),
  );
  server.headersTimeout = 10 * 1000;
  server.timeout = 30 * 1000;
  server.requestTimeout = 60 * 1000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuration.port, configuration.bindAddress, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

function addReconciliationReviewRoutes(
  application: Express,
  configuration: FinanceCompanionListenerConfiguration,
  security: FinanceCompanionSecurity,
  reconciliationReview: ReconciliationReviewDependencies,
): void {
  const listPath = '/api/v1/reconciliation-candidates';
  application.get(
    listPath,
    requireSession(security, false),
    (_request, response) => {
      response.json(
        createReconciliationReviewListDto(
          reconciliationReview.candidateRepository,
          configuration.budgetKeyHash,
        ),
      );
    },
  );
  application.get(
    `${listPath}/:reviewId`,
    requireSession(security, false),
    async (request, response) => {
      const resolved = readReconciliationReviewCandidate(
        reconciliationReview.candidateRepository,
        request.params.reviewId,
        configuration.budgetKeyHash,
      );
      if (resolved === null) {
        sendProblem(response, 'not_found');
        return;
      }
      const candidates = reconciliationReview.candidateRepository.list();
      response.json(
        createReconciliationReviewCandidateDto(
          resolved,
          candidates,
          configuration.budgetKeyHash,
          await readReconciliationReviewEvidence(resolved, {
            adapter: reconciliationReview.adapter,
            budgetKeyHash: configuration.budgetKeyHash,
            currencyCode: configuration.budgetCurrencyCode,
            sourceIdentityRepository:
              reconciliationReview.sourceIdentityRepository,
          }),
        ),
      );
    },
  );
  application.post(
    `${listPath}/:reviewId/decision`,
    requireExactOrigin(configuration.origin),
    requireSession(security, true),
    requireJsonContentType,
    express.json({
      limit: JSON_LIMIT,
      strict: true,
      type: request => request.headers['content-type'] === JSON_CONTENT_TYPE,
    }),
    async (request, response) => {
      const decision = readReconciliationDecision(request.body);
      const resolved = readReconciliationReviewCandidate(
        reconciliationReview.candidateRepository,
        request.params.reviewId,
        configuration.budgetKeyHash,
      );
      if (decision === null) {
        sendProblem(response, 'invalid_request');
        return;
      }
      if (resolved === null) {
        sendProblem(response, 'not_found');
        return;
      }
      const candidate = await decideReconciliationCandidate({
        adapter: reconciliationReview.adapter,
        candidateId: resolved.id,
        candidateRepository: reconciliationReview.candidateRepository,
        decidedAt: (
          reconciliationReview.now ?? (() => new Date())
        )().toISOString(),
        decisionNote: decision.note,
        status: decision.status,
      });
      const candidates = reconciliationReview.candidateRepository.list();
      response.json(
        createReconciliationReviewCandidateDto(
          candidate,
          candidates,
          configuration.budgetKeyHash,
          await readReconciliationReviewEvidence(candidate, {
            adapter: reconciliationReview.adapter,
            budgetKeyHash: configuration.budgetKeyHash,
            currencyCode: configuration.budgetCurrencyCode,
            sourceIdentityRepository:
              reconciliationReview.sourceIdentityRepository,
          }),
        ),
      );
    },
  );
}

function readReconciliationDecision(
  value: unknown,
): Readonly<{ status: 'approved' | 'rejected'; note: string | null }> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !Object.keys(record).every(key => key === 'status' || key === 'note') ||
    (record.status !== 'approved' && record.status !== 'rejected') ||
    (record.note !== undefined &&
      (typeof record.note !== 'string' || record.note.length > 1_000))
  ) {
    return null;
  }
  return { status: record.status, note: record.note ?? null };
}

function createLoopbackBoundary(
  configuration: FinanceCompanionListenerConfiguration,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (
      request.socket.remoteAddress !== '127.0.0.1' ||
      !hasExactlyOneHeader(
        request.rawHeaders,
        'host',
        `127.0.0.1:${configuration.port}`,
      )
    ) {
      sendProblem(response, 'host_rejected');
      return;
    }
    next();
  };
}

function requireExactOrigin(expectedOrigin: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!hasExactlyOneHeader(request.rawHeaders, 'origin', expectedOrigin)) {
      sendProblem(response, 'origin_rejected');
      return;
    }
    next();
  };
}

function requireJsonContentType(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (request.headers['content-type'] !== JSON_CONTENT_TYPE) {
    sendProblem(response, 'unsupported_media_type');
    return;
  }
  next();
}

function requireSession(
  security: FinanceCompanionSecurity,
  requireCsrf: boolean,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const csrfToken = requireCsrf
      ? readExactlyOneHeader(request.rawHeaders, 'x-finance-csrf')
      : undefined;
    if (requireCsrf && csrfToken === undefined) {
      sendProblem(response, 'forbidden');
      return;
    }
    const sessionId = readSessionId(request);
    const session = security.readSession(sessionId, csrfToken);
    if (session === null) {
      sendProblem(response, 'unauthenticated');
      return;
    }
    if (session === 'csrf-rejected') {
      sendProblem(response, 'forbidden');
      return;
    }
    response.locals.financeCompanionPrincipalId = session.principalId;
    next();
  };
}

function requireAmazonUpload(uploadTemporaryParentDirectory: string) {
  return async (
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const boundary = readMultipartBoundary(request.headers['content-type']);
    if (boundary === null) {
      sendProblem(response, 'unsupported_media_type');
      return;
    }
    const declaredLength = readDeclaredUploadLength(request);
    if (declaredLength === null) {
      sendProblem(response, 'invalid_request');
      return;
    }
    if (declaredLength > UPLOAD_LIMIT) {
      request.resume();
      sendProblem(response, 'payload_too_large');
      return;
    }
    try {
      const semanticRequest = await streamAndValidateAmazonUpload(
        request,
        declaredLength,
        boundary,
        uploadTemporaryParentDirectory,
      );
      if (semanticRequest === null) {
        sendProblem(response, 'invalid_request');
        return;
      }
      (request as IdempotentRequest).financeCompanionAmazonUpload =
        semanticRequest;
      next();
    } catch (error) {
      sendProblem(
        response,
        error instanceof UploadTooLargeError
          ? 'payload_too_large'
          : 'invalid_request',
      );
    }
  };
}

function requireRequestReplay(
  configuration: FinanceCompanionListenerConfiguration,
  repository: RequestReplayRepository,
  operationId: string,
  readSemanticRequest: (
    request: IdempotentRequest,
  ) => AmazonUploadSemanticRequest | undefined,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const idempotencyKey = validateIdempotencyKey(
      readExactlyOneHeader(request.rawHeaders, 'idempotency-key'),
    );
    const semanticRequest = readSemanticRequest(request as IdempotentRequest);
    const principalId = response.locals.financeCompanionPrincipalId;
    if (
      idempotencyKey === null ||
      semanticRequest === undefined ||
      typeof principalId !== 'string'
    ) {
      sendProblem(response, 'invalid_request');
      return;
    }
    const decision = repository.begin({
      budgetKeyHash: configuration.budgetKeyHash,
      principalId,
      invocationKind: 'local_http',
      operationId,
      idempotencyKey,
      requestHash: calculateRequestReplayHash(semanticRequest),
    });
    if (decision.kind === 'conflict') {
      sendProblem(response, 'idempotency_conflict');
      return;
    }
    if (decision.kind === 'in_progress') {
      response.setHeader('Retry-After', '1');
      sendProblem(response, 'operation_in_progress');
      return;
    }
    if (decision.kind === 'replay') {
      response
        .status(decision.response.status)
        .type(decision.response.contentType)
        .json(decision.response.body);
      return;
    }
    response.locals.financeCompanionReplay = { repository, ...decision };
    next();
  };
}

function readSessionId(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie;
  if (cookie === undefined) return undefined;
  let sessionId: string | undefined;
  for (const item of cookie.split(';')) {
    const [name, value] = item.trim().split('=', 2);
    if (name === SESSION_COOKIE_NAME && value !== undefined) {
      if (sessionId !== undefined) return undefined;
      sessionId = value;
    }
  }
  return sessionId;
}

function readStringProperty(value: unknown, property: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : null;
}

function readExactlyOneHeader(
  rawHeaders: readonly string[],
  name: string,
): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function hasExactlyOneHeader(
  rawHeaders: readonly string[],
  name: string,
  expectedValue: string,
): boolean {
  return readExactlyOneHeader(rawHeaders, name) === expectedValue;
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function sendProblem(
  response: Response,
  code: keyof typeof problemDefinitions,
): void {
  const problem = problemDefinitions[code];
  response
    .setHeader('Cache-Control', 'no-store')
    .status(problem.status)
    .type('application/problem+json')
    .json({
      code,
      requestId: randomUUID(),
      message: problem.message,
      retryable: problem.retryable,
    });
}

function sendIdempotentProblem(
  response: Response,
  code: 'feature_not_implemented',
): void {
  const problem = problemDefinitions[code];
  const body = {
    code,
    requestId: randomUUID(),
    message: problem.message,
    retryable: problem.retryable,
  };
  const replay = response.locals.financeCompanionReplay as
    | Readonly<{ replayId: string; repository: RequestReplayRepository }>
    | undefined;
  try {
    replay?.repository.complete(replay.replayId, {
      status: problem.status,
      contentType: 'application/problem+json',
      body,
    });
  } catch {
    sendProblem(response, 'internal_error');
    return;
  }
  response
    .setHeader('Cache-Control', 'no-store')
    .status(problem.status)
    .type('application/problem+json')
    .json(body);
}

const problemDefinitions = {
  invalid_request: {
    status: 400,
    message: 'The request is invalid.',
    retryable: false,
  },
  unauthenticated: {
    status: 401,
    message: 'Authentication is required.',
    retryable: false,
  },
  forbidden: {
    status: 403,
    message: 'This operation is not allowed.',
    retryable: false,
  },
  host_rejected: {
    status: 400,
    message: 'The request host is not allowed.',
    retryable: false,
  },
  origin_rejected: {
    status: 403,
    message: 'The request origin is not allowed.',
    retryable: false,
  },
  rate_limited: {
    status: 429,
    message: 'Too many requests. Try again later.',
    retryable: true,
  },
  not_found: {
    status: 404,
    message: 'The requested resource was not found.',
    retryable: false,
  },
  payload_too_large: {
    status: 413,
    message: 'The request payload is too large.',
    retryable: false,
  },
  unsupported_media_type: {
    status: 415,
    message: 'The request media type is not supported.',
    retryable: false,
  },
  feature_not_implemented: {
    status: 501,
    message: 'This feature is not implemented yet.',
    retryable: false,
  },
  internal_error: {
    status: 500,
    message: 'The operation failed.',
    retryable: false,
  },
  idempotency_conflict: {
    status: 409,
    message: 'The idempotency key was reused for a different request.',
    retryable: false,
  },
  operation_in_progress: {
    status: 409,
    message: 'The operation is already in progress.',
    retryable: true,
  },
} as const;

function isRequestTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  );
}

function readMultipartBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const match =
    /^multipart\/form-data; boundary=([A-Za-z0-9'()+_,./:=?-]{1,70})$/.exec(
      contentType,
    );
  return match?.[1] ?? null;
}

function readDeclaredUploadLength(request: Request): number | null {
  const contentLength = request.headers['content-length'];
  if (contentLength === undefined || !/^(0|[1-9]\d*)$/.test(contentLength)) {
    return null;
  }
  const parsed = Number(contentLength);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

class UploadTooLargeError extends Error {}

async function streamAndValidateAmazonUpload(
  request: IncomingMessage,
  declaredLength: number,
  boundary: string,
  uploadTemporaryParentDirectory: string,
): Promise<AmazonUploadSemanticRequest | null> {
  const temporaryDirectory = await mkdtemp(
    path.join(
      uploadTemporaryParentDirectory,
      UPLOAD_TEMPORARY_DIRECTORY_PREFIX,
    ),
  );
  const temporaryFile = path.join(temporaryDirectory, 'upload.multipart');
  let fileHandle: FileHandle | undefined;
  let fileWasCreated = false;
  try {
    fileHandle = await open(temporaryFile, 'wx+', 0o600);
    fileWasCreated = true;
    let receivedLength = 0;
    for await (const sourceChunk of request) {
      const chunk = Buffer.isBuffer(sourceChunk)
        ? sourceChunk
        : Buffer.from(sourceChunk);
      receivedLength += chunk.length;
      if (receivedLength > UPLOAD_LIMIT) {
        request.resume();
        throw new UploadTooLargeError();
      }
      await fileHandle.write(chunk);
    }
    if (receivedLength !== declaredLength) return null;
    return await isAllowedAmazonUpload(fileHandle, receivedLength, boundary);
  } finally {
    try {
      await fileHandle?.close();
    } finally {
      await removeOwnedTemporaryUpload(
        temporaryDirectory,
        temporaryFile,
        fileWasCreated,
      );
    }
  }
}

async function removeOwnedTemporaryUpload(
  temporaryDirectory: string,
  temporaryFile: string,
  fileWasCreated: boolean,
): Promise<void> {
  const directoryStatus = await lstat(temporaryDirectory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('The owned upload directory is invalid.');
  }
  const entries = await readdir(temporaryDirectory);
  if (
    entries.length !== (fileWasCreated ? 1 : 0) ||
    (fileWasCreated && entries[0] !== path.basename(temporaryFile))
  ) {
    throw new Error('The owned upload directory contents are invalid.');
  }
  if (fileWasCreated) {
    const fileStatus = await lstat(temporaryFile);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()) {
      throw new Error('The owned upload file is invalid.');
    }
    await unlink(temporaryFile);
  }
  await rmdir(temporaryDirectory);
}

async function isAllowedAmazonUpload(
  fileHandle: FileHandle,
  fileLength: number,
  boundary: string,
): Promise<AmazonUploadSemanticRequest | null> {
  const openingBoundary = Buffer.from(`--${boundary}\r\n`, 'ascii');
  const closingBoundary = Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii');
  const initialLength = Math.min(
    fileLength,
    openingBoundary.length + 8 * 1024 + 4,
  );
  const initial = Buffer.alloc(initialLength);
  const initialRead = await fileHandle.read(initial, 0, initial.length, 0);
  if (
    initialRead.bytesRead !== initial.length ||
    !initial.subarray(0, openingBoundary.length).equals(openingBoundary)
  ) {
    return null;
  }
  const headerStart = openingBoundary.length;
  const headerTerminator = initial.indexOf('\r\n\r\n', headerStart, 'ascii');
  if (headerTerminator < 0 || headerTerminator - headerStart > 8 * 1024) {
    return null;
  }
  const headers = initial
    .subarray(headerStart, headerTerminator)
    .toString('ascii');
  const headerLines = headers.split('\r\n');
  if (headerLines.length !== 2 || Buffer.byteLength(headers) > 8 * 1024) {
    return null;
  }
  const disposition = headerLines.find(line =>
    /^content-disposition:/i.test(line),
  );
  const contentType = headerLines.find(line => /^content-type:/i.test(line));
  const filename =
    /^content-disposition: form-data; name="file"; filename="([^"]+)"$/i.exec(
      disposition ?? '',
    )?.[1];
  if (
    filename === undefined ||
    hasUnsafeFilenameCharacter(filename) ||
    filename.includes('..') ||
    !filename.toLowerCase().endsWith('.csv') ||
    contentType?.toLowerCase() !== 'content-type: text/csv'
  ) {
    return null;
  }
  const bodyStart = headerTerminator + 4;
  const bodyLength = fileLength - bodyStart - closingBoundary.length;
  if (bodyLength < 0) return null;
  const actualClosingBoundary = Buffer.alloc(closingBoundary.length);
  const closingRead = await fileHandle.read(
    actualClosingBoundary,
    0,
    actualClosingBoundary.length,
    fileLength - actualClosingBoundary.length,
  );
  if (
    closingRead.bytesRead !== actualClosingBoundary.length ||
    !actualClosingBoundary.equals(closingBoundary) ||
    (await countFileSequence(
      fileHandle,
      fileLength,
      Buffer.from(`--${boundary}`, 'ascii'),
    )) !== 2
  ) {
    return null;
  }
  const signatureBytes = Buffer.alloc(Math.min(bodyLength, 262));
  const signatureRead = await fileHandle.read(
    signatureBytes,
    0,
    signatureBytes.length,
    bodyStart,
  );
  if (
    signatureRead.bytesRead !== signatureBytes.length ||
    hasArchiveSignature(signatureBytes)
  ) {
    return null;
  }
  return {
    adapterVersion: 'amazon-import/v1',
    mediaKind: 'text/csv',
    byteHash: await hashFileRange(fileHandle, bodyStart, bodyLength),
  };
}

async function hashFileRange(
  fileHandle: FileHandle,
  position: number,
  length: number,
): Promise<string> {
  const hash = createHash('sha256');
  let remaining = length;
  let offset = position;
  while (remaining > 0) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
    const result = await fileHandle.read(chunk, 0, chunk.length, offset);
    if (result.bytesRead === 0) {
      throw new Error('The upload ended unexpectedly.');
    }
    hash.update(chunk.subarray(0, result.bytesRead));
    offset += result.bytesRead;
    remaining -= result.bytesRead;
  }
  return hash.digest('hex');
}

function hasUnsafeFilenameCharacter(filename: string): boolean {
  for (const character of filename) {
    const characterCode = character.charCodeAt(0);
    if (
      characterCode <= 31 ||
      characterCode === 127 ||
      character === '\\' ||
      character === '/' ||
      character === ':'
    ) {
      return true;
    }
  }
  return false;
}

async function countFileSequence(
  fileHandle: FileHandle,
  fileLength: number,
  sequence: Buffer,
): Promise<number> {
  let count = 0;
  let carry = Buffer.alloc(0);
  let position = 0;
  while (position < fileLength) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, fileLength - position));
    const result = await fileHandle.read(chunk, 0, chunk.length, position);
    if (result.bytesRead === 0) break;
    position += result.bytesRead;
    const searchable = Buffer.concat([
      carry,
      chunk.subarray(0, result.bytesRead),
    ]);
    let searchOffset = 0;
    while (searchOffset <= searchable.length - sequence.length) {
      const match = searchable.indexOf(sequence, searchOffset);
      if (match < 0) break;
      count += 1;
      searchOffset = match + sequence.length;
    }
    carry = searchable.subarray(
      Math.max(0, searchable.length - sequence.length + 1),
    );
  }
  return count;
}

function hasArchiveSignature(file: Buffer): boolean {
  const signatures = [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x50, 0x4b, 0x07, 0x08]),
    Buffer.from([0x1f, 0x8b]),
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
  ];
  return (
    signatures.some(signature =>
      file.subarray(0, signature.length).equals(signature),
    ) || file.subarray(257, 262).toString('ascii') === 'ustar'
  );
}
