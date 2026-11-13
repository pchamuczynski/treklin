import { describe, expect, it } from 'vitest';
import { StorageError, createApiRouteRepository, createLocalRouteRepository, importGuestRoutes } from './routeRepository';

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
};

const route = {
  id: 'r1',
  name: 'R',
  from: 'A',
  to: 'B',
  activities: ['Cycling'],
  coordinates: [
    [0, 0],
    [0, 1],
  ],
  distance: 1,
  duration: 1,
  provider: 'osrm',
  autoImport: {
    enabled: true,
    activities: ['Cycling'],
    sources: ['strava', 'garmin'],
    since: '2025-01-01T10:00:00.000Z',
    excluded: [],
  },
  workouts: [],
  createdAt: '2025-01-01T00:00:00.000Z',
};

describe('local route repository', () => {
  it('round-trips routes per user', async () => {
    const storage = memoryStorage();
    await createLocalRouteRepository('alice', storage).save([route]);
    expect(await createLocalRouteRepository('alice', storage).load()).toEqual([route]);
    expect(await createLocalRouteRepository('bob', storage).load()).toEqual([]);
  });

  it('migrates the legacy key once', async () => {
    const storage = memoryStorage({ mapRunnerRoutes: JSON.stringify([{ ...route, id: 5 }]) });
    const routes = await createLocalRouteRepository('guest', storage).load();
    expect(routes.map((r) => r.id)).toEqual(['5']);
    expect(storage.data.has('mapRunnerRoutes')).toBe(false);
  });

  it('survives corrupted storage', async () => {
    const storage = memoryStorage({ 'mapRunner:v2:guest:routes': '{not json' });
    expect(await createLocalRouteRepository('guest', storage).load()).toEqual([]);
  });

  it('reports quota errors', async () => {
    const storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    await expect(createLocalRouteRepository('guest', storage).save([route])).rejects.toBeInstanceOf(StorageError);
  });
});

describe('API route repository', () => {
  const fakeServer = () => {
    const state = { version: 0, routes: [], puts: [] };
    const request = async (path, { method = 'GET', body } = {}) => {
      if (method === 'GET') return { version: state.version, routes: state.routes };
      state.puts.push(body.version);
      await new Promise((resolve) => setTimeout(resolve, 5)); // slow network
      if (body.version !== state.version) throw Object.assign(new Error('conflict'), { status: 409 });
      state.version += 1;
      state.routes = body.routes;
      return { version: state.version };
    };
    return { state, request };
  };

  it('sends saves one at a time, each with the latest version', async () => {
    const server = fakeServer();
    const repo = createApiRouteRepository(server.request);
    await repo.load();
    await Promise.all([repo.save([route]), repo.save([route]), repo.save([])]);
    expect(server.state.puts).toEqual([0, 1, 2]);
    expect(server.state.routes).toEqual([]);
  });

  it('explains conflicts from another tab or device', async () => {
    const server = fakeServer();
    const repo = createApiRouteRepository(server.request);
    await repo.load();
    server.state.version = 5; // someone else saved
    await expect(repo.save([route])).rejects.toThrow(/another device or tab/);
  });

  it('refuses to save before loading', async () => {
    await expect(createApiRouteRepository(fakeServer().request).save([])).rejects.toBeInstanceOf(StorageError);
  });
});

describe('importGuestRoutes', () => {
  const memoryRepo = (routes) => ({
    routes,
    load: async function load() {
      return this.routes;
    },
    save: async function save(next) {
      this.routes = next;
    },
    clear: async function clear() {
      this.routes = [];
    },
  });

  it('adds guest routes the account does not have yet and clears the guest copy', async () => {
    const guest = memoryRepo([route, { ...route, id: 'r2' }]);
    const account = memoryRepo([{ ...route, name: 'Already in account' }]);
    expect(await importGuestRoutes({ guest, account })).toBe(1);
    expect(account.routes.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(account.routes[0].name).toBe('Already in account');
    expect(guest.routes).toEqual([]);
  });

  it('keeps guest routes when the upload fails', async () => {
    const guest = memoryRepo([route]);
    const account = { ...memoryRepo([]), save: async () => Promise.reject(new Error('offline')) };
    await expect(importGuestRoutes({ guest, account })).rejects.toThrow('offline');
    expect(guest.routes).toHaveLength(1);
  });
});
