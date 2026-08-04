import { isValidElement } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { NativeReceiptsPage } from './NativeReceiptsPage';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  search: '',
  testOcrClient: {
    dispose: vi.fn(),
    extractReceiptText: vi.fn(),
  },
}));

function translationChildren(children: ReactNode): ReactNode {
  if (Array.isArray(children)) return children.map(translationChildren);
  if (children && typeof children === 'object' && !isValidElement(children)) {
    return Object.values(children).join('');
  }
  return children;
}

vi.mock('react-i18next', () => ({
  Trans: ({ children }: { children: ReactNode }) => (
    <>{translationChildren(children)}</>
  ),
  useTranslation: () => ({
    t: (value: string, options?: Record<string, string | number>) =>
      Object.entries(options ?? {}).reduce(
        (result, [key, replacement]) =>
          result.replace(`{{${key}}}`, String(replacement)),
        value,
      ),
  }),
}));

vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(mocks.search)],
}));

vi.mock('@actual-app/components/button', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
    ...props
  }: {
    children: ReactNode;
    isDisabled?: boolean;
    onPress?: () => void;
  } & ComponentProps<'button'>) => (
    <button {...props} disabled={isDisabled} onClick={onPress} type="button">
      {children}
    </button>
  ),
}));

vi.mock('@actual-app/components/input', () => ({
  Input: ({
    onChangeValue,
    ...props
  }: {
    onChangeValue?: (value: string) => void;
  } & ComponentProps<'input'>) => (
    <input
      {...props}
      onChange={event => onChangeValue?.(event.currentTarget.value)}
    />
  ),
}));

