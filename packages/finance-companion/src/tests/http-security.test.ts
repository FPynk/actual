import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FinanceCompanionConfiguration } from '#config';
import { createFinanceCompanionHttpApplication } from '#http/server';
import {
  createFinanceCompanionSecurity,
  createInMemoryLocalPrincipalRepository,
} from '#security/local-security';

const configuration: FinanceCompanionConfiguration = {
  bindAddress: '127.0.0.1',
  port: 4100,
  origin: 'http://127.0.0.1:4100',
  ownerBootstrapCredential: undefined,
  ownerBootstrapCredentialFile: undefined,
};
const credential = Buffer.alloc(32, 12).toString('base64url');
let server: Server;
let uploadTemporaryParentDirectory: string;

beforeAll(async () => {
  uploadTemporaryParentDirectory = await mkdtemp(
    path.join(tmpdir(), 'finance-companion-security-tests-'),
  );
  const security = await createFinanceCompanionSecurity({
    bootstrapCredential: credential,
    localPrincipalRepository: createInMemoryLocalPrincipalRepository(),
  });
  server = createServer(
    createFinanceCompanionHttpApplication(
      configuration,
      path.resolve(import.meta.dirname, '../..'),
      security,
      uploadTemporaryParentDirectory,
    ),
  );
  await listen(server);
});

afterAll(async () => {
  await close(server);
  expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);
  await rmdir(uploadTemporaryParentDirectory);
});

