import { createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';

import express from 'express';
import type { Express } from 'express';

import { createFinanceCompanionHealth } from '#service/health';

type FinanceCompanionListenerConfiguration = Readonly<{
  bindAddress: string;
  port: number;
}>;

export function createFinanceCompanionHttpApplication(
  configuration: FinanceCompanionListenerConfiguration,
  staticUiDirectory: string,
): Express {
  if (configuration.bindAddress !== '127.0.0.1') {
    throw new Error(
      'Finance Companion only supports the 127.0.0.1 bind address.',
    );
  }
  const application = express();
  application.disable('x-powered-by');
  application.use((request, response, next) => {
    if (
      request.socket.remoteAddress !== '127.0.0.1' ||
      !hasExactlyOneExpectedHostHeader(
        request.rawHeaders,
        `127.0.0.1:${configuration.port}`,
      )
    ) {
      response.status(400).type('text/plain').send('Bad Request');
      return;
    }
    next();
  });
  application.get('/health', (_request, response) =>
    response.json(createFinanceCompanionHealth()),
  );
  application.use(express.static(path.resolve(staticUiDirectory)));
  return application;
}

function hasExactlyOneExpectedHostHeader(
  rawHeaders: readonly string[],
  expectedHost: string,
): boolean {
  const hostHeaderValues: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'host') {
      hostHeaderValues.push(rawHeaders[index + 1] ?? '');
    }
  }

  return hostHeaderValues.length === 1 && hostHeaderValues[0] === expectedHost;
}

export async function startFinanceCompanionHttpServer(
  configuration: FinanceCompanionListenerConfiguration,
  staticUiDirectory: string,
): Promise<Server> {
  const server = createServer(
    createFinanceCompanionHttpApplication(configuration, staticUiDirectory),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuration.port, configuration.bindAddress, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
