const CONFIGURATION_NAMES = [
  'FINANCE_COMPANION_BIND_ADDRESS',
  'FINANCE_COMPANION_PORT',
  'FINANCE_COMPANION_ORIGIN',
  'FINANCE_COMPANION_DATA_DIR',
  'FINANCE_COMPANION_ACTUAL_API_DIR',
  'FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH',
  'FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE',
  'FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE',
  'FINANCE_COMPANION_ACTUAL_SERVER_URL',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ID',
  'FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY',
  'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE',
  'FINANCE_COMPANION_ACTUAL_PASSWORD',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD',
  'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE',
  'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL',
  'FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS',
  'FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS',
  'FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS',
  'FINANCE_COMPANION_LOG_LEVEL',
] as const;

const configurationNameSet = new Set<string>(CONFIGURATION_NAMES);
type Environment = Readonly<Record<string, string | undefined>>;

const DIRECT_SECRET_ENVIRONMENT_NAMES = [
  'FINANCE_COMPANION_ACTUAL_PASSWORD',
  'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD',
  'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL',
] as const;

export type FinanceCompanionConfiguration = Readonly<{
  bindAddress: '127.0.0.1';
  port: number;
  origin: string;
}>;

export class FinanceCompanionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceCompanionConfigurationError';
  }
}

export function loadFinanceCompanionConfiguration(
  environment: Environment = process.env,
): FinanceCompanionConfiguration {
  try {
    return parseFinanceCompanionConfiguration(environment);
  } finally {
    clearDirectSecretsFromProcessEnvironment(environment);
  }
}

function parseFinanceCompanionConfiguration(
  environment: Environment,
): FinanceCompanionConfiguration {
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith('FINANCE_COMPANION_') &&
      !configurationNameSet.has(name)
    ) {
      throw new FinanceCompanionConfigurationError(
        `Unknown configuration key: ${name}.`,
      );
    }
  }
  const bindAddress = valueOrDefault(
    environment,
    'FINANCE_COMPANION_BIND_ADDRESS',
    '127.0.0.1',
  );
  if (bindAddress !== '127.0.0.1') {
    throw invalid('FINANCE_COMPANION_BIND_ADDRESS');
  }
  const port = integer(
    valueOrDefault(environment, 'FINANCE_COMPANION_PORT', '4100'),
    'FINANCE_COMPANION_PORT',
    1024,
    65535,
  );
  const origin = valueOrDefault(
    environment,
    'FINANCE_COMPANION_ORIGIN',
    `http://127.0.0.1:${port}`,
  );
  if (origin !== `http://127.0.0.1:${port}`) {
    throw invalid('FINANCE_COMPANION_ORIGIN');
  }

  for (const name of [
    'FINANCE_COMPANION_DATA_DIR',
    'FINANCE_COMPANION_ACTUAL_API_DIR',
    'FINANCE_COMPANION_INTEGRITY_ANCHOR_PATH',
    'FINANCE_COMPANION_INTEGRITY_MAC_KEY_FILE',
  ]) {
    pathSyntax(required(environment, name), name);
  }
  for (const name of [
    'FINANCE_COMPANION_BACKUP_ENCRYPTION_KEY_FILE',
    'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE',
    'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE',
    'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE',
  ]) {
    if (environment[name] !== undefined) pathSyntax(environment[name], name);
  }
  serverUrl(required(environment, 'FINANCE_COMPANION_ACTUAL_SERVER_URL'));
  required(environment, 'FINANCE_COMPANION_ACTUAL_BUDGET_ID');
  if (
    !/^[A-Z]{3}$/.test(
      required(environment, 'FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY'),
    )
  ) {
    throw invalid('FINANCE_COMPANION_ACTUAL_BUDGET_CURRENCY');
  }
  exactlyOne(
    environment,
    'FINANCE_COMPANION_ACTUAL_PASSWORD_FILE',
    'FINANCE_COMPANION_ACTUAL_PASSWORD',
  );
  atMostOne(
    environment,
    'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD_FILE',
    'FINANCE_COMPANION_ACTUAL_BUDGET_ENCRYPTION_PASSWORD',
  );
  atMostOne(
    environment,
    'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL_FILE',
    'FINANCE_COMPANION_OWNER_BOOTSTRAP_CREDENTIAL',
  );
  const softTimeout = integer(
    valueOrDefault(
      environment,
      'FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS',
      '120000',
    ),
    'FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const hardTimeout = integer(
    valueOrDefault(
      environment,
      'FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS',
      '180000',
    ),
    'FINANCE_COMPANION_ADAPTER_HARD_TIMEOUT_MS',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (softTimeout >= hardTimeout) {
    throw invalid('FINANCE_COMPANION_ADAPTER_SOFT_TIMEOUT_MS');
  }
  integer(
    valueOrDefault(
      environment,
      'FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS',
      '30000',
    ),
    'FINANCE_COMPANION_WORKER_EXIT_TIMEOUT_MS',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    !['error', 'warn', 'info', 'debug'].includes(
      valueOrDefault(environment, 'FINANCE_COMPANION_LOG_LEVEL', 'info'),
    )
  ) {
    throw invalid('FINANCE_COMPANION_LOG_LEVEL');
  }
  return { bindAddress, port, origin };
}

function clearDirectSecretsFromProcessEnvironment(
  environment: Environment,
): void {
  if (environment !== process.env) {
    return;
  }

  for (const secretEnvironmentName of DIRECT_SECRET_ENVIRONMENT_NAMES) {
    delete process.env[secretEnvironmentName];
  }
}

function valueOrDefault(
  environment: Environment,
  name: string,
  defaultValue: string,
): string {
  return environment[name] ?? defaultValue;
}
function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw invalid(name);
  return value;
}
function pathSyntax(value: string, name: string): void {
  if (value.length === 0 || value.trim() !== value || value.includes('\0')) {
    throw invalid(name);
  }
}
function exactlyOne(
  environment: Environment,
  fileName: string,
  valueName: string,
): void {
  const file = environment[fileName] !== undefined;
  const value = environment[valueName] !== undefined;
  if (file === value) throw invalid(fileName);
  if (value) required(environment, valueName);
}
function atMostOne(
  environment: Environment,
  fileName: string,
  valueName: string,
): void {
  if (
    environment[fileName] !== undefined &&
    environment[valueName] !== undefined
  ) {
    throw invalid(fileName);
  }
  if (environment[valueName] !== undefined) required(environment, valueName);
}
function integer(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw invalid(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalid(name);
  }
  return parsed;
}
function serverUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.pathname !== '/'
    ) {
      throw invalid('FINANCE_COMPANION_ACTUAL_SERVER_URL');
    }
  } catch (error) {
    if (error instanceof FinanceCompanionConfigurationError) throw error;
    throw invalid('FINANCE_COMPANION_ACTUAL_SERVER_URL');
  }
}
function invalid(name: string): FinanceCompanionConfigurationError {
  return new FinanceCompanionConfigurationError(
    `Invalid configuration for ${name}.`,
  );
}
