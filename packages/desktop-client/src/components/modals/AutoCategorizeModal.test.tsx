import { isValidElement } from 'react';
import type { ChangeEvent, ComponentProps, ReactNode } from 'react';

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
  }: {
    id: string;
    onChange: (value: string) => void;
    options: Array<readonly [string, string]>;
    value: string;
  }) => (
    <select
      id={id}
      onChange={event => onChange(event.currentTarget.value)}
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
  Text: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@actual-app/components/theme', () => ({ theme: {} }));

vi.mock('@actual-app/components/view', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  ModalButtons: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ModalCloseButton: () => null,
  ModalHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('#components/FinancialText', () => ({
  FinancialText: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('#components/forms', () => ({
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormLabel: ({ title }: { title: string }) => <label>{title}</label>,
}));

vi.mock('#components/forms/LabeledCheckbox', () => ({
  LabeledCheckbox: ({
    checked,
    children,
    id,
    onChange,
  }: {
    checked: boolean;
    children: ReactNode;
    id: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  }) => (
    <label htmlFor={id}>
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
            { id: 'groceries', is_income: false, name: 'Groceries' },
          ],
          hidden: false,
          is_income: false,
        },
      ],
      list: [{ id: 'groceries', is_income: false, name: 'Groceries' }],
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
      categoryIds: ['groceries'],
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
          explanation: 'Merchant match.',
        })),
      }),
    );
  });

  it('discloses selected, eligible, and skipped counts and sends no unchecked fields', async () => {
    const user = userEvent.setup();
    mocks.serializedSettings = JSON.stringify({
      categoryGuidance: {},
      categoryIds: ['groceries'],
      masterPrompt: 'Choose a category.',
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
      screen.getByRole('button', { name: 'Review eligible expenses' }),
    );

    expect(
      await screen.findByText(
        /Selected transactions: 2\. Eligible expenses: 1\./,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Skipped ineligible selected rows: 1\./),
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
          model: 'gpt-4.1-mini',
          candidates: [
            expect.objectContaining({ description: 'Checked merchant' }),
          ],
        }),
      );
    });
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(
      'checked-income',
    );
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(
      'Unchecked merchant',
    );
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
      screen.getByRole('button', { name: 'Review eligible expenses' }),
    );

    expect(await screen.findByText(/Eligible expenses: 1\./)).toBeVisible();
    expect(
      screen.getByText(/transactions outside this chosen scope are sent/),
    ).toBeVisible();
    expect(screen.queryByText(/unchecked transactions are sent/)).toBeNull();
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
      screen.getByRole('button', { name: 'Review eligible expenses' }),
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
