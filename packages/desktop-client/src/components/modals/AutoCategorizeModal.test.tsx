import { isValidElement } from 'react';
import type {
  ChangeEvent,
  ComponentProps,
  CSSProperties,
  ReactNode,
} from 'react';

import { q } from '@actual-app/core/shared/query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { AutoCategorizeModal } from './AutoCategorizeModal';

const mocks = vi.hoisted(() => ({
  aqlQuery: vi.fn(),
  send: vi.fn(),
  serializedSettings: '',
}));

function renderTranslationChildren(children: ReactNode): ReactNode {
  if (Array.isArray(children)) {
    return children.map(renderTranslationChildren);
  }
  if (
    children !== null &&
    typeof children === 'object' &&
    !isValidElement(children)
  ) {
    return Object.values(children).join('');
  }
  return children;
}

vi.mock('react-i18next', () => ({
  Trans: ({ children }: { children: ReactNode }) => (
    <>{renderTranslationChildren(children)}</>
  ),
  useTranslation: () => ({
    t: (value: string, options?: Record<string, string | number>) =>
      Object.entries(options ?? {}).reduce(
        (translatedValue, [key, replacement]) =>
          translatedValue.replace(`{{${key}}}`, String(replacement)),
        value,
      ),
  }),
}));

vi.mock('@actual-app/components/button', () => ({
  Button: ({
    children,
    isDisabled,
    onPress,
  }: {
    children: ReactNode;
    isDisabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={isDisabled} onClick={onPress} type="button">
      {children}
    </button>
  ),
}));

vi.mock('@actual-app/components/input', () => ({
  Input: (props: ComponentProps<'input'>) => <input {...props} />,
}));

vi.mock('@actual-app/components/select', () => ({
  Select: ({
    id,
    onChange,
    options,
    value,
    style,
  }: {
    id: string;
    onChange: (value: string) => void;
    options: Array<readonly [string, string]>;
    value: string;
    style?: CSSProperties;
  }) => (
    <select
      id={id}
      onChange={event => onChange(event.currentTarget.value)}
      style={style}
      value={value}
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('@actual-app/components/text', () => ({
  Text: ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => <div style={style}>{children}</div>,
}));

vi.mock('@actual-app/components/theme', () => ({ theme: {} }));

vi.mock('@actual-app/components/view', () => ({
  View: ({
    children,
    style,
    ...props
  }: {
    children: ReactNode;
    style?: CSSProperties;
  } & ComponentProps<'div'>) => (
    <div
      {...props}
      style={Object.fromEntries(
        Object.entries(style ?? {}).filter(
          ([property]) => !property.startsWith('@'),
        ),
      )}
    >
      {children}
    </div>
  ),
}));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mocks.send,
}));

vi.mock('#components/alerts', () => ({
  Information: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('#components/common/Modal', () => ({
  Modal: ({
    children,
  }: {
    children:
      | ReactNode
      | ((props: { state: { close: () => void } }) => ReactNode);
  }) => (
    <div>
      {typeof children === 'function'
        ? children({ state: { close: vi.fn() } })
        : children}
    </div>
  ),
  ModalButtons: ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => (
    <div data-testid="modal-buttons" style={style}>
      {children}
    </div>
  ),
  ModalCloseButton: () => null,
  ModalHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('#components/FinancialText', () => ({
  FinancialText: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('#components/forms', () => ({
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormLabel: ({ htmlFor, title }: { htmlFor?: string; title: string }) => (
    <label htmlFor={htmlFor}>{title}</label>
  ),
}));

vi.mock('#components/forms/LabeledCheckbox', () => ({
  LabeledCheckbox: ({
    checked,
    children,
    id,
    onChange,
    style,
  }: {
    checked: boolean;
    children: ReactNode;
    id: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    style?: CSSProperties;
  }) => (
    <label htmlFor={id} style={style}>
      <input checked={checked} id={id} onChange={onChange} type="checkbox" />
      {children}
    </label>
  ),
}));

vi.mock('#hooks/useCategories', () => ({
  useCategories: () => ({
    data: {
      grouped: [
        {
          categories: [
            {
              id: 'groceries',
              is_income: false,
              name: 'Groceries and household supplies with an intentionally long category name',
            },
          ],
          hidden: false,
          is_income: false,
        },
        {
          categories: [{ id: 'income', is_income: true, name: 'Income' }],
          hidden: false,
          is_income: true,
        },
      ],
      list: [
        {
          id: 'groceries',
          is_income: false,
          name: 'Groceries and household supplies with an intentionally long category name',
        },
        { id: 'income', is_income: true, name: 'Income' },
      ],
    },
  }),
}));

vi.mock('#hooks/useFormat', () => ({
  useFormat: () =>
    Object.assign((value: number) => String(value), {
      currency: { code: 'USD', decimalPlaces: 2 },
    }),
}));

vi.mock('#hooks/useSyncedPref', () => ({
  useSyncedPref: () => [mocks.serializedSettings],
}));

vi.mock('#hooks/useUndo', () => ({
  useUndo: () => ({ showUndoNotification: vi.fn(), undo: vi.fn() }),
}));

vi.mock('#queries/aqlQuery', () => ({ aqlQuery: mocks.aqlQuery }));

describe('AutoCategorizeModal selected scope', () => {
  beforeEach(() => {
    mocks.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries', 'income'],
      masterPrompt: 'Choose a category.',
      model: 'gpt-5.6-luna',
    });

    mocks.aqlQuery.mockReset();
    mocks.send.mockReset();
    mocks.aqlQuery.mockImplementation(async query => {
      expect(query.serialize().filterExpressions).toEqual([
        { id: { $oneof: ['checked-expense', 'checked-income'] } },
      ]);
      return {
        data: [
          {
            account: 'account-1',
            amount: -1234,
            date: '2026-08-01',
            id: 'checked-expense',
            imported_payee:
              'Checked merchant with an intentionally long imported description that must wrap without covering review controls',
          },
          {
            account: 'account-1',
            amount: 1234,
            date: '2026-08-01',
            id: 'checked-income',
            imported_payee: 'Checked income',
          },
          {
            account: 'account-1',
            amount: -1234,
            date: '2026-08-01',
            id: 'unchecked-expense',
            imported_payee: 'Unchecked merchant',
          },
        ].filter(transaction => transaction.id !== 'unchecked-expense'),
      };
    });
    mocks.send.mockImplementation(
      async (
        _name: string,
        payload: { candidates: Array<{ candidate_id: string }> },
      ) => ({
        proposals: payload.candidates.map(candidate => ({
          candidate_id: candidate.candidate_id,
          category_id: 'groceries',
          confidence: 'high',
          explanation:
            'Merchant match supported by a deliberately long synthetic explanation that must remain readable without overlapping the category selector or confidence label.',
        })),
      }),
    );
  });

  it('discloses selected, eligible, and skipped counts and sends no unchecked fields', async () => {
    const user = userEvent.setup();
    const categorizationInstructions =
      '\nPrefer the category guidance.\n\nKeep uncertain rows for review.\n';
    mocks.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries', 'income'],
      masterPrompt: categorizationInstructions,
      model: 'gpt-4.1-mini',
    });
    render(
      <AutoCategorizeModal
        currentQuery="{}"
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={['checked-expense', 'checked-income']}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );

    expect(
      await screen.findByText(
        /Requested selected transactions: 2\. Eligible transactions: 2\./,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Skipped ineligible selected rows: 0\./),
    ).toBeVisible();
    expect(screen.getByText(/unchecked transactions are sent/)).toBeVisible();

    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Generate suggestions' }),
    );

    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith(
        'finance-categorize',
        expect.objectContaining({
          categorization_instruction: categorizationInstructions,
          model: 'gpt-4.1-mini',
          candidates: [
            expect.objectContaining({
              description:
                'Checked merchant with an intentionally long imported description that must wrap without covering review controls',
            }),
            expect.objectContaining({ description: 'Checked income' }),
          ],
        }),
      );
    });
    expect(await screen.findByText('Inflow')).toBeVisible();
    expect(screen.getByText('Outflow')).toBeVisible();
    expect(screen.getByText('+1234')).toBeVisible();
    expect(
      screen.getAllByText('Current: Uncategorized')[0].parentElement,
    ).toHaveStyle({
      flexWrap: 'wrap',
      gap: '8px',
    });
    expect(
      screen.getByText(
        'Checked merchant with an intentionally long imported description that must wrap without covering review controls',
      ),
    ).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(
      screen.getAllByText(
        'Merchant match supported by a deliberately long synthetic explanation that must remain readable without overlapping the category selector or confidence label.',
      )[0],
    ).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(
      screen.getAllByRole('option', {
        name: 'Groceries and household supplies with an intentionally long category name',
      }),
    ).not.toHaveLength(0);
    expect(screen.getByTestId('modal-buttons')).toHaveStyle({
      flexWrap: 'wrap',
      gap: '8px',
    });
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(
      'Unchecked merchant',
    );
  });

  it('explains zero-value rows that are skipped from a mixed selected scope', async () => {
    const user = userEvent.setup();
    mocks.aqlQuery.mockImplementationOnce(async query => {
      expect(query.serialize().filterExpressions).toEqual([
        {
          id: {
            $oneof: ['checked-expense', 'checked-income', 'checked-zero'],
          },
        },
      ]);
      return {
        data: [
          {
            account: 'account-1',
            amount: -1234,
            date: '2026-08-01',
            id: 'checked-expense',
            imported_payee: 'Checked merchant',
          },
          {
            account: 'account-1',
            amount: 1234,
            date: '2026-08-01',
            id: 'checked-income',
            imported_payee: 'Checked income',
          },
          {
            account: 'account-1',
            amount: 0,
            date: '2026-08-01',
            id: 'checked-zero',
            imported_payee: 'Zero-value row',
          },
        ],
      };
    });

    render(
      <AutoCategorizeModal
        currentQuery="{}"
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={[
          'checked-expense',
          'checked-income',
          'checked-zero',
        ]}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );

    expect(
      await screen.findByText(
        /Requested selected transactions: 3\. Eligible transactions: 2\./,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Skipped ineligible selected rows: 1\./),
    ).toBeVisible();
    expect(screen.getByText('Skipped reasons: zero amount: 1')).toBeVisible();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('updates the disclosure when the user deliberately changes scope', async () => {
    const user = userEvent.setup();
    mocks.aqlQuery.mockResolvedValue({
      data: [
        {
          account: 'account-1',
          amount: -4321,
          date: '2026-08-01',
          id: 'filtered-expense',
          imported_payee: 'Filtered merchant',
        },
      ],
    });
    render(
      <AutoCategorizeModal
        currentQuery={q('transactions').serializeAsString()}
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={['checked-expense', 'checked-income']}
      />,
    );

    await user.selectOptions(screen.getByRole('combobox'), 'current-filter');
    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );

    expect(
      await screen.findByText(
        /Requested transactions: 1\. Eligible transactions: 1\./,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/transactions outside this chosen scope are sent/),
    ).toBeVisible();
    expect(screen.queryByText(/unchecked transactions are sent/)).toBeNull();
  });

  it('keeps proposal selections independent when rows are unchecked and rechecked', async () => {
    const user = userEvent.setup();
    render(
      <AutoCategorizeModal
        currentQuery="{}"
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={['checked-expense', 'checked-income']}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Generate suggestions' }),
    );

    const expenseProposal = await screen.findByRole('checkbox', {
      name: 'Checked merchant with an intentionally long imported description that must wrap without covering review controls',
    });
    const incomeProposal = screen.getByRole('checkbox', {
      name: 'Checked income',
    });
    expect(expenseProposal).toBeChecked();
    expect(incomeProposal).toBeChecked();
    await user.click(expenseProposal);
    expect(expenseProposal).not.toBeChecked();
    expect(incomeProposal).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Apply 1 categories' }),
    ).toBeEnabled();

    await user.click(incomeProposal);
    expect(incomeProposal).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Apply 0 categories' }),
    ).toBeDisabled();

    await user.click(expenseProposal);
    expect(expenseProposal).toBeChecked();
    expect(incomeProposal).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Apply 1 categories' }),
    ).toBeEnabled();
  });

  it('shows at most ten detailed proposals on each review page', async () => {
    const user = userEvent.setup();
    const transactionIds = Array.from(
      { length: 11 },
      (_, index) => `proposal-${index + 1}`,
    );
    mocks.aqlQuery.mockResolvedValue({
      data: transactionIds.map((id, index) => ({
        account: 'account-1',
        amount: -1234,
        date: '2026-08-01',
        id,
        imported_payee: `Long proposal merchant ${index + 1}`,
      })),
    });
    render(
      <AutoCategorizeModal
        currentQuery="{}"
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={transactionIds}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Generate suggestions' }),
    );

    expect(await screen.findByText('Page 1 of 2')).toBeVisible();
    expect(screen.getAllByTestId('categorization-review-row')).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeVisible();
    expect(screen.getAllByTestId('categorization-review-row')).toHaveLength(1);
  });

  it('shows a clear model-rejection error without creating proposals', async () => {
    const user = userEvent.setup();
    mocks.send.mockResolvedValue({ error: 'provider-request-failed' });
    render(
      <AutoCategorizeModal
        currentQuery="{}"
        initialScope="selected"
        onApplied={vi.fn()}
        onCreateRule={vi.fn()}
        selectedTransactionIds={['checked-expense', 'checked-income']}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: 'Review eligible transactions' }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I understand and want to generate suggestions for this run',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Generate suggestions' }),
    );

    expect(
      await screen.findByText(
        'OpenAI rejected the selected model or request. Choose another compatible model or refresh the model list. No transactions were changed.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/suggestions selected/i)).toBeNull();
  });
});
