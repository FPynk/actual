import {
  FinanceCompanionConfigurationError,
  loadFinanceCompanionConfiguration,
} from '#config';

function validEnvironment(): Record<string, string> {
  return {
    FINANCE_COMPANION_DATA_DIR: 'C:\\companion-data',
    FINANCE_COMPANION_ACTUAL_API_DIR: 'C:\\actual-api',
    FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH: 'C:\\integrity.anchor',
    FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE: 'C:\\integrity.key',
    FINANCE_COMPANION_ACTUAL_SERVER_URL: 'https://actual.example.test',
    FINANCE_COMPANION_ACTUAL_BUDGET_ID: 'budget-id',
    FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY: 'USD',
    FINANCE_COMPANION_ACTUAL_PASSWORD: 'development-password',
  };
}

const directSecretEnvironmentNames = [
  'FINANCE_COMPANION_ACTUAL_PASSWORD',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD',
  'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL',
] as const;

describe('loadFinanceCompanionConfiguration', () => {
  it('validates the frozen names and syntax without inspecting paths', () => {
    expect(loadFinanceCompanionConfiguration(validEnvironment())).toEqual({
      bindAddress: '127.0.0.1',
      port: 4100,
      origin: 'http://127.0.0.1:4100',
    });
  });

  it('rejects unknown names without reading their values', () => {
    const environment = new Proxy(
      {
        ...validEnvironment(),
        FINANCE_COMPANION_MISSPELLED_SECURITY_SETTING: 'secret-value',
      },
      {
        get(target, property, receiver) {
          if (property === 'FINANCE_COMPANION_MISSPELLED_SECURITY_SETTING') {
            throw new Error('unknown value must not be read');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(() => loadFinanceCompanionConfiguration(environment)).toThrow(
      'Unknown configuration key: FINANCE_COMPANION_MISSPELLED_SECURITY_SETTING.',
    );
  });

  it('does not disclose values in validation errors', () => {
    const environment = {
      ...validEnvironment(),
      FINANCE_COMPANION_PORT: 'private-port-value',
    };
    expect(() => loadFinanceCompanionConfiguration(environment)).toThrow(
      FinanceCompanionConfigurationError,
    );
    expect(() => loadFinanceCompanionConfiguration(environment)).not.toThrow(
      'private-port-value',
    );
  });

  it('rejects an empty configured secret-file path without reading a file', () => {
    const environment = {
      ...validEnvironment(),
      FINANCE_COMPANION_ACTUAL_PASSWORD: undefined,
      FINANCE_COMPANION_ACTUAL_PASSWORD_FILE: '',
    };
    expect(() => loadFinanceCompanionConfiguration(environment)).toThrow(
      'Invalid configuration for FINANCE_COMPANION_ACTUAL_PASSWORD_FILE.',
    );
  });

  it('accepts an injected readonly environment without mutating it', () => {
    const environment = Object.freeze(validEnvironment());
    expect(loadFinanceCompanionConfiguration(environment)).toEqual({
      bindAddress: '127.0.0.1',
      port: 4100,
      origin: 'http://127.0.0.1:4100',
    });
    expect(environment.FINANCE_COMPANION_ACTUAL_PASSWORD).toBe(
      'development-password',
    );
  });

  it('removes direct secrets from process.env after successful loading', () => {
    withSyntheticProcessEnvironment({}, () => {
      expect(loadFinanceCompanionConfiguration()).toEqual({
        bindAddress: '127.0.0.1',
        port: 4100,
        origin: 'http://127.0.0.1:4100',
      });
      for (const secretEnvironmentName of directSecretEnvironmentNames) {
        expect(process.env[secretEnvironmentName]).toBeUndefined();
      }
    });
  });

  it('removes direct secrets from process.env when validation fails', () => {
    withSyntheticProcessEnvironment(
      { FINANCE_COMPANION_PORT: 'invalid-port' },
      () => {
        expect(() => loadFinanceCompanionConfiguration()).toThrow(
          'Invalid configuration for FINANCE_COMPANION_PORT.',
        );
        for (const secretEnvironmentName of directSecretEnvironmentNames) {
          expect(process.env[secretEnvironmentName]).toBeUndefined();
        }
      },
    );
  });

  it.each([
    ['FINANCE_COMPANION_BIND_ADDRESS', 'localhost'],
    ['FINANCE_COMPANION_PORT', '1023'],
    ['FINANCE_COMPANION_ORIGIN', 'http://localhost:4100'],
    ['FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY', 'usd'],
  ])('rejects invalid %s syntax', (name, value) => {
    const environment = validEnvironment();
    environment[name] = value;
    expect(() => loadFinanceCompanionConfiguration(environment)).toThrow(
      FinanceCompanionConfigurationError,
    );
  });
});

function withSyntheticProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
  runAssertion: () => void,
): void {
  const syntheticEnvironment = {
    ...validEnvironment(),
    FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD:
      'synthetic-budget-secret',
    FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL: 'synthetic-owner-secret',
    ...overrides,
  };
  const originalValues = new Map(
    Object.keys(syntheticEnvironment).map(name => [name, process.env[name]]),
  );

  try {
    Object.assign(process.env, syntheticEnvironment);
    runAssertion();
  } finally {
    for (const [name, originalValue] of originalValues) {
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  }
}
