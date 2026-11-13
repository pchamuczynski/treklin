import { describe, expect, it } from 'vitest';
import { createRoute, getCoveredDistance } from '../domain/route';
import { createWorkout } from '../domain/workout';
import { initialRoutesState, routesReducer } from './routesReducer';

const geometry = {
  coordinates: [
    [0, 0],
    [0, 1],
  ],
  distance: 10000,
  duration: 600,
  provider: 'osrm',
};
const makeRoute = (name) => createRoute({ name, from: 'A', to: 'B', activities: ['Running'] }, geometry);

const ready = (routes) => routesReducer(initialRoutesState, { type: 'LOAD_SUCCEEDED', routes, repository: {} });

describe('routesReducer', () => {
  it('deletes a workout and updates progress in one step', () => {
    const route = makeRoute('R');
    const w1 = createWorkout({ date: '2025-01-01', activity: 'Running', distance: 3000 });
    const w2 = createWorkout({ date: '2025-01-02', activity: 'Running', distance: 2000 });
    let state = ready([route]);
    state = routesReducer(state, { type: 'WORKOUT_ADDED', routeId: route.id, workout: w1 });
    state = routesReducer(state, { type: 'WORKOUT_ADDED', routeId: route.id, workout: w2 });
    state = routesReducer(state, { type: 'WORKOUT_DELETED', routeId: route.id, workoutId: w1.id });

    expect(state.routes[0].workouts.map((w) => w.id)).toEqual([w2.id]);
    expect(getCoveredDistance(state.routes[0])).toBe(2000);
    expect(state.revision).toBe(3);

    state = routesReducer(state, { type: 'WORKOUTS_DELETED', routeId: route.id, workoutIds: [w2.id] });
    expect(state.routes[0].workouts).toEqual([]);
    expect(state.routes[0].autoImport.excluded).toEqual([]);
    expect(state.revision).toBe(4);
  });

  it('keeps a deleted import off the route when the same recording syncs again', () => {
    const route = createRoute(
      { name: 'Auto', from: 'A', to: 'B', activities: ['Running'], autoImport: { enabled: true, activities: ['Running'] } },
      geometry,
      new Date('2025-01-01T00:00:00Z'),
    );
    const workout = createWorkout({
      date: '2025-01-02',
      activity: 'Running',
      distance: 1000,
      source: 'strava',
      externalId: '42',
      startedAt: '2025-01-02T08:00:00.000Z',
    });

    let state = ready([route]);
    state = routesReducer(state, { type: 'WORKOUTS_IMPORTED', workouts: [workout] });
    const importedId = state.routes[0].workouts[0].id;
    state = routesReducer(state, { type: 'WORKOUT_DELETED', routeId: route.id, workoutId: importedId });

    expect(state.routes[0].workouts).toEqual([]);
    expect(state.routes[0].autoImport.excluded).toEqual(['strava:42']);

    const saved = state;
    state = routesReducer(state, { type: 'WORKOUTS_IMPORTED', workouts: [{ ...workout, id: 'again' }] });
    expect(state).toBe(saved);
  });

  it('keeps workouts sorted by date', () => {
    const route = makeRoute('R');
    const later = createWorkout({ date: '2025-02-01', activity: 'Running', distance: 1000 });
    const earlier = createWorkout({ date: '2025-01-01', activity: 'Running', distance: 1000 });
    let state = ready([route]);
    state = routesReducer(state, { type: 'WORKOUT_ADDED', routeId: route.id, workout: later });
    state = routesReducer(state, { type: 'WORKOUT_ADDED', routeId: route.id, workout: earlier });
    expect(state.routes[0].workouts.map((w) => w.date)).toEqual(['2025-01-01', '2025-02-01']);
  });

  it('reorders routes', () => {
    const [a, b, c] = ['A', 'B', 'C'].map(makeRoute);
    const state = routesReducer(ready([a, b, c]), { type: 'ROUTE_MOVED', routeId: c.id, targetRouteId: a.id });
    expect(state.routes.map((r) => r.name)).toEqual(['C', 'A', 'B']);
  });

  it('ignores actions for unknown routes without bumping the revision', () => {
    const state = ready([makeRoute('R')]);
    expect(routesReducer(state, { type: 'ROUTE_DELETED', routeId: 'missing' })).toBe(state);
    expect(routesReducer(state, { type: 'WORKOUT_DELETED', routeId: 'missing', workoutId: 'x' })).toBe(state);
  });

  it('imports workouts into auto-import routes idempotently', () => {
    const autoImport = { enabled: true, activities: ['Running'] };
    const route = createRoute({ name: 'Auto', from: 'A', to: 'B', activities: ['Running'], autoImport }, geometry, new Date('2025-01-01T00:00:00Z'));
    const manualOnly = makeRoute('Manual');
    const imported = createWorkout({
      date: '2025-01-01',
      activity: 'Running',
      distance: 1000,
      source: 'garmin',
      externalId: 7,
      startedAt: '2025-01-01T08:00:00.000Z',
    });

    let state = ready([route, manualOnly]);
    state = routesReducer(state, { type: 'WORKOUTS_IMPORTED', workouts: [imported] });
    expect(state.routes[0].workouts).toHaveLength(1);
    expect(state.routes[1].workouts).toHaveLength(0);

    const before = state;
    state = routesReducer(state, { type: 'WORKOUTS_IMPORTED', workouts: [{ ...imported, id: 'other' }] });
    expect(state).toBe(before); // nothing new -> no save triggered
  });
});
