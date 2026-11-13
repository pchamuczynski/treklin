/**
 * Per-route automatic import of workouts from connected providers (Strava, Garmin).
 *
 * Rules:
 *  - Only workouts of the selected types are imported.
 *  - Only workouts recorded after auto-import was switched on are imported, never
 *    older ones. Switching it off and on again starts a new window.
 *  - A completed route (covered distance >= route distance) imports nothing more;
 *    the workout that crosses the finish line is the last one.
 *  - A workout the user removed from the route stays off it. Automatic sync does not
 *    put that recording back. Choosing it again in a manual import does.
 *
 * @typedef {object} AutoImportSettings
 * @property {boolean} enabled
 * @property {string[]} activities    Workout types to import - always a subset of the route's activities.
 *                                    Kept while disabled so re-enabling restores the choice.
 * @property {string[]} sources       Connected services to import from (`strava`, `garmin`). Empty while off.
 * @property {string | null} since    ISO timestamp of when auto-import was switched on; null while off.
 * @property {string[]} excluded      `source:externalId` keys the user removed from this route.
 */
import { ACTIVITIES, normalizeActivities } from './activities.js';
import { intervalsOverlap, workoutInterval } from './overlap.js';
import { externalKey, mergeImportedWorkouts, sortWorkoutsByDate, totalDistance } from './workout.js';

/** Services a route can import workouts from, in display order. */
export const IMPORT_SOURCES = Object.freeze([
  { id: 'strava', label: 'Strava' },
  { id: 'garmin', label: 'Garmin' },
]);

export const IMPORT_SOURCE_IDS = IMPORT_SOURCES.map((source) => source.id);

export const importSourceLabel = (id) => IMPORT_SOURCES.find((source) => source.id === id)?.label ?? id;

export const DEFAULT_AUTO_IMPORT = Object.freeze({ enabled: false, activities: [], sources: [], since: null, excluded: [] });

const MAX_EXCLUDED = 1000;

/** Keeps `source:externalId` keys for recordings the user removed from a route. */
const normalizeExcluded = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const keys = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const split = item.indexOf(':');
    const source = split === -1 ? '' : item.slice(0, split);
    const id = split === -1 ? '' : item.slice(split + 1);
    if (!IMPORT_SOURCE_IDS.includes(source) || id.length === 0 || id.length > 64 || seen.has(item)) continue;
    seen.add(item);
    keys.push(item);
  }
  return keys.length > MAX_EXCLUDED ? keys.slice(keys.length - MAX_EXCLUDED) : keys;
};

/**
 * Remembers imported workouts the user deleted, so the next sync does not add them again.
 * A route with nothing new to remember is returned unchanged.
 */
export const dismissWorkouts = (route, removed) => {
  const excluded = normalizeExcluded([...(route.autoImport?.excluded ?? []), ...removed.map(externalKey).filter(Boolean)]);
  const current = route.autoImport?.excluded ?? [];
  if (excluded.length === current.length && excluded.every((key, index) => key === current[index])) return route;
  return { ...route, autoImport: { ...route.autoImport, excluded } };
};

/** Forgets a dismissal when the user explicitly imports that recording again. */
export const releaseDismissed = (route, workouts) => {
  const drop = new Set(workouts.map(externalKey).filter(Boolean));
  if (drop.size === 0) return route;
  const excluded = (route.autoImport?.excluded ?? []).filter((key) => !drop.has(key));
  if (excluded.length === (route.autoImport?.excluded?.length ?? 0)) return route;
  return { ...route, autoImport: { ...route.autoImport, excluded } };
};

/**
 * @param {unknown} rawSources
 * @param {boolean} fallbackToAll  Legacy routes stored `enabled` without naming a service.
 */
const normalizeSources = (rawSources, fallbackToAll) => {
  if (Array.isArray(rawSources)) return IMPORT_SOURCE_IDS.filter((id) => rawSources.includes(id));
  return fallbackToAll ? [...IMPORT_SOURCE_IDS] : [];
};

const toIsoTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const allowedOnly = (activities, allowed) => normalizeActivities(activities).filter((a) => allowed.includes(a));

/**
 * Coerces stored or legacy data into valid settings, keeping only types the route allows.
 * Settings left without a valid `since` or without any type are switched off.
 */
