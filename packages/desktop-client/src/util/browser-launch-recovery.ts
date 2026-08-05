const actualLaunchNonceParam = 'actual-launch';
const cleanupReloadSessionKeyPrefix = 'actual-launch-service-worker-cleanup:';
const backendRetrySessionKeyPrefix = 'actual-launch-backend-retry:';

type BrowserLocation = Pick<
  Location,
  'hostname' | 'origin' | 'search' | 'reload'
>;

type ServiceWorkerRegistration = {
  scope: string;
  unregister: () => Promise<boolean>;
};

type ServiceWorkerContainer = {
  getRegistrations?: () => Promise<readonly ServiceWorkerRegistration[]>;
};

type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;

type BrowserLaunchRecoveryEnvironment = {
  isDevelopment: boolean;
  location: BrowserLocation;
  serviceWorker?: ServiceWorkerContainer;
  sessionStorage: SessionStorage;
};

type BackendRetryEnvironment = Omit<
  BrowserLaunchRecoveryEnvironment,
  'serviceWorker'
>;

type BackendInitFailure = {
  BackendInitFailure?: boolean;
  type?: string;
};

function isLoopbackHostname(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.startsWith('127.')
  );
}

function getLauncherNavigationNonce(
  location: Pick<BrowserLocation, 'hostname' | 'search'>,
  isDevelopment: boolean,
) {
  if (!isDevelopment || !isLoopbackHostname(location.hostname)) {
    return null;
  }

  return (
    new URLSearchParams(location.search).get(actualLaunchNonceParam) || null
  );
}

function isSameOriginServiceWorker(
  registration: ServiceWorkerRegistration,
  origin: string,
) {
  try {
    return new URL(registration.scope).origin === origin;
  } catch {
    return false;
  }
}

function hasReloadGuard(sessionStorage: SessionStorage, key: string) {
  try {
    return sessionStorage.getItem(key) != null;
  } catch {
    return true;
  }
}

function claimReloadGuard(sessionStorage: SessionStorage, key: string) {
  if (hasReloadGuard(sessionStorage, key)) {
    return false;
  }

  try {
    sessionStorage.setItem(key, 'true');
    return true;
  } catch {
    return false;
  }
}

export async function reloadAfterRemovingStaleServiceWorkers(
  environment: BrowserLaunchRecoveryEnvironment,
) {
  const nonce = getLauncherNavigationNonce(
    environment.location,
    environment.isDevelopment,
  );
  if (!nonce || !environment.serviceWorker?.getRegistrations) {
    return false;
  }

  const cleanupReloadSessionKey = `${cleanupReloadSessionKeyPrefix}${nonce}`;
  if (hasReloadGuard(environment.sessionStorage, cleanupReloadSessionKey)) {
    return false;
  }

  let registrations: readonly ServiceWorkerRegistration[];
  try {
    registrations = await environment.serviceWorker.getRegistrations();
  } catch {
    return false;
  }

  const sameOriginRegistrations = registrations.filter(registration =>
    isSameOriginServiceWorker(registration, environment.location.origin),
  );
  if (sameOriginRegistrations.length === 0) {
    return false;
  }

  const outcomes = await Promise.allSettled(
    sameOriginRegistrations.map(registration => registration.unregister()),
  );
  const removedServiceWorker = outcomes.some(
    outcome => outcome.status === 'fulfilled' && outcome.value,
  );
  if (
    !removedServiceWorker ||
    !claimReloadGuard(environment.sessionStorage, cleanupReloadSessionKey)
  ) {
    return false;
  }

  environment.location.reload();
  return true;
}

function isBackendInitFailure(error: unknown): error is BackendInitFailure {
  return (
    error != null &&
    typeof error === 'object' &&
    'type' in error &&
    'BackendInitFailure' in error &&
    error.type === 'app-init-failure' &&
    error.BackendInitFailure === true
  );
}

export function retryTransientBackendInitializationFailure(
  error: unknown,
  environment: BackendRetryEnvironment,
) {
  if (!isBackendInitFailure(error)) {
    return false;
  }

  const nonce = getLauncherNavigationNonce(
    environment.location,
    environment.isDevelopment,
  );
  if (
    !nonce ||
    !claimReloadGuard(
      environment.sessionStorage,
      `${backendRetrySessionKeyPrefix}${nonce}`,
    )
  ) {
    return false;
  }

  environment.location.reload();
  return true;
}
