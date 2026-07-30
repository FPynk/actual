import { request as createRequest, createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';

import type { FinanceCompanionConfiguration } from '#config';
import { createFinanceCompanionHttpApplication } from '#http/server';

const configuration: FinanceCompanionConfiguration = {
  bindAddress: '127.0.0.1',
  port: 4100,
  origin: 'http://127.0.0.1:4100',
};

describe('createFinanceCompanionHttpApplication', () => {
  it('serves the minimal health payload and static login shell without auth routes', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
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
      expect(loginEndpoint.statusCode).toBe(404);
    } finally {
      await close(server);
    }
  });

  it('rejects a non-loopback bind before listening', () => {
    expect(() =>
      createFinanceCompanionHttpApplication(
        { ...configuration, bindAddress: '0.0.0.0' },
        '.',
      ),
    ).toThrow('Finance Companion only supports the 127.0.0.1 bind address.');
  });

  it('requires the exact configured host', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
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

  it('rejects duplicate raw Host headers', async () => {
    const server = createServer(
      createFinanceCompanionHttpApplication(
        configuration,
        path.resolve(import.meta.dirname, '../..'),
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
      expect(response).toContain('\r\n\r\nBad Request');
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
      socket.end(message);
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