export const normalizeAutoImport = (raw, allowed = ACTIVITIES) => {
  const activities = allowedOnly(raw?.activities, allowed);
  const since = toIsoTimestamp(raw?.since);
  const sources = normalizeSources(raw?.sources, raw?.enabled === true);
  const enabled = sources.length > 0 && since !== null && activities.length > 0;
  return {
    enabled,
    activities,
    sources: enabled ? sources : [],
    since: enabled ? since : null,
    excluded: normalizeExcluded(raw?.excluded),
  };
};

/**
 * Applies the form's requested settings to a route's current ones. `since` is never
 * taken from the client: it is stamped when auto-import goes from off to on.
 *
 * @param {AutoImportSettings | null} previous  null for a new route
 * @param {{ enabled?: boolean, activities?: string[], sources?: string[] } | undefined} requested
 * @param {Date} now
 * @param {string[]} allowed  The route's activities.
 */
export const resolveAutoImport = (previous, requested, now, allowed = ACTIVITIES) => {
  const activities = allowedOnly(requested?.activities, allowed);
  const sources = normalizeSources(requested?.sources, requested?.sources == null && requested?.enabled === true);
  const enabled = sources.length > 0 && activities.length > 0;
  const excluded = normalizeExcluded(previous?.excluded);
  if (!enabled) return { enabled: false, activities, sources: [], since: null, excluded };
  const wasEnabled = previous?.enabled === true && previous.since !== null;
  return { enabled: true, activities, sources, since: wasEnabled ? previous.since : now.toISOString(), excluded };
};

export const validateAutoImport = (settings) => {
  if (!settings?.enabled) return null;
  if (normalizeActivities(settings.activities).length === 0) return 'Select at least one workout type to import';
  return null;
};

export const isRouteCompleted = (route) => route.distance > 0 && totalDistance(route.workouts) >= route.distance;

/** Calendar date of the workout that crosses the finish line, or null while the route is unfinished. */
export const completionDate = (route) => {
  if (!isRouteCompleted(route)) return null;
  let covered = 0;
  for (const workout of sortWorkoutsByDate(route.workouts)) {
    covered += workout.distance;
    if (covered >= route.distance) return workout.date;
  }
  return null;
};

/** Routes that existed and were unfinished, and are finished now. */
export const newlyCompletedRoutes = (previous, next) => {
  const wasCompleted = new Map(previous.map((route) => [route.id, isRouteCompleted(route)]));
  return next.filter((route) => isRouteCompleted(route) && wasCompleted.get(route.id) === false);
};

/** Whether the route is currently collecting imports. */
export const isAutoImportActive = (route) => route.autoImport?.enabled === true && !isRouteCompleted(route);

/**
 * Was the workout recorded after `since`? Imported workouts carry their exact start
 * time; without one we can only compare calendar days (UTC), which errs on the side
 * of excluding same-day workouts rather than importing past ones.
 */
const recordedAfter = (workout, since) =>
  workout.startedAt ? workout.startedAt >= since : workout.date > since.slice(0, 10);

export const routeAcceptsWorkout = (route, workout) => {
  if (!isAutoImportActive(route)) return false;
  if (!route.autoImport.sources.includes(workout.source) || !route.autoImport.activities.includes(workout.activity)) return false;
  if (!recordedAfter(workout, route.autoImport.since)) return false;
  const key = externalKey(workout);
  return !key || !route.autoImport.excluded.includes(key);
};

const chronological = (a, b) =>
  (a.startedAt ?? a.date).localeCompare(b.startedAt ?? b.date) || a.createdAt.localeCompare(b.createdAt);

const conflictsWith = (workout, others) => {
  const incoming = workoutInterval(workout);
  if (!incoming) return [];
  return others.filter((existing) => {
    const interval = workoutInterval(existing);
    return interval && intervalsOverlap(incoming, interval);
  });
};

/**
 * Adds eligible workouts in the order they happened, stopping once the route is
 * complete. Already imported workouts are skipped. A repeat import can fill in
 * elapsed time. Workouts that overlap in time follow `policy`:
 * `old` keeps the one already on the route, `new` replaces it, `both` keeps each.
 * An unchanged route keeps its identity.
 */
