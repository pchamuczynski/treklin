import { describe, expect, it } from 'vitest';
import {
  assignWorkoutsToRoutes,
  distributeImportedWorkouts,
  earliestImportStart,
  completionDate,
  isRouteCompleted,
  newlyCompletedRoutes,
  normalizeAutoImport,
  resolveAutoImport,
  validateAutoImport,
} from './autoImport';
import { ACTIVITIES } from './activities.js';
import { createRoute, updateRoute, validateRouteInput } from './route';
import { createWorkout } from './workout';

const geometry = { coordinates: [[0, 0], [0, 1]], distance: 20000, duration: 1, provider: 'osrm' };
const ENABLED_AT = new Date('2025-03-01T12:00:00.000Z');

const makeRoute = (name, activities, { enabled = true, now = ENABLED_AT, routeActivities = ACTIVITIES } = {}) =>
  createRoute({ name, from: 'A', to: 'B', activities: routeActivities, autoImport: { enabled, activities } }, geometry, now);

const imported = (activity, startedAt, externalId, { distance = 5000, duration = null, source = 'strava' } = {}) =>
  createWorkout({ date: startedAt.slice(0, 10), activity, distance, duration, source, externalId, startedAt });

const externalIds = (route) => route.workouts.map((w) => w.externalId);

describe('auto-import settings', () => {
  it('stamps "since" when switched on and keeps it on later edits', () => {
    const route = makeRoute('R', ['Running']);
    expect(route.autoImport).toEqual({
      enabled: true,
      activities: ['Running'],
      sources: ['strava', 'garmin'],
      since: ENABLED_AT.toISOString(),
      excluded: [],
    });

    const later = new Date('2025-04-01T00:00:00.000Z');
    const edited = updateRoute(route, { ...route, autoImport: { enabled: true, activities: ['Cycling'] } }, route, later);
    expect(edited.autoImport.since).toBe(ENABLED_AT.toISOString());
  });

  it('starts a new window when switched off and on again', () => {
    const route = makeRoute('R', ['Running']);
    const off = updateRoute(route, { ...route, autoImport: { enabled: false, activities: ['Running'] } });
    expect(off.autoImport).toEqual({ enabled: false, activities: ['Running'], sources: [], since: null, excluded: [] });

    const reEnabledAt = new Date('2025-05-01T08:00:00.000Z');
    const on = updateRoute(off, { ...off, autoImport: { enabled: true, activities: ['Running'] } }, off, reEnabledAt);
    expect(on.autoImport.since).toBe(reEnabledAt.toISOString());
  });

  it('ignores a client-supplied "since"', () => {
    const settings = resolveAutoImport(null, { enabled: true, activities: ['Running'], since: '2000-01-01T00:00:00Z' }, ENABLED_AT);
    expect(settings.since).toBe(ENABLED_AT.toISOString());
  });

  it('normalizes stored data and switches off enabled settings without a valid "since"', () => {
    expect(normalizeAutoImport({ enabled: true, activities: ['Running', 'Other', 'Flying'], since: 'x' })).toEqual({
      enabled: false,
      activities: ['Running'],
      sources: [],
      since: null,
      excluded: [],
    });
    expect(normalizeAutoImport({ enabled: true, activities: ['Running'], since: ENABLED_AT.toISOString() })).toEqual({
      enabled: true,
      activities: ['Running'],
      sources: ['strava', 'garmin'],
      since: ENABLED_AT.toISOString(),
      excluded: [],
    });
    expect(normalizeAutoImport(undefined)).toEqual({ enabled: false, activities: [], sources: [], since: null, excluded: [] });
    expect(
      normalizeAutoImport({
        enabled: true,
        activities: ['Running'],
        since: ENABLED_AT.toISOString(),
        excluded: ['strava:kept', 'nope', 'garmin:', 'strava:kept', 4],
      }).excluded,
    ).toEqual(['strava:kept']);
  });

  it('requires at least one type when enabled', () => {
    expect(validateAutoImport({ enabled: true, activities: [] })).toMatch(/at least one/);
    expect(validateAutoImport({ enabled: false, activities: [] })).toBeNull();
    expect(validateRouteInput({ from: 'A', to: 'B', activities: ['Running'], autoImport: { enabled: true, activities: [] } })).toHaveProperty(
      'autoImport',
    );
  });

  it('only imports types the route allows', () => {
    const route = makeRoute('R', ['Running', 'Swimming'], { routeActivities: ['Running', 'Cycling'] });
    expect(route.autoImport.activities).toEqual(['Running']);

    const none = makeRoute('R', ['Swimming'], { routeActivities: ['Running'] });
    expect(none.autoImport).toEqual({ enabled: false, activities: [], sources: [], since: null, excluded: [] });
    expect(normalizeAutoImport({ enabled: true, activities: ['Kayaking'], since: ENABLED_AT.toISOString() }, ['Running']).enabled).toBe(
      false,
    );
  });
});

