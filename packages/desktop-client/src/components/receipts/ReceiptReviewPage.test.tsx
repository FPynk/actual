import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { TestProviders } from '#mocks';
import { createReceiptOcrClient } from '../../receipt-ocr/receiptOcr';

import { ReceiptReviewPage } from './ReceiptReviewPage';

const { testOcrClient } = vi.hoisted(() => ({
  testOcrClient: {
    dispose: vi.fn(),
    extractReceiptText: vi.fn(),
  },
}));

vi.mock('../../receipt-ocr/receiptOcr', () => ({
  createReceiptOcrClient: vi.fn(() => testOcrClient),
}));

function createOcrDraft(overrides = {}) {
  return {
    boxes: [],
    corrections: [],
    currency: 'USD',
    fieldConfidence: {},
    lineItems: [],
    lines: [],
    merchant: '',
    normalizedMerchant: null,
    ocrRevision: 'paddleocr-js',
    parserRevision: 'receipt-parser-v2',
    paymentHint: null,
    purchaseDate: null,
    purchaseTime: null,
    rawTranscript: '',
    redactedTranscript: '',
    sourceHash: null,
    subtotal: null,
    tax: null,
    tip: null,
    total: null,
    transcript: '',
    warnings: [],
    ...overrides,
  };
}

describe('ReceiptReviewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:receipt-preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('reviews a locally selected receipt image without saving it', async () => {
    const user = userEvent.setup();
    vi.mocked(testOcrClient.extractReceiptText).mockResolvedValue(
      createOcrDraft({
        merchant: 'Neighborhood Market',
        purchaseDate: '2026-08-04',
        total: 2345,
        transcript: 'Neighborhood Market\\nTOTAL 23.45',
        redactedTranscript: 'Neighborhood Market\\nTOTAL 23.45',
        lines: [{ polygon: [], text: 'TOTAL 23.45', confidence: 0.91 }],
      }),
    );
    render(<ReceiptReviewPage />, { wrapper: TestProviders });

    const receipt = new File(['receipt'], 'market.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload receipt image'), {
      target: { files: [receipt] },
    });

    await waitFor(() =>
      expect(testOcrClient.extractReceiptText).toHaveBeenCalledWith(
        receipt,
        expect.objectContaining({ rotationDegrees: 0 }),
      ),
    );
    expect(
      await screen.findByDisplayValue('Neighborhood Market'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-08-04')).toBeInTheDocument();
    expect(screen.getByDisplayValue('23.45')).toBeInTheDocument();
    expect(screen.getByLabelText('OCR transcript')).toHaveValue(
      'Neighborhood Market\\nTOTAL 23.45',
    );
    expect(screen.getByLabelText('Raw OCR lines')).toHaveTextContent(
      'TOTAL 23.45 (91%)',
    );

    await user.clear(screen.getByLabelText('Merchant'));
    await user.type(screen.getByLabelText('Merchant'), 'Local Market');
    await user.clear(screen.getByLabelText('OCR transcript'));
    await user.type(screen.getByLabelText('OCR transcript'), 'Reviewed text');

    expect(screen.getByLabelText('Merchant')).toHaveValue('Local Market');
    expect(screen.getByLabelText('OCR transcript')).toHaveValue(
      'Reviewed text',
    );
  });

  it('reruns OCR with the adjusted rotation', async () => {
    const user = userEvent.setup();
    vi.mocked(testOcrClient.extractReceiptText).mockResolvedValue(
      createOcrDraft(),
    );
    render(<ReceiptReviewPage />, { wrapper: TestProviders });

    const receipt = new File(['receipt'], 'market.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Upload receipt image'), {
      target: { files: [receipt] },
    });
    await screen.findByRole('button', { name: 'Rotate right' });

    await user.click(screen.getByRole('button', { name: 'Rotate right' }));

    await waitFor(() =>
      expect(testOcrClient.extractReceiptText).toHaveBeenLastCalledWith(
        receipt,
        expect.objectContaining({ rotationDegrees: 90 }),
      ),
    );
    expect(createReceiptOcrClient).toHaveBeenCalledOnce();
  });

  it('rejects unsupported images before invoking OCR', () => {
    render(<ReceiptReviewPage />, { wrapper: TestProviders });

    const receipt = new File(['receipt'], 'market.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByLabelText('Upload receipt image'), {
      target: { files: [receipt] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose a JPEG, PNG, or WebP image.',
    );
    expect(testOcrClient.extractReceiptText).not.toHaveBeenCalled();
  });

  it('disposes the OCR client when clearing a receipt', async () => {
    const user = userEvent.setup();
    vi.mocked(testOcrClient.extractReceiptText).mockResolvedValue(
      createOcrDraft(),
    );
    render(<ReceiptReviewPage />, { wrapper: TestProviders });

    fireEvent.change(screen.getByLabelText('Upload receipt image'), {
      target: {
        files: [new File(['receipt'], 'market.jpg', { type: 'image/jpeg' })],
      },
    });
    await screen.findByRole('button', { name: 'Cancel' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(testOcrClient.dispose).toHaveBeenCalledOnce();
  });

  it('recreates the OCR client after a current request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(testOcrClient.extractReceiptText)
      .mockRejectedValueOnce(new Error('OCR failed'))
      .mockResolvedValueOnce(createOcrDraft());
    render(<ReceiptReviewPage />, { wrapper: TestProviders });

    const receipt = new File(['receipt'], 'market.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Upload receipt image'), {
      target: { files: [receipt] },
    });
    await screen.findByRole('alert');
    expect(testOcrClient.dispose).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Rotate right' }));

    await waitFor(() =>
      expect(testOcrClient.extractReceiptText).toHaveBeenLastCalledWith(
        receipt,
        expect.objectContaining({ rotationDegrees: 90 }),
      ),
    );
    expect(createReceiptOcrClient).toHaveBeenCalledTimes(2);
  });
});
