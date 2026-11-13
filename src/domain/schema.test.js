import { describe, expect, it } from 'vitest';
import { sanitizeRoutes } from './schema';

const legacyRoute = {
  id: 1718800000000,
  name: 'Warsaw → Krakow',
  from: 'Warsaw',
  to: 'Krakow',
  activities: ['Running'],
  coordinates: [
    [52.2297, 21.0122],
    [50.0647, 19.945],
  ],
  distance: 295000,
  duration: 10800,
  provider: 'google',
  coveredDistance: 999999, // stale stored value - must be ignored
  created: '2025-06-19T10:00:00.000Z',
  workouts: [
    { id: '1718800000001', date: '2025-06-19', activity: 'Running', distance: 5000, timestamp: '2025-06-19T10:00:00.000Z' },
  ],
};

describe('sanitizeRoutes', () => {
  it('migrates the legacy v1 format', () => {
    const [route] = sanitizeRoutes([legacyRoute]);
    expect(route.id).toBe('1718800000000');
    expect(route.createdAt).toBe('2025-06-19T10:00:00.000Z');
    expect(route).not.toHaveProperty('coveredDistance');
    expect(route.autoImport).toEqual({ enabled: false, activities: [], sources: [], since: null, excluded: [] });
    expect(route.workouts[0]).toMatchObject({ source: 'manual', externalId: null, createdAt: '2025-06-19T10:00:00.000Z' });
  });

  it('drops malformed routes and workouts instead of crashing', () => {
    const routes = sanitizeRoutes([
      null,
      'nope',
      { ...legacyRoute, id: 2, coordinates: [[1, 2]] },
      { ...legacyRoute, id: 3, workouts: [{ id: 'x', date: 'bad', activity: 'Running', distance: 1 }, 7] },
    ]);
    expect(routes.map((r) => r.id)).toEqual(['3']);
    expect(routes[0].workouts).toEqual([]);
  });

  it('maps legacy free-text route activities onto supported ones', () => {
    const [route] = sanitizeRoutes([{ ...legacyRoute, activities: ['running', 'cycling', 'Yoga', 'XC ski'] }]);
    expect(route.activities).toEqual(['Running', 'Cycling', 'Cross-country skiing']);
  });

  it('removes duplicate ids and non-array input', () => {
    expect(sanitizeRoutes([legacyRoute, legacyRoute])).toHaveLength(1);
    expect(sanitizeRoutes({})).toEqual([]);
  });

  it('strips control characters and enforces length limits', () => {
    const [route] = sanitizeRoutes([{ ...legacyRoute, name: `evil\u0000${'x'.repeat(500)}` }]);
    expect(route.name.startsWith('evilx')).toBe(true);
    expect(route.name.length).toBe(100);
  });
});