describe('distributeImportedWorkouts', () => {
  it('imports only selected types recorded after auto-import was switched on', () => {
    const runs = makeRoute('Runs', ['Running']);
    const both = makeRoute('Both', ['Running', 'Cycling']);
    const off = makeRoute('Off', ['Running'], { enabled: false });

    const { routes, addedCount } = distributeImportedWorkouts(
      [runs, both, off],
      [
        imported('Running', '2025-03-01T07:00:00.000Z', 'same-day-before'), // earlier that day -> past
        imported('Running', '2025-02-10T07:00:00.000Z', 'older'),
        imported('Running', '2025-03-01T12:30:00.000Z', 'run'),
        imported('Cycling', '2025-03-02T09:00:00.000Z', 'ride'),
      ],
    );

    expect(externalIds(routes[0])).toEqual(['run']);
    expect(externalIds(routes[1])).toEqual(['run', 'ride']);
    expect(routes[2]).toBe(off);
    expect(addedCount).toBe(3);
  });

  it('falls back to calendar days for workouts without a start time, excluding the enabling day', () => {
    const route = makeRoute('R', ['Running']);
    const sameDay = createWorkout({ date: '2025-03-01', activity: 'Running', distance: 1000, source: 'strava', externalId: 1 });
    const nextDay = createWorkout({ date: '2025-03-02', activity: 'Running', distance: 1000, source: 'strava', externalId: 2 });
    const { routes } = distributeImportedWorkouts([route], [sameDay, nextDay]);
    expect(externalIds(routes[0])).toEqual(['2']);
  });

  it('stops at completion: the finishing workout is imported, later ones are not', () => {
    const route = makeRoute('R', ['Running']); // 20 km
    const { routes, addedCount } = distributeImportedWorkouts(
      [route],
      [
        // deliberately out of order - they are applied chronologically
        imported('Running', '2025-03-04T08:00:00.000Z', 'after-finish', { distance: 5000 }),
        imported('Running', '2025-03-02T08:00:00.000Z', 'first', { distance: 12000 }),
        imported('Running', '2025-03-03T08:00:00.000Z', 'finisher', { distance: 9000 }),
      ],
    );
    expect(externalIds(routes[0])).toEqual(['first', 'finisher']);
    expect(addedCount).toBe(2);
    expect(isRouteCompleted(routes[0])).toBe(true);
    expect(completionDate(routes[0])).toBe('2025-03-03');
    expect(completionDate({ ...routes[0], workouts: routes[0].workouts.slice(0, 1) })).toBeNull();

    const next = distributeImportedWorkouts(routes, [imported('Running', '2025-03-05T08:00:00.000Z', 'later')]);
    expect(next.addedCount).toBe(0);
    expect(next.routes[0]).toBe(routes[0]);
    expect(newlyCompletedRoutes([route], routes).map((item) => item.id)).toEqual([route.id]);
    expect(newlyCompletedRoutes(routes, next.routes)).toEqual([]);
  });

  it('imports a workout only when the route selected that service', () => {
    const stravaOnly = createRoute(
      {
        name: 'S',
        from: 'A',
        to: 'B',
        activities: ['Running'],
        autoImport: { enabled: true, activities: ['Running'], sources: ['strava'] },
      },
      geometry,
      ENABLED_AT,
    );
    const { routes, addedCount } = distributeImportedWorkouts(
      [stravaOnly],
      [
        imported('Running', '2025-03-02T08:00:00.000Z', 's', { source: 'strava' }),
        imported('Running', '2025-03-02T09:00:00.000Z', 'g', { source: 'garmin' }),
      ],
    );
    expect(externalIds(routes[0])).toEqual(['s']);
    expect(addedCount).toBe(1);
  });

  it('leaves a removed recording off the route until the user imports it again', () => {
    const route = makeRoute('R', ['Running']);
    const workout = imported('Running', '2025-03-02T08:00:00.000Z', 'gone');
    const withIt = distributeImportedWorkouts([route], [workout]).routes[0];
    const removed = {
      ...withIt,
      workouts: [],
      autoImport: { ...withIt.autoImport, excluded: ['strava:gone'] },
    };

    const again = distributeImportedWorkouts([removed], [workout]);
    expect(again.addedCount).toBe(0);
    expect(again.routes[0]).toBe(removed);

    const edited = updateRoute(removed, { ...removed, name: 'Renamed' }, removed);
    expect(edited.autoImport.excluded).toEqual(['strava:gone']);

    const chosen = assignWorkoutsToRoutes([removed], [workout], [removed.id]);
    expect(externalIds(chosen.routes[0])).toEqual(['gone']);
    expect(chosen.routes[0].autoImport.excluded).toEqual([]);
  });

  it('is idempotent across syncs and distinguishes providers', () => {
    const route = makeRoute('R', ['Running']);
    const run = () => imported('Running', '2025-03-05T08:00:00.000Z', 1);
    const first = distributeImportedWorkouts([route], [run()]);
    const again = distributeImportedWorkouts(first.routes, [run()]);
    expect(again.addedCount).toBe(0);
    expect(again.routes[0]).toBe(first.routes[0]);

    const garmin = distributeImportedWorkouts(first.routes, [imported('Running', '2025-03-05T08:00:00.000Z', 1, { source: 'garmin' })]);
    expect(garmin.addedCount).toBe(1);
  });

  it('assigns a past workout to the chosen routes and keeps duplicates out', () => {
    const route = makeRoute('R', ['Running'], { enabled: false, routeActivities: ['Running'] });
    const other = makeRoute('Other', ['Cycling'], { enabled: false, routeActivities: ['Cycling'] });
    const past = imported('Running', '2020-01-01T08:00:00.000Z', 'old');
    const ride = imported('Cycling', '2020-01-02T08:00:00.000Z', 'ride');

    const first = assignWorkoutsToRoutes([route, other], [past, ride], [route.id, other.id]);
    expect(externalIds(first.routes[0])).toEqual(['old']);
    expect(externalIds(first.routes[1])).toEqual(['ride']);
    expect(first.addedCount).toBe(2);

    const again = assignWorkoutsToRoutes(first.routes, [past], [route.id]);
    expect(again.addedCount).toBe(0);
    expect(again.routes[0]).toBe(first.routes[0]);

    const timed = assignWorkoutsToRoutes(first.routes, [imported('Running', '2020-01-01T08:00:00.000Z', 'old', { duration: 2400 })], [route.id]);
    expect(timed.addedCount).toBe(0);
    expect(timed.filledCount).toBe(1);
    expect(timed.routes[0].workouts[0].duration).toBe(2400);
    expect(timed.routes[0]).not.toBe(first.routes[0]);
  });

  it('keeps, replaces, or retains workouts that overlap in time', () => {
    const route = makeRoute('R', ['Running'], { enabled: false, routeActivities: ['Running'] });
    const early = imported('Running', '2025-06-01T08:00:00.000Z', 'early', { duration: 3600, distance: 5000 });
    const placed = assignWorkoutsToRoutes([route], [early], [route.id]);
    const overlapping = imported('Running', '2025-06-01T08:30:00.000Z', 'late', { duration: 3600, distance: 4000 });
    const after = imported('Running', '2025-06-01T10:00:00.000Z', 'after', { duration: 600, distance: 1000 });

    const keptOld = assignWorkoutsToRoutes(placed.routes, [overlapping, after], [route.id], 'old');
    expect(externalIds(keptOld.routes[0])).toEqual(['early', 'after']);
    expect(keptOld.overlapCount).toBe(1);
    expect(keptOld.addedCount).toBe(1);

    const touching = imported('Running', '2025-06-01T09:00:00.000Z', 'touch', { duration: 600, distance: 1000 });
    const touched = assignWorkoutsToRoutes(placed.routes, [touching], [route.id], 'old');
    expect(touched.overlapCount).toBe(0);
    expect(externalIds(touched.routes[0])).toEqual(['early', 'touch']);

    const keptNew = assignWorkoutsToRoutes(placed.routes, [overlapping], [route.id], 'new');
    expect(externalIds(keptNew.routes[0])).toEqual(['late']);
    expect(keptNew.removedCount).toBe(1);
    expect(keptNew.addedCount).toBe(1);

    const keptBoth = assignWorkoutsToRoutes(placed.routes, [overlapping], [route.id], 'both');
    expect(externalIds(keptBoth.routes[0])).toEqual(['early', 'late']);
    expect(keptBoth.overlapCount).toBe(1);
  });

  it('fetch window covers only routes still collecting imports', () => {
    const early = makeRoute('Early', ['Running'], { now: new Date('2025-01-01T00:00:00.000Z') });
    const late = makeRoute('Late', ['Running'], { now: new Date('2025-06-01T00:00:00.000Z') });
    const completedEarly = { ...early, workouts: [imported('Running', '2025-01-02T00:00:00.000Z', 'x', { distance: 20000 })] };

    expect(earliestImportStart([early, late])).toBe('2025-01-01T00:00:00.000Z');
    expect(earliestImportStart([completedEarly, late])).toBe('2025-06-01T00:00:00.000Z');
    expect(earliestImportStart([completedEarly])).toBeNull();
  });
});