vi.mock('@actual-app/components/text', () => ({
  Text: ({
    children,
    ...props
  }: { children: ReactNode } & ComponentProps<'div'>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock('@actual-app/components/theme', () => ({
  theme: {
    errorText: 'red',
    formInputBorder: 'gray',
    noticeBackground: 'yellow',
    noticeText: 'goldenrod',
    pageTextSubdued: 'gray',
    tableBackground: 'white',
    tableBorder: 'gray',
    tableRowBackgroundHover: 'lightgray',
    tableText: 'black',
  },
}));

vi.mock('@actual-app/components/view', () => ({
  View: ({
    children,
    style,
    ...props
  }: {
    children: ReactNode;
    style?: CSSProperties;
  } & ComponentProps<'div'>) => (
    <div {...props} style={style}>
      {children}
    </div>
  ),
}));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mocks.send,
}));
vi.mock('#components/Page', () => ({
  Page: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('#hooks/useDateFormat', () => ({ useDateFormat: () => 'MM/dd/yyyy' }));
vi.mock('#hooks/useFormat', () => ({
  useFormat: () =>
    Object.assign((value: number) => String(value), {
      currency: { code: 'USD', decimalPlaces: 2 },
    }),
}));
vi.mock('#hooks/useMetadataPref', () => ({
  useMetadataPref: () => ['budget-1'],
}));
vi.mock('../../receipt-ocr/receiptOcr', () => ({
  createReceiptOcrClient: vi.fn(() => mocks.testOcrClient),
}));

function ocrDraft(overrides = {}) {
  return {
    corrections: [{ corrected: 'Redeem', lineIndex: 0, original: 'Redeen' }],
    currency: 'USD',
    fieldConfidence: { total: 0.92 },
    lineItems: [{ amount: 345, label: 'Apples', quantity: 1 }],
    merchant: 'Neighborhood Market',
    ocrRevision: 'ocr-v1',
    parserRevision: 'parser-v1',
    paymentHint: null,
    purchaseDate: '2026-08-04',
    purchaseTime: null,
    rawTranscript: 'Neighborhood Market\nTOTAL 3.45',
    redactedTranscript: 'Neighborhood Market\nTOTAL 3.45',
    sourceHash: 'source-hash',
    subtotal: null,
    tax: null,
    tip: null,
    total: 345,
    transcript: 'Neighborhood Market\nTOTAL 3.45',
    warnings: ['low-confidence-merchant'],
    ...overrides,
  };
}

function savedReceipt(overrides = {}) {
  return {
    ...ocrDraft(),
    createdAt: '2026-08-04T00:00:00.000Z',
    fingerprint: 'receipt-fingerprint',
    id: 'receipt-1',
    linkConflict: false,
    reviewedAt: '2026-08-04T00:00:00.000Z',
    transcriptRevision: 1,
    transactionId: null,
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('NativeReceiptsPage', () => {
  beforeEach(() => {
    mocks.search = '';
    mocks.send.mockReset();
    mocks.send.mockImplementation(name => {
      if (name === 'receipts/list') return Promise.resolve([]);
      if (name === 'receipts/match-candidates') {
        return Promise.resolve({
          candidates: [],
          exclusions: [],
          manualSelectionReasons: [],
          preselectedTransactionId: null,
        });
      }
      throw new Error(`Unexpected handler ${name}`);
    });
    mocks.testOcrClient.dispose.mockReset();
    mocks.testOcrClient.extractReceiptText.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(file => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    });
  });

  it('processes a multi-file queue sequentially and continues after a failed receipt', async () => {
    let resolveFirst:
      | ((value: ReturnType<typeof ocrDraft>) => void)
      | undefined;
    mocks.testOcrClient.extractReceiptText
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('unreadable'))
      .mockResolvedValueOnce(ocrDraft({ merchant: 'Third market' }));
    render(<NativeReceiptsPage />);

    fireEvent.change(screen.getByLabelText('Upload receipt images'), {
      target: {
        files: [
          new File(['one'], 'one.png', { type: 'image/png' }),
          new File(['two'], 'two.png', { type: 'image/png' }),
          new File(['three'], 'three.png', { type: 'image/png' }),
        ],
      },
    });

    await waitFor(() =>
      expect(mocks.testOcrClient.extractReceiptText).toHaveBeenCalledTimes(1),
    );
    expect(mocks.testOcrClient.extractReceiptText).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'one.png' }),
      expect.objectContaining({ rotationDegrees: 0 }),
    );

    resolveFirst?.(ocrDraft());
    await waitFor(() =>
      expect(mocks.testOcrClient.extractReceiptText).toHaveBeenCalledTimes(3),
    );
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'three.png' }));
    expect(await screen.findByDisplayValue('Third market')).toBeInTheDocument();
    expect(
      screen.getByText('Receipt queue: 2 of 3 completed'),
    ).toBeInTheDocument();
  });

  it('keeps review fields editable, shows the locale placeholder and can continue manually after failure', async () => {
    const user = userEvent.setup();
    mocks.testOcrClient.extractReceiptText.mockRejectedValueOnce(
      new Error('unreadable'),
    );
    render(<NativeReceiptsPage />);

    fireEvent.change(screen.getByLabelText('Upload receipt images'), {
      target: { files: [new File(['bad'], 'bad.png', { type: 'image/png' })] },
    });
    await screen.findByText('Failed');
    await user.click(
      screen.getByRole('button', { name: 'Enter receipt text manually' }),
    );

    expect(screen.getByLabelText('Date')).toHaveAttribute(
      'placeholder',
      'MM/DD/YYYY',
    );
    await user.type(screen.getByLabelText('Merchant'), 'Manual Market');
    await user.type(
      screen.getByLabelText('OCR transcript'),
      'Manual receipt text',
    );
    expect(screen.getByLabelText('Merchant')).toHaveValue('Manual Market');
    expect(screen.getByLabelText('OCR transcript')).toHaveValue(
      'Manual receipt text',
    );
  });

  it('cancels, retries, removes queue items, and releases temporary previews', async () => {
    const user = userEvent.setup();
    mocks.testOcrClient.extractReceiptText
      .mockImplementationOnce(
        (_file, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new Error('cancelled')),
            );
          }),
      )
      .mockResolvedValueOnce(ocrDraft());
    render(<NativeReceiptsPage />);

    fireEvent.change(screen.getByLabelText('Upload receipt images'), {
      target: {
        files: [new File(['receipt'], 'retry.png', { type: 'image/png' })],
      },
    });
    await screen.findByRole('button', { name: 'Cancel current receipt' });
    await user.click(
      screen.getByRole('button', { name: 'Cancel current receipt' }),
    );
    await screen.findByText('Cancelled');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByDisplayValue('Neighborhood Market');
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(
      screen.queryByRole('button', { name: 'retry.png' }),
    ).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retry.png');
  });

  it('saves reviewed text, then explicitly attaches it and surfaces conflict responses', async () => {
    const user = userEvent.setup();
    const receipt = savedReceipt();
    mocks.testOcrClient.extractReceiptText.mockResolvedValue(ocrDraft());
    mocks.send.mockImplementation(name => {
      if (name === 'receipts/list') return Promise.resolve([]);
      if (name === 'receipts/save-reviewed')
        return Promise.resolve({ receipt, status: 'saved' });
      if (name === 'receipts/match-candidates') {
        return Promise.resolve({
          candidates: [
            {
              accountId: 'account-1',
              amount: -345,
              amountScore: 50,
              candidateFingerprint: 'candidate-fingerprint',
              date: '2026-08-04',
              dateDistanceDays: 0,
              dateScore: 20,
              merchantScore: 20,
              payee: 'Neighborhood Market',
              reasons: ['exact-total', 'same-date'],
              score: 90,
              sourceScore: 0,
              transactionId: 'transaction-1',
            },
          ],
          exclusions: [],
          manualSelectionReasons: [],
          preselectedTransactionId: 'transaction-1',
        });
      }
      if (name === 'receipts/link')
        return Promise.resolve({
          conflictingReceiptId: 'other',
          status: 'conflict',
        });
      throw new Error(`Unexpected handler ${name}`);
    });
    render(<NativeReceiptsPage />);

    fireEvent.change(screen.getByLabelText('Upload receipt images'), {
      target: {
        files: [new File(['receipt'], 'receipt.png', { type: 'image/png' })],
      },
    });
    await screen.findByDisplayValue('Neighborhood Market');
    await user.click(screen.getByRole('button', { name: 'Save receipt text' }));
    await screen.findByText('Receipt text saved locally.');
    await user.click(
      await screen.findByRole('button', { name: 'Attach receipt' }),
    );
    expect(
      await screen.findByText(
        'That transaction already has a receipt. Nothing was changed.',
      ),
    ).toBeInTheDocument();
    expect(mocks.send).toHaveBeenCalledWith(
      'receipts/link',
      expect.objectContaining({
        candidateFingerprint: 'candidate-fingerprint',
        expectedBudgetId: 'budget-1',
        transactionId: 'transaction-1',
      }),
    );
  });
});