const acceptUntilComplete = (route, eligible, policy = 'both') => {
  const merged = mergeImportedWorkouts(route.workouts, eligible);
  const previousById = new Map(route.workouts.map((workout) => [workout.id, workout]));
  let workouts = merged.workouts.filter((workout) => !merged.added.includes(workout));
  let overlapCount = 0;
  let removedCount = 0;
  const accepted = [];
  let covered = totalDistance(workouts);

  for (const workout of [...merged.added].sort(chronological)) {
    const conflicting = conflictsWith(workout, workouts);
    if (conflicting.length > 0 && policy === 'old') {
      if (covered >= route.distance) break;
      overlapCount += 1;
      continue;
    }
    if (conflicting.length > 0 && policy === 'new') {
      const remove = new Set(conflicting);
      workouts = workouts.filter((existing) => !remove.has(existing));
      removedCount += conflicting.length;
      covered = totalDistance(workouts);
      overlapCount += 1;
      accepted.push(workout);
      workouts.push(workout);
      covered += workout.distance;
      continue;
    }
    if (covered >= route.distance) break;
    if (conflicting.length > 0) overlapCount += 1;
    accepted.push(workout);
    workouts.push(workout);
    covered += workout.distance;
  }

  const filledCount = workouts.reduce((count, workout) => {
    const previous = previousById.get(workout.id);
    return count + (previous && !(previous.duration > 0) && workout.duration > 0 ? 1 : 0);
  }, 0);
  if (accepted.length === 0 && filledCount === 0 && removedCount === 0) {
    return { route, added: 0, filled: 0, overlaps: overlapCount, removed: 0 };
  }
  return {
    route: { ...route, workouts: sortWorkoutsByDate(workouts) },
    added: accepted.length,
    filled: filledCount,
    overlaps: overlapCount,
    removed: removedCount,
  };
};

/**
 * Adds each imported workout to every route whose auto-import settings accept it.
 * Workouts are applied in the order they happened and a route stops accepting them
 * once it is completed. Already imported workouts (same source + externalId) are
 * skipped, and so are recordings the user removed from that route. Unchanged routes keep their identity.
 *
 * @param {'old' | 'new' | 'both'} [policy]
 * @returns {{ routes: import('./route').Route[], addedCount: number, filledCount: number, overlapCount: number, removedCount: number }}
 */
export const distributeImportedWorkouts = (routes, workouts, policy = 'both') => {
  let addedCount = 0;
  let filledCount = 0;
  let overlapCount = 0;
  let removedCount = 0;
  const updated = routes.map((route) => {
    const eligible = workouts.filter((workout) => routeAcceptsWorkout(route, workout));
    if (eligible.length === 0) return route;
    const result = acceptUntilComplete(route, eligible, policy);
    addedCount += result.added;
    filledCount += result.filled;
    overlapCount += result.overlaps;
    removedCount += result.removed;
    return result.route;
  });
  return { routes: updated, addedCount, filledCount, overlapCount, removedCount };
};

/**
 * Puts workouts onto the routes the user picked (a historical import). Matches the
 * route's own activity types and ignores the auto-import window. Same de-duplication
 * and completion rules as automatic import.
 *
 * @param {string[]} routeIds
 * @param {'old' | 'new' | 'both'} [policy]
 * @returns {{ routes: import('./route').Route[], addedCount: number, filledCount: number, overlapCount: number, removedCount: number }}
 */
export const assignWorkoutsToRoutes = (routes, workouts, routeIds, policy = 'both') => {
  const selected = new Set(routeIds);
  let addedCount = 0;
  let filledCount = 0;
  let overlapCount = 0;
  let removedCount = 0;
  const updated = routes.map((route) => {
    if (!selected.has(route.id)) return route;
    const eligible = workouts.filter((workout) => route.activities.includes(workout.activity));
    if (eligible.length === 0) return route;
    const result = acceptUntilComplete(releaseDismissed(route, eligible), eligible, policy);
    addedCount += result.added;
    filledCount += result.filled;
    overlapCount += result.overlaps;
    removedCount += result.removed;
    return result.route;
  });
  return { routes: updated, addedCount, filledCount, overlapCount, removedCount };
};

/** Earliest `since` across routes still collecting imports, or null when none are. */
export const earliestImportStart = (routes) => {
  let earliest = null;
  for (const route of routes) {
    if (isAutoImportActive(route) && (!earliest || route.autoImport.since < earliest)) earliest = route.autoImport.since;
  }
  return earliest;
};
