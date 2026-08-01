import { request as createRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

import type { FinanceCompanionConfiguration } from '#config';
import {
  createFinanceCompanionHttpApplication,
  startFinanceCompanionHttpServer,
} from '#http/server';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';

import { createTestRequestReplayRepository } from './fixtures/request-replay-repository.ts';

const configuration: FinanceCompanionConfiguration = {
  bindAddress: '127.0.0.1',
  port: 4100,
  origin: 'http://127.0.0.1:4100',
  dataDirectory: 'C:\\companion-data',
  databasePath: 'C:\\companion-data\\companion.sqlite',
  integrityAnchorPath: 'C:\\integrity.anchor',
  integrityMacKeyFile: 'C:\\integrity.key',
  integrityMacKey: undefined,
  budgetKeyHash: 'a'.repeat(64),
  budgetCurrencyCode: 'USD',
  ownerBootstrapCredential: undefined,
  ownerBootstrapCredentialFile: undefined,
};

const ownerCredential = Buffer.alloc(32, 7).toString('base64url');
let security: Awaited<ReturnType<typeof createFinanceCompanionSecurity>>;

beforeAll(async () => {
  security = await createFinanceCompanionSecurity({
    bootstrapCredential: ownerCredential,
    localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
  });
});

describe('createFinanceCompanionHttpApplication', () => {
  it('serves the minimal health payload and static login shell without auth routes', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
      ),
    );
    await listen(server);
    try {
      const health = await request(server, '/health');
      const loginShell = await request(server, '/');
      const loginEndpoint = await request(server, '/api/v1/session', 'POST');
      expect(health.statusCode).toBe(200);
      expect(health.headers['access-control-allow-origin']).toBeUndefined();
      expect(health.body).toBe('{"status":"healthy","version":"0.0.1"}');
      expect(loginShell.body).toContain('Finance Companion');
      expect(loginEndpoint.statusCode).toBe(403);
    } finally {
      await close(server);
    }
  });

  it('fails readiness after the injected Actual adapter reaches terminal fail-stop', async () => {
    let adapterHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
        undefined,
        undefined,
        { getHealth: () => adapterHealth },
      ),
    );
    await listen(server);
    try {
      expect((await request(server, '/health')).statusCode).toBe(200);
      adapterHealth = 'degraded';
      expect((await request(server, '/health')).statusCode).toBe(200);
      adapterHealth = 'unhealthy';
      const health = await request(server, '/health');
      expect(health.statusCode).toBe(503);
      expect(health.body).toBe('{"status":"unhealthy","version":"0.0.1"}');
    } finally {
      await close(server);
    }
  });

  it('rejects a non-loopback bind before listening', () => {
    expect(() =>
      createFinanceCompanionHttpApplication(
        { ...configuration, bindAddress: '0.0.0.0' },
        '.',
        security,
        createTestRequestReplayRepository(),
      ),
    ).toThrow('Finance Companion only supports the 127.0.0.1 bind address.');
  });

  it('recovers companion-only replay state before accepting HTTP work', async () => {
    const requestReplayRepository = {
      ...createTestRequestReplayRepository(),
      recoverCompanionOnlyInterruptedRequests: () => {
        throw new Error('synthetic recovery failure');
      },
    };
    await expect(
      startFinanceCompanionHttpServer(
        { ...configuration, port: 4101 },
        path.resolve(import.meta.dirname, '../..'),
        security,
        requestReplayRepository,
      ),
    ).rejects.toThrow('synthetic recovery failure');
  });

  it('requires the exact configured host', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
      ),
    );
    await listen(server);
    try {
      expect(
        (await request(server, '/health', 'GET', 'localhost:4100')).statusCode,
      ).toBe(400);
    } finally {
      await close(server);
    }
  });

  it('requires exact Origin and JSON for login, then returns a strict session cookie', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
      ),
    );
    await listen(server);
    try {
      const requestBody = JSON.stringify({ credential: ownerCredential });
      const response = await rawRequest(
        server,
        [
          'POST /api/v1/session HTTP/1.1',
          'Host: 127.0.0.1:4100',
          'Origin: http://127.0.0.1:4100',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(requestBody)}`,
          'Connection: close',
          '',
          requestBody,
        ].join('\r\n'),
      );
      expect(response).toMatch(/^HTTP\/1\.1 201 /);
      expect(response).toContain('HttpOnly; SameSite=Strict; Path=/');
      expect(response).toContain('Cache-Control: no-store');
      expect(response).not.toContain(ownerCredential);
    } finally {
      await close(server);
    }
  });

  it('rejects duplicate raw Host headers', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        security,
        createTestRequestReplayRepository(),
      ),
    );
    await listen(server);
    try {
      const response = await rawRequest(
        server,
        [
          'GET /health HTTP/1.1',
          'Host: 127.0.0.1:4100',
          'Host: 127.0.0.1:4100',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      expect(response).toMatch(/^HTTP\/1\.1 400 /);
      expect(response).toContain('"code":"host_rejected"');
    } finally {
      await close(server);
    }
  });

  it('returns the exact frozen internal error response without exception detail', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
        {
          ...security,
          login: async () => {
            throw new Error('synthetic private failure detail');
          },
        },
        createTestRequestReplayRepository(),
      ),
    );
    await listen(server);
    try {
      const requestBody = JSON.stringify({ credential: ownerCredential });
      const response = await rawRequest(
        server,
        [
          'POST /api/v1/session HTTP/1.1',
          'Host: 127.0.0.1:4100',
          'Origin: http://127.0.0.1:4100',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(requestBody)}`,
          'Connection: close',
          '',
          requestBody,
        ].join('\r\n'),
      );
      expect(response).toMatch(/^HTTP\/1\.1 500 /);
      const body = JSON.parse(
        response.slice(response.indexOf('\r\n\r\n') + 4),
      ) as {
        code: string;
        message: string;
        retryable: boolean;
      };
      expect(body).toMatchObject({
        code: 'internal_error',
        message: 'The operation failed.',
        retryable: false,
      });
      expect(response).not.toContain('synthetic private failure detail');
    } finally {
      await close(server);
    }
  });
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close(error => (error === undefined ? resolve() : reject(error))),
  );
}
function request(
  server: Server,
  pathname: string,
  method = 'GET',
  host = '127.0.0.1:4100',
): Promise<
  Readonly<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>
> {
  const port = getServerPort(server);
  return new Promise((resolve, reject) => {
    const request = createRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: { host },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function rawRequest(server: Server, message: string): Promise<string> {
  const port = getServerPort(server);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(message);
    });
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function getServerPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not expose an IPv4 address.');
  }
  return address.port;
}
