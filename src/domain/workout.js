/**
 * Workout model and rules.
 *
 * @typedef {'manual' | 'strava' | 'garmin'} WorkoutSource
 * @typedef {object} Workout
 * @property {string} id
 * @property {string} date         Local calendar date, `YYYY-MM-DD`.
 * @property {string} activity     One of ACTIVITIES (legacy workouts may be 'Other').
 * @property {number} distance     Meters, > 0.
 * @property {number | null} duration  Elapsed seconds, when the source recorded it.
 * @property {WorkoutSource} source
 * @property {string | null} externalId  Provider's activity id, used to de-duplicate imports.
 * @property {string | null} startedAt   Exact start time (ISO) for imported workouts; null for manual ones.
 * @property {string} createdAt    ISO timestamp.
 */
import { ACTIVITIES } from './activities.js';
import { createId } from '../lib/id.js';

export const WORKOUT_SOURCES = Object.freeze({
  MANUAL: 'manual',
  STRAVA: 'strava',
  GARMIN: 'garmin',
});

export const WORKOUT_LIMITS = Object.freeze({
  MAX_DISTANCE_M: 1_000_000, // 1000 km in a single workout is certainly an input error
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const isValidIsoDate = (value) => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/**
 * Validates raw form input. Returns a map of field -> message; empty when valid.
 * @param {{ date: string, activity: string, distanceKm: string | number }} input
 * @param {string} today `YYYY-MM-DD` in the user's timezone
 * @param {string[]} allowedActivities  Usually the route's activities.
 */
export const validateWorkoutInput = ({ date, activity, distanceKm }, today, allowedActivities = ACTIVITIES) => {
  const errors = {};
  if (!isValidIsoDate(date)) errors.date = 'Enter a valid date';
  else if (date > today) errors.date = 'Date cannot be in the future';

  if (!allowedActivities.includes(activity)) errors.activity = 'Select an activity';

  const meters = Number(distanceKm) * 1000;
  if (!Number.isFinite(meters) || meters <= 0) errors.distance = 'Distance must be greater than 0';
  else if (meters > WORKOUT_LIMITS.MAX_DISTANCE_M) errors.distance = 'Distance is unrealistically large';

  return errors;
};

/** Elapsed seconds from an importer, or null when the workout has no recorded time. */
export const durationSeconds = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds);
};

export const createWorkout = ({
  date,
  activity,
  distance,
  duration = null,
  source = WORKOUT_SOURCES.MANUAL,
  externalId = null,
  startedAt = null,
}) => ({
  id: createId(),
  date,
  activity,
  distance: Math.round(distance),
  duration: durationSeconds(duration),
  source,
  externalId: externalId == null ? null : String(externalId),
  startedAt,
  createdAt: new Date().toISOString(),
});

/** Returns a new array sorted oldest first (never mutates the input). */
export const sortWorkoutsByDate = (workouts) =>
  [...workouts].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

export const totalDistance = (workouts) => workouts.reduce((sum, w) => sum + w.distance, 0);

/** Sum of recorded elapsed times. Workouts without a duration contribute nothing. */
export const totalWorkoutDuration = (workouts) =>
  workouts.reduce((sum, workout) => sum + (workout.duration > 0 ? workout.duration : 0), 0);

export const latestWorkout = (workouts) => {
  let latest = null;
  for (const workout of workouts) {
    if (!latest || workout.date > latest.date || (workout.date === latest.date && workout.createdAt > latest.createdAt)) {
      latest = workout;
    }
  }
  return latest;
};

export const externalKey = (workout) =>
  workout.externalId == null ? null : `${workout.source}:${workout.externalId}`;

/**
 * Adds imported workouts, skipping ones already present (same source + externalId),
 * so repeated syncs from Strava/Garmin are idempotent.
 */
export const mergeImportedWorkouts = (existing, incoming) => {
  const indexByKey = new Map();
  existing.forEach((workout, index) => {
    const key = externalKey(workout);
    if (key) indexByKey.set(key, index);
  });
  let filled = existing;
  const added = [];
  const seenAdded = new Set();
  for (const workout of incoming) {
    const key = externalKey(workout);
    if (key && indexByKey.has(key)) {
      const index = indexByKey.get(key);
      const previous = filled[index];
      // A repeat import can fill in elapsed time that an older copy never stored.
      if (previous && !(previous.duration > 0) && workout.duration > 0) {
        if (filled === existing) filled = [...existing];
        filled[index] = { ...previous, duration: workout.duration };
      }
      continue;
    }
    if (key) {
      if (seenAdded.has(key)) continue;
      seenAdded.add(key);
    }
    added.push(workout);
  }
  return {
    workouts: added.length ? sortWorkoutsByDate([...filled, ...added]) : filled,
    added,
    filled: filled !== existing,
  };
};
