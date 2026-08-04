import { createReceiptOcrImage } from './image';
import { paddleOcrCreateOptions } from './paddleOcrAssets';
import { createReceiptOcrDraft } from './receiptParser';
import type {
  ExtractReceiptTextOptions,
  ReceiptOcrClient,
  ReceiptOcrEngine,
} from './types';

const defaultTimeoutMs = 30_000;

export class ReceiptOcrTimeoutError extends Error {
  constructor() {
    super('Receipt text extraction timed out.');
    this.name = 'ReceiptOcrTimeoutError';
  }
}

export class ReceiptOcrStaleResultError extends Error {
  constructor() {
    super('A newer receipt extraction request replaced this result.');
    this.name = 'ReceiptOcrStaleResultError';
  }
}

export class ReceiptOcrDisposedError extends Error {
  constructor() {
    super('The receipt OCR client has been disposed.');
    this.name = 'ReceiptOcrDisposedError';
  }
}

export function createReceiptOcrClient(): ReceiptOcrClient {
  assertSameOriginPaddleAssets();
  let enginePromise: Promise<ReceiptOcrEngine> | undefined;
  let resolvedEngine: ReceiptOcrEngine | undefined;
  let engineDisposalPromise: Promise<void> | undefined;
  let newestRequestId = 0;
  let isDisposed = false;

  async function getEngine(): Promise<ReceiptOcrEngine> {
    if (isDisposed) return Promise.reject(new ReceiptOcrDisposedError());
    enginePromise ??= import('@paddleocr/paddleocr-js')
      .then(({ PaddleOCR }) =>
        PaddleOCR.create({ ...paddleOcrCreateOptions, worker: true }),
      )
      .then(engine => {
        resolvedEngine = engine;
        if (isDisposed) void disposeEngine(engine);
        return engine;
      });
    void enginePromise.catch(() => {});
    return enginePromise;
  }

  function disposeEngine(engine: ReceiptOcrEngine): Promise<void> {
    engineDisposalPromise ??= Promise.resolve()
      .then(() => engine.dispose())
      .then(
        () => {},
        () => {},
      );
    return engineDisposalPromise;
  }

  return {
    async extractReceiptText(file, options = {}) {
      if (isDisposed) throw new ReceiptOcrDisposedError();
      const requestId = ++newestRequestId;
      const image = await awaitReceiptOcrImage(
        createReceiptOcrImage(file, options.rotationDegrees ?? 0),
        options.signal,
      );
      let isRequestActive = true;
      try {
        const [result] = await awaitReceiptOperation(
          getEngine().then(engine => {
            if (isDisposed) throw new ReceiptOcrDisposedError();
            if (!isRequestActive || requestId !== newestRequestId) {
              throw new ReceiptOcrStaleResultError();
            }
            return engine.predict(image);
          }),
          options.signal,
          () => {
            isRequestActive = false;
          },
        );
        if (isDisposed) throw new ReceiptOcrDisposedError();
        if (requestId !== newestRequestId)
          throw new ReceiptOcrStaleResultError();
        if (!result) throw new Error('Receipt OCR returned no result.');
        const draft = createReceiptOcrDraft(result, {
          budgetCurrency: options.budgetCurrency,
          dateOrder: options.dateOrder,
        });
        const sourceHash = await createReceiptSourceHash(file);
        if (isDisposed) throw new ReceiptOcrDisposedError();
        if (requestId !== newestRequestId)
          throw new ReceiptOcrStaleResultError();
        return { ...draft, sourceHash };
      } finally {
        isRequestActive = false;
        image.close();
      }
    },
    async dispose() {
      if (isDisposed) return;
      isDisposed = true;
      newestRequestId += 1;
      if (resolvedEngine) void disposeEngine(resolvedEngine);
      else if (enginePromise) {
        void enginePromise.then(
          engine => disposeEngine(engine),
          () => {},
        );
      }
    },
  };
}

export async function createReceiptSourceHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function extractReceiptText(
  file: File,
  options?: ExtractReceiptTextOptions,
) {
  const client = createReceiptOcrClient();
  try {
    return await client.extractReceiptText(file, options);
  } finally {
    await client.dispose();
  }
}

function assertSameOriginPaddleAssets(): void {
  const origin = globalThis.location?.origin;
  if (!origin)
    throw new Error(
      'Receipt OCR requires a browser origin for local-only assets.',
    );
  for (const url of [
    paddleOcrCreateOptions.ortOptions.wasmPaths,
    paddleOcrCreateOptions.textDetectionModelAsset.url,
    paddleOcrCreateOptions.textRecognitionModelAsset.url,
  ]) {
    if (new URL(url, origin).origin !== origin)
      throw new Error(
        'Receipt OCR assets must be served from the current origin.',
      );
  }
}

async function awaitReceiptOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onInterruption?: () => void,
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onInterruption?.();
      reject(new ReceiptOcrTimeoutError());
    }, defaultTimeoutMs);
    if (signal) {
      const abort = () => {
        onInterruption?.();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', abort);
    }
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}

async function awaitReceiptOcrImage(
  operation: Promise<ImageBitmap>,
  signal: AbortSignal | undefined,
): Promise<ImageBitmap> {
  let didReceiveImage = false;
  try {
    const image = await awaitReceiptOperation(operation, signal);
    didReceiveImage = true;
    return image;
  } finally {
    if (!didReceiveImage) {
      void operation
        .then(
          image => image.close(),
          () => {},
        )
        .catch(() => {});
    }
  }
}
