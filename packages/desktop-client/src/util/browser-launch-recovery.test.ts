import { describe, expect, it, vi } from 'vitest';

import {
  reloadAfterRemovingStaleServiceWorkers,
  retryTransientBackendInitializationFailure,
} from './browser-launch-recovery';

function createSessionStorage() {
  const entries = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => entries.set(key, value)),
  };
}

function createLocation(search = '?actual-launch=nonce') {
  return {
    hostname: '127.0.0.1',
    origin: 'http://127.0.0.1:3001',
    search,
    reload: vi.fn(),
  };
}

describe('browser launcher recovery', () => {
  it('does nothing when no service worker was registered', async () => {
    const location = createLocation();
    const sessionStorage = createSessionStorage();

    await expect(
      reloadAfterRemovingStaleServiceWorkers({
        isDevelopment: true,
        location,
        serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([]) },
        sessionStorage,
      }),
    ).resolves.toBe(false);

    expect(location.reload).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('reports a scheduled reload after removing stale same-origin workers', async () => {
    const location = createLocation();
    const sessionStorage = createSessionStorage();
    const unregister = vi.fn().mockResolvedValue(true);
    const unrelatedUnregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([
      { scope: 'http://127.0.0.1:3001/', unregister },
      {
        scope: 'https://unrelated.example/',
        unregister: unrelatedUnregister,
      },
    ]);
    const environment = {
      isDevelopment: true,
      location,
      serviceWorker: { getRegistrations },
      sessionStorage,
    };

    await expect(
      reloadAfterRemovingStaleServiceWorkers(environment),
    ).resolves.toBe(true);
    await expect(
      reloadAfterRemovingStaleServiceWorkers(environment),
    ).resolves.toBe(false);

    expect(unregister).toHaveBeenCalledOnce();
    expect(unrelatedUnregister).not.toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('retries a transient backend initialization failure once', () => {
    const location = createLocation();
    const environment = {
      isDevelopment: true,
      location,
      sessionStorage: createSessionStorage(),
    };
    const error = { type: 'app-init-failure', BackendInitFailure: true };

    expect(retryTransientBackendInitializationFailure(error, environment)).toBe(
      true,
    );
    expect(retryTransientBackendInitializationFailure(error, environment)).toBe(
      false,
    );
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the fatal error visible after a permanent backend failure', () => {
    const location = createLocation();
    const sessionStorage = createSessionStorage();
    sessionStorage.setItem('actual-launch-backend-retry:nonce', 'true');

    expect(
      retryTransientBackendInitializationFailure(
        { type: 'app-init-failure', BackendInitFailure: true },
        { isDevelopment: true, location, sessionStorage },
      ),
    ).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('does not retry non-transient failures or clear browser storage', () => {
    const location = createLocation();
    const sessionStorage = { ...createSessionStorage(), clear: vi.fn() };
    const clearLocalStorage = vi.spyOn(window.localStorage, 'clear');

    try {
      expect(
        retryTransientBackendInitializationFailure(
          { type: 'app-init-failure', IDBFailure: true },
          { isDevelopment: true, location, sessionStorage },
        ),
      ).toBe(false);

      expect(location.reload).not.toHaveBeenCalled();
      expect(sessionStorage.clear).not.toHaveBeenCalled();
      expect(clearLocalStorage).not.toHaveBeenCalled();
    } finally {
      clearLocalStorage.mockRestore();
    }
  });
});