describe.sequential('finance companion HTTP security boundary', () => {
  it('rejects duplicate Origin headers and emits no CORS headers', async () => {
    const body = Buffer.from(JSON.stringify({ credential }));
    const response = await rawRequest(
      server,
      createHttpRequest('POST', '/api/v1/session', body, [
        'Origin: http://127.0.0.1:4100',
        'Origin: http://127.0.0.1:4100',
        'Content-Type: application/json; charset=utf-8',
      ]),
    );
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain('"code":"origin_rejected"');
    expect(response.toLowerCase()).not.toContain('access-control-allow');
  });

  it.each([
    ['missing', []],
    ['mismatched', ['Origin: http://cross-origin.example']],
    ['literal null', ['Origin: null']],
  ] as const)('rejects a %s mutation Origin', async (_name, originHeaders) => {
    const body = Buffer.from(JSON.stringify({ credential }));
    const response = await rawRequest(
      server,
      createHttpRequest('POST', '/api/v1/session', body, [
        ...originHeaders,
        'Content-Type: application/json; charset=utf-8',
      ]),
    );
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response).toContain('"code":"origin_rejected"');
    expect(response.toLowerCase()).not.toContain('access-control-allow');
  });

  it('does not grant CORS on preflight requests', async () => {
    const response = await rawRequest(
      server,
      createHttpRequest('OPTIONS', '/api/v1/imports/amazon', Buffer.alloc(0), [
        'Origin: http://cross-origin.example',
        'Access-Control-Request-Method: POST',
      ]),
    );
    expect(response).toMatch(/^HTTP\/1\.1 401 /);
    expect(response.toLowerCase()).not.toContain('access-control-allow');
  });

  it('rejects cross-session CSRF without revoking the valid session', async () => {
    const first = await login(server);
    const second = await login(server);
    const rejected = await rawRequest(
      server,
      createHttpRequest('DELETE', '/api/v1/session', Buffer.alloc(0), [
        `Origin: ${configuration.origin}`,
        `Cookie: ${first.cookie}`,
        `X-Finance-CSRF: ${second.csrfToken}`,
      ]),
    );
    expect(rejected).toMatch(/^HTTP\/1\.1 403 /);
    expect(rejected).toContain('"code":"forbidden"');

    const accepted = await rawRequest(
      server,
      createHttpRequest('DELETE', '/api/v1/session', Buffer.alloc(0), [
        `Origin: ${configuration.origin}`,
        `Cookie: ${first.cookie}`,
        `X-Finance-CSRF: ${first.csrfToken}`,
      ]),
    );
    expect(accepted).toMatch(/^HTTP\/1\.1 204 /);
  });

  it('rejects traversal, archive, type, and size abuse and deletes every owned temporary upload', async () => {
    const session = await login(server);
    const traversal = createMultipartUpload(
      'boundary-traversal',
      '../../orders.csv',
      Buffer.from('date,amount\n'),
    );
    expect(
      await authenticatedUpload(
        server,
        session,
        'boundary-traversal',
        traversal,
      ),
    ).toMatch(/^HTTP\/1\.1 400 /);
    expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);

    const archive = createMultipartUpload(
      'boundary-archive',
      'orders.csv',
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
    );
    expect(
      await authenticatedUpload(server, session, 'boundary-archive', archive),
    ).toMatch(/^HTTP\/1\.1 400 /);
    expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);

    const wrongType = await rawRequest(
      server,
      createHttpRequest('POST', '/api/v1/imports/amazon', Buffer.from('zip'), [
        `Origin: ${configuration.origin}`,
        `Cookie: ${session.cookie}`,
        `X-Finance-CSRF: ${session.csrfToken}`,
        'Content-Type: application/zip',
      ]),
    );
    expect(wrongType).toMatch(/^HTTP\/1\.1 415 /);
    expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);

    const oversized = await rawRequest(
      server,
      Buffer.from(
        [
          'POST /api/v1/imports/amazon HTTP/1.1',
          'Host: 127.0.0.1:4100',
          `Origin: ${configuration.origin}`,
          `Cookie: ${session.cookie}`,
          `X-Finance-CSRF: ${session.csrfToken}`,
          'Content-Type: multipart/form-data; boundary=boundary-size',
          `Content-Length: ${10 * 1024 * 1024 + 1}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      ),
    );
    expect(oversized).toMatch(/^HTTP\/1\.1 413 /);
    expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);

    const valid = createMultipartUpload(
      'boundary-valid',
      'orders.csv',
      Buffer.from('date,amount\n2026-01-01,100\n'),
    );
    const validResponse = await authenticatedUpload(
      server,
      session,
      'boundary-valid',
      valid,
    );
    expect(validResponse).toMatch(/^HTTP\/1\.1 501 /);
    expect(validResponse.toLowerCase()).not.toContain('access-control-allow');
    expect(await readdir(uploadTemporaryParentDirectory)).toEqual([]);
  });

  it('deletes its owned temporary upload after a client abort', async () => {
    const session = await login(server);
    const socket = await connectSocket(server);
    const partialBody = Buffer.from(
      [
        '--boundary-abort',
        'Content-Disposition: form-data; name="file"; filename="orders.csv"',
        'Content-Type: text/csv',
        '',
        'date,amount\n',
      ].join('\r\n'),
      'ascii',
    );
    socket.write(
      Buffer.concat([
        Buffer.from(
          [
            'POST /api/v1/imports/amazon HTTP/1.1',
            'Host: 127.0.0.1:4100',
            `Origin: ${configuration.origin}`,
            `Cookie: ${session.cookie}`,
            `X-Finance-CSRF: ${session.csrfToken}`,
            'Content-Type: multipart/form-data; boundary=boundary-abort',
            `Content-Length: ${partialBody.length + 100}`,
            'Connection: keep-alive',
            '',
            '',
          ].join('\r\n'),
          'ascii',
        ),
        partialBody,
      ]),
    );
    await waitForTemporaryUploadState(true);
    socket.destroy();
    await waitForTemporaryUploadState(false);
  });
});

async function login(targetServer: Server): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const body = Buffer.from(JSON.stringify({ credential }));
  const response = await rawRequest(
    targetServer,
    createHttpRequest('POST', '/api/v1/session', body, [
      `Origin: ${configuration.origin}`,
      'Content-Type: application/json; charset=utf-8',
    ]),
  );
  const cookie = /^Set-Cookie: ([^;]+);/im.exec(response)?.[1];
  const responseBody = response.slice(response.indexOf('\r\n\r\n') + 4);
  const csrfToken = (JSON.parse(responseBody) as { csrfToken?: unknown })
    .csrfToken;
  if (cookie === undefined || typeof csrfToken !== 'string') {
    throw new Error('Synthetic login did not return a session.');
  }
  return { cookie, csrfToken };
}

function createMultipartUpload(
  boundary: string,
  filename: string,
  file: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: text/csv',
        '',
        '',
      ].join('\r\n'),
      'ascii',
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'ascii'),
  ]);
}

function authenticatedUpload(
  targetServer: Server,
  session: { cookie: string; csrfToken: string },
  boundary: string,
  body: Buffer,
): Promise<string> {
  return rawRequest(
    targetServer,
    createHttpRequest('POST', '/api/v1/imports/amazon', body, [
      `Origin: ${configuration.origin}`,
      `Cookie: ${session.cookie}`,
      `X-Finance-CSRF: ${session.csrfToken}`,
      `Content-Type: multipart/form-data; boundary=${boundary}`,
    ]),
  );
}

function createHttpRequest(
  method: string,
  pathname: string,
  body: Buffer,
  headers: readonly string[],
): Buffer {
  return Buffer.concat([
    Buffer.from(
      [
        `${method} ${pathname} HTTP/1.1`,
        'Host: 127.0.0.1:4100',
        ...headers,
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
      'ascii',
    ),
    body,
  ]);
}

function listen(targetServer: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    targetServer.once('error', reject);
    targetServer.listen(0, '127.0.0.1', resolve);
  });
}

function close(targetServer: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    targetServer.close(error =>
      error === undefined ? resolve() : reject(error),
    ),
  );
}

function rawRequest(targetServer: Server, message: Buffer): Promise<string> {
  const port = getServerPort(targetServer);
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

function connectSocket(targetServer: Server): Promise<Socket> {
  const port = getServerPort(targetServer);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () =>
      resolve(socket),
    );
    socket.on('error', reject);
  });
}

async function waitForTemporaryUploadState(
  shouldHaveEntries: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const hasEntries =
      (await readdir(uploadTemporaryParentDirectory)).length > 0;
    if (hasEntries === shouldHaveEntries) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The temporary upload state did not settle.');
}

function getServerPort(targetServer: Server): number {
  const address = targetServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server did not expose an IPv4 address.');
  }
  return address.port;
}
