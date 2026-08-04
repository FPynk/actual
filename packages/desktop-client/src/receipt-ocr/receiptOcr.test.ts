import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createReceiptOcrImage } from './image';
import { paddleOcrCreateOptions } from './paddleOcrAssets';
import {
  createReceiptOcrClient,
  ReceiptOcrStaleResultError,
  ReceiptOcrTimeoutError,
} from './receiptOcr';

const { paddleOcrCreate, testEngine } = vi.hoisted(() => ({
  paddleOcrCreate: vi.fn(),
  testEngine: {
    predict: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('@paddleocr/paddleocr-js', () => ({
  PaddleOCR: { create: paddleOcrCreate },
}));

vi.mock('./image', () => ({
  createReceiptOcrImage: vi.fn(),
}));

const ocrResult = {
  items: [
    {
      poly: [
        [0, 0],
        [10, 0],
      ],
      text: 'Shop',
      score: 0.99,
    },
  ],
};

function mockReceiptImage(): void {
  vi.mocked(createReceiptOcrImage).mockResolvedValue({
    close: vi.fn(),
  } as unknown as ImageBitmap);
}

describe('createReceiptOcrClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paddleOcrCreate.mockResolvedValue(testEngine);
    testEngine.predict.mockResolvedValue([ocrResult]);
    mockReceiptImage();
  });

  it('uses one worker engine with the local Paddle asset manifest and disposes it', async () => {
    const image = { close: vi.fn() } as unknown as ImageBitmap;
    vi.mocked(createReceiptOcrImage).mockResolvedValue(image);
    const client = createReceiptOcrClient();
    const draft = await client.extractReceiptText(
      new File([], 'receipt.jpg', { type: 'image/jpeg' }),
    );

    expect(paddleOcrCreate).toHaveBeenCalledWith({
      ...paddleOcrCreateOptions,
      worker: true,
    });
    expect(
      [
        paddleOcrCreateOptions.ortOptions.wasmPaths,
        paddleOcrCreateOptions.textDetectionModelAsset.url,
        paddleOcrCreateOptions.textRecognitionModelAsset.url,
      ].every(url => new URL(url, location.origin).origin === location.origin),
    ).toBe(true);
    expect(draft.transcript).toBe('Shop');
    expect(image.close).toHaveBeenCalledOnce();

    await client.dispose();
    expect(testEngine.dispose).toHaveBeenCalledOnce();
  });

  it('honors a pre-aborted request without initializing the engine', async () => {
    const client = createReceiptOcrClient();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      client.extractReceiptText(new File([], 'receipt.jpg'), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(paddleOcrCreate).not.toHaveBeenCalled();
  });

  it('rejects an older OCR result after a newer request finishes', async () => {
    let resolveFirstPrediction: (result: readonly (typeof ocrResult)[]) => void;
    testEngine.predict
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirstPrediction = resolve;
          }),
      )
      .mockResolvedValueOnce([ocrResult]);
    const client = createReceiptOcrClient();

    const older = client.extractReceiptText(new File([], 'older.jpg'));
    await vi.waitFor(() => expect(testEngine.predict).toHaveBeenCalledTimes(1));
    const newer = client.extractReceiptText(new File([], 'newer.jpg'));
    await expect(newer).resolves.toMatchObject({ transcript: 'Shop' });
    resolveFirstPrediction!([ocrResult]);
    await expect(older).rejects.toBeInstanceOf(ReceiptOcrStaleResultError);
  });

  it('times out an image operation that never completes', async () => {
    vi.useFakeTimers();
    vi.mocked(createReceiptOcrImage).mockReturnValue(new Promise(() => {}));
    const client = createReceiptOcrClient();
    const extraction = client.extractReceiptText(new File([], 'receipt.jpg'));
    const timeoutAssertion = expect(extraction).rejects.toBeInstanceOf(
      ReceiptOcrTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutAssertion;
    vi.useRealTimers();
  });

  it('does not wait for engine creation when timing out or disposing', async () => {
    vi.useFakeTimers();
    let resolveEngine: (engine: typeof testEngine) => void;
    paddleOcrCreate.mockReturnValue(
      new Promise(resolve => {
        resolveEngine = resolve;
      }),
    );
    const client = createReceiptOcrClient();
    const extraction = client.extractReceiptText(new File([], 'receipt.jpg'));
    const timeoutAssertion = expect(extraction).rejects.toBeInstanceOf(
      ReceiptOcrTimeoutError,
    );

    await vi.waitFor(() => expect(paddleOcrCreate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutAssertion;
    await expect(client.dispose()).resolves.toBeUndefined();

    resolveEngine!(testEngine);
    await vi.waitFor(() => expect(testEngine.dispose).toHaveBeenCalledOnce());
    vi.useRealTimers();
  });

  it('closes an image that finishes decoding after cancellation', async () => {
    let resolveImage: (image: ImageBitmap) => void;
    vi.mocked(createReceiptOcrImage).mockReturnValue(
      new Promise(resolve => {
        resolveImage = resolve;
      }),
    );
    const controller = new AbortController();
    const client = createReceiptOcrClient();
    const extraction = client.extractReceiptText(new File([], 'receipt.jpg'), {
      signal: controller.signal,
    });
    const cancellation = new Error('cancelled');
    controller.abort(cancellation);

    await expect(extraction).rejects.toBe(cancellation);

    const image = { close: vi.fn() } as unknown as ImageBitmap;
    resolveImage!(image);
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
  });

  it('closes an image that finishes decoding after timing out', async () => {
    vi.useFakeTimers();
    let resolveImage: (image: ImageBitmap) => void;
    vi.mocked(createReceiptOcrImage).mockReturnValue(
      new Promise(resolve => {
        resolveImage = resolve;
      }),
    );
    const client = createReceiptOcrClient();
    const extraction = client.extractReceiptText(new File([], 'receipt.jpg'));
    const timeoutAssertion = expect(extraction).rejects.toBeInstanceOf(
      ReceiptOcrTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await timeoutAssertion;

    const image = { close: vi.fn() } as unknown as ImageBitmap;
    resolveImage!(image);
    await vi.advanceTimersByTimeAsync(0);
    expect(image.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
