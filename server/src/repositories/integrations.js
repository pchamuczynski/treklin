/**
 * Connected-provider tokens and the activity summaries Garmin has delivered.
 * Access tokens never leave this module for the browser.
 */
import { transaction } from '../db.js';
import { publicSummary } from '../integrations/garmin.js';
import { publicActivity } from '../integrations/strava.js';

const REQUEST_TTL_MS = 15 * 60 * 1000;
const DAY_PAD_MS = 14 * 60 * 60 * 1000;

const externalIdOf = (summary) => {
  const id = summary?.activityId ?? summary?.summaryId;
  return id == null ? null : String(id);
};

const startedAtOf = (summary) => {
  const seconds = Number(summary?.startTimeInSeconds);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '';
};

export const createIntegrationRepository = (db) => {
  const listByUser = db.prepare('SELECT provider FROM integrations WHERE user_id = ? ORDER BY provider');
  const byUserProvider = db.prepare('SELECT * FROM integrations WHERE user_id = ? AND provider = ?');
  const byToken = db.prepare('SELECT * FROM integrations WHERE provider = ? AND token = ?');
  const byExternalId = db.prepare('SELECT * FROM integrations WHERE provider = ? AND external_id = ?');
  const upsert = db.prepare(`
    INSERT INTO integrations (user_id, provider, token, token_secret, expires_at, external_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      token = excluded.token,
      token_secret = excluded.token_secret,
      expires_at = excluded.expires_at,
      external_id = COALESCE(excluded.external_id, integrations.external_id),
      updated_at = excluded.updated_at
  `);
  const removeRow = db.prepare('DELETE FROM integrations WHERE user_id = ? AND provider = ?');
  const removeActivities = db.prepare('DELETE FROM garmin_activities WHERE user_id = ?');
  const removeStravaActivities = db.prepare('DELETE FROM strava_activities WHERE user_id = ?');
  const insertRequest = db.prepare(`
    INSERT INTO oauth_requests (token, user_id, provider, token_secret, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const deleteRequest = db.prepare('DELETE FROM oauth_requests WHERE token = ?');
  const findRequest = db.prepare('SELECT * FROM oauth_requests WHERE token = ?');
  const deleteExpiredRequests = db.prepare('DELETE FROM oauth_requests WHERE created_at < ?');
  const upsertActivity = db.prepare(`
    INSERT INTO garmin_activities (user_id, external_id, payload, started_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, external_id) DO UPDATE SET payload = excluded.payload, started_at = excluded.started_at
  `);
  const between = db.prepare(`
    SELECT payload FROM garmin_activities
    WHERE user_id = ? AND started_at >= ? AND started_at <= ?
    ORDER BY started_at
  `);
  const sinceQuery = db.prepare(`
    SELECT payload FROM garmin_activities WHERE user_id = ? AND started_at >= ? ORDER BY started_at
  `);
  const upsertStrava = db.prepare(`
    INSERT INTO strava_activities (user_id, external_id, payload, started_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, external_id) DO UPDATE SET payload = excluded.payload, started_at = excluded.started_at
  `);
  const stravaBetween = db.prepare(`
    SELECT payload FROM strava_activities
    WHERE user_id = ? AND started_at >= ? AND started_at <= ?
    ORDER BY started_at
  `);
  const stravaSince = db.prepare(`
    SELECT payload FROM strava_activities WHERE user_id = ? AND started_at >= ? ORDER BY started_at
  `);

  const parseRows = (rows) => rows.map((row) => JSON.parse(row.payload));

  return {
    list(userId) {
      return listByUser.all(userId).map((row) => row.provider);
    },

    get(userId, provider) {
      return byUserProvider.get(userId, provider) ?? null;
    },

    findByToken(provider, token) {
      return byToken.get(provider, token) ?? null;
    },

    findByExternalId(provider, externalId) {
      if (externalId == null || externalId === '') return null;
      return byExternalId.get(provider, String(externalId)) ?? null;
    },

    save(userId, provider, token, tokenSecret, expiresAt = null, externalId = null) {
      const now = new Date().toISOString();
      upsert.run(userId, provider, token, tokenSecret, expiresAt, externalId, now, now);
    },

    remove(userId, provider) {
      transaction(db, () => {
        removeRow.run(userId, provider);
        if (provider === 'garmin') removeActivities.run(userId);
        if (provider === 'strava') removeStravaActivities.run(userId);
      });
    },

    saveRequest(token, userId, provider, tokenSecret) {
      deleteExpiredRequests.run(new Date(Date.now() - REQUEST_TTL_MS).toISOString());
      deleteRequest.run(token);
      insertRequest.run(token, userId, provider, tokenSecret, new Date().toISOString());
    },

    /** Returns the pending request and deletes it, so a callback can be used once. */
    takeRequest(token) {
      const row = findRequest.get(token);
      if (row) deleteRequest.run(token);
      return row ?? null;
    },

    saveActivities(userId, summaries) {
      const clean = (Array.isArray(summaries) ? summaries : []).map(publicSummary).filter(Boolean);
      transaction(db, () => {
        for (const summary of clean) {
          const externalId = externalIdOf(summary);
          const startedAt = startedAtOf(summary);
          if (!externalId || !startedAt) continue;
          upsertActivity.run(userId, externalId, JSON.stringify(summary), startedAt);
        }
      });
    },

    /** Summaries whose start falls in the inclusive local-date window, with a timezone pad. */
    activitiesBetween(userId, from, to) {
      const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - DAY_PAD_MS).toISOString();
      const end = new Date(Date.parse(`${to}T23:59:59.999Z`) + DAY_PAD_MS).toISOString();
      return parseRows(between.all(userId, start, end));
    },

    activitiesSince(userId, since) {
      return parseRows(sinceQuery.all(userId, since));
    },

    saveStravaActivities(userId, activities) {
      const clean = (Array.isArray(activities) ? activities : []).map(publicActivity).filter(Boolean);
      transaction(db, () => {
        for (const activity of clean) {
          upsertStrava.run(userId, String(activity.id), JSON.stringify(activity), activity.start_date);
        }
      });
    },

    stravaActivitiesBetween(userId, from, to) {
      const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - DAY_PAD_MS).toISOString();
      const end = new Date(Date.parse(`${to}T23:59:59.999Z`) + DAY_PAD_MS).toISOString();
      return parseRows(stravaBetween.all(userId, start, end));
    },

    stravaActivitiesSince(userId, since) {
      return parseRows(stravaSince.all(userId, since));
    },
  };
};
