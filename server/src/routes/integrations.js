/**
 * Connected apps. OAuth starts and finishes in the browser; tokens stay here.
 * Garmin pushes new activities to /api/integrations/garmin/push (no session cookie).
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { GarminError } from '../integrations/garmin.js';
import { StravaError } from '../integrations/strava.js';
import { HttpError } from '../middleware/errors.js';
import { requireUser } from '../middleware/session.js';
import { createIntegrationRepository } from '../repositories/integrations.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

const one = (value) => (Array.isArray(value) ? value[0] : value) ?? '';

const home = (config, query) => {
  const params = new URLSearchParams(query);
  const suffix = params.size > 0 ? `?${params}` : '';
  return `${config.appOrigins[0]}/${suffix}`;
};

const summariesOf = (body) => {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.activities) ? body.activities : [];
};

const garminOwner = (repo, item) => {
  if (item?.userId != null && item.userId !== '') {
    const byUser = repo.findByExternalId('garmin', item.userId);
    if (byUser) return byUser;
  }
  return item?.userAccessToken ? repo.findByToken('garmin', item.userAccessToken) : null;
};

const freshGarminRow = async (garmin, repo, row) => {
  if (!garmin.refresh || garmin.personal) return row;
  const expires = Date.parse(row.expires_at ?? '');
  if (Number.isFinite(expires) && expires - Date.now() > 120_000) return row;
  try {
    const next = await garmin.refresh(row);
    repo.save(row.user_id, 'garmin', next.token, next.secret, next.expiresAt ?? null, next.externalUserId ?? row.external_id ?? null);
    return repo.get(row.user_id, 'garmin');
  } catch (error) {
    if (error?.status === 400 || error?.status === 401) {
      repo.remove(row.user_id, 'garmin');
      throw new HttpError(401, 'Reconnect Garmin');
    }
    throw error;
  }
};

export const createGarminPushHandler = ({ db, garmin }) => {
  const repo = createIntegrationRepository(db);

  return async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const deregistrations = Array.isArray(body.deregistrations) ? body.deregistrations : [];
      for (const item of deregistrations) {
        const row = garminOwner(repo, item);
        if (row) repo.remove(row.user_id, 'garmin');
      }

      const items = summariesOf(body);
      const direct = new Map();
      for (const item of items) {
        if (item?.callbackURL && !item.activityType && item.activityId == null && item.summaryId == null) continue;
        const row = garminOwner(repo, item);
        if (!row) continue;
        const list = direct.get(row.user_id) ?? [];
        list.push(item);
        direct.set(row.user_id, list);
      }
      for (const [userId, summaries] of direct) repo.saveActivities(userId, summaries);

      for (const item of items) {
        if (!item?.callbackURL || !garmin.pullUrl) continue;
        let row = garminOwner(repo, item);
        if (!row) continue;
        try {
          row = await freshGarminRow(garmin, repo, row);
          const summaries = await garmin.pullUrl(row, item.callbackURL);
          repo.saveActivities(row.user_id, summaries);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) continue;
          throw error;
        }
      }

      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  };
};

const canReadActivities = (scope) => /(^|[, ])activity:read(_all)?($|[, ])/.test(scope);

const freshStravaToken = async (strava, repo, row) => {
  const expires = Date.parse(row.expires_at ?? '');
  if (Number.isFinite(expires) && expires - Date.now() > 120_000) return row.token;
  const next = await strava.refresh(row.token_secret);
  repo.save(row.user_id, 'strava', next.accessToken, next.refreshToken, next.expiresAt);
  return next.accessToken;
};

export const createIntegrationRouter = ({ config, db, garmin, strava }) => {
  const repo = createIntegrationRepository(db);
  const router = Router();

  const fail = (error) => {
    if (error instanceof HttpError) throw error;
    if (error instanceof GarminError && error.status === 401) throw new HttpError(401, 'Reconnect Garmin');
    if (error instanceof GarminError) throw new HttpError(502, 'Garmin could not be reached');
    throw error;
  };

  router.get('/', requireUser, (req, res) => {
    res.json({ connected: repo.list(req.user.id) });
  });

  router.get('/garmin/connect', requireUser, async (req, res) => {
    if (!garmin.configured) {
      return res.redirect(home(config, { garmin: 'error', reason: 'Add Garmin API credentials on the server, then try again' }));
    }
    if (garmin.personal) {
      repo.save(req.user.id, 'garmin', 'personal', '');
      return res.redirect(home(config, { garmin: 'connected' }));
    }
    try {
      const pending = await garmin.beginConnect(`${config.appOrigins[0]}/api/integrations/garmin/callback`);
      repo.saveRequest(pending.requestToken, req.user.id, 'garmin', pending.requestSecret);
      res.redirect(pending.authorizeUrl);
    } catch {
      res.redirect(home(config, { garmin: 'error', reason: 'Garmin could not start the connection' }));
    }
  });

  router.get('/garmin/callback', async (req, res) => {
    const code = one(req.query.code);
    const state = one(req.query.state);
    const pending = state ? repo.takeRequest(state) : null;
    if (!pending || pending.provider !== 'garmin' || !code) {
      return res.redirect(home(config, { garmin: 'error', reason: 'Garmin connection was cancelled' }));
    }
    try {
      const access = await garmin.finishConnect({
        code,
        codeVerifier: pending.token_secret,
        redirectUri: `${config.appOrigins[0]}/api/integrations/garmin/callback`,
      });
      repo.save(pending.user_id, 'garmin', access.token, access.secret, access.expiresAt ?? null, access.externalUserId ?? null);
      res.redirect(home(config, { garmin: 'connected' }));
    } catch {
      res.redirect(home(config, { garmin: 'error', reason: 'Garmin could not finish the connection' }));
    }
  });

  router.delete('/garmin', requireUser, async (req, res, next) => {
    try {
      const row = repo.get(req.user.id, 'garmin');
      if (row && garmin.configured && !garmin.personal && garmin.deregister) {
        try {
          await garmin.deregister(row);
        } catch (error) {
          if (error?.status !== 401 && error?.status !== 404) fail(error);
        }
      }
      if (row) repo.remove(req.user.id, 'garmin');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/garmin/activities', requireUser, async (req, res, next) => {
    try {
      if (!garmin.configured) throw new HttpError(503, 'Garmin is not configured on the server');
      let row = repo.get(req.user.id, 'garmin');
      if (!row && garmin.personal) {
        repo.save(req.user.id, 'garmin', 'personal', '');
        row = repo.get(req.user.id, 'garmin');
      }
      if (!row) throw new HttpError(404, 'Garmin is not connected');
      row = await freshGarminRow(garmin, repo, row);

      const from = one(req.query.from);
      const to = one(req.query.to);
      const since = one(req.query.since);
      if ((from || to) && (!DATE.test(from) || !DATE.test(to) || from > to)) throw new HttpError(400, 'Enter a valid date range');
      if (from && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_RANGE_DAYS) {
        throw new HttpError(400, 'Choose a period of at most a year');
      }
      if (since && !Number.isFinite(Date.parse(since))) throw new HttpError(400, 'Invalid since');

      let fresh = [];
      try {
        fresh = await garmin.fetchActivities(row, { from: from || undefined, to: to || undefined, since: since || undefined });
      } catch (error) {
        if (error?.status === 401) {
          if (!garmin.personal) repo.remove(req.user.id, 'garmin');
          throw new HttpError(401, garmin.personal ? 'Garmin rejected the personal key' : 'Reconnect Garmin');
        }
        if (!(from && to) || garmin.personal) fail(error);
      }
      repo.saveActivities(req.user.id, fresh);
      const stored = from && to ? repo.activitiesBetween(req.user.id, from, to) : repo.activitiesSince(req.user.id, since || '1970-01-01T00:00:00.000Z');
      res.json(stored);
    } catch (error) {
      next(error instanceof GarminError ? new HttpError(502, 'Garmin could not be reached') : error);
    }
  });

  router.get('/strava/connect', requireUser, (req, res) => {
    if (!strava?.configured) {
      return res.redirect(home(config, { strava: 'error', reason: 'Add Strava API credentials on the server, then try again' }));
    }
    const state = randomBytes(32).toString('hex');
    repo.saveRequest(state, req.user.id, 'strava', '');
    const redirectUri = `${config.appOrigins[0]}/api/integrations/strava/callback`;
    res.redirect(strava.authorizeUrl(redirectUri, state));
  });

  router.get('/strava/callback', async (req, res) => {
    const state = one(req.query.state);
    const code = one(req.query.code);
    const pending = state ? repo.takeRequest(state) : null;
    const scope = `${one(req.query.scope)}`;
    if (one(req.query.error) || !pending || pending.provider !== 'strava' || !code) {
      return res.redirect(home(config, { strava: 'error', reason: 'Strava connection was cancelled' }));
    }
    if (!canReadActivities(scope)) {
      return res.redirect(home(config, { strava: 'error', reason: 'Allow Treklin to read your Strava activities' }));
    }
    try {
      const token = await strava.exchangeCode(code);
      repo.save(pending.user_id, 'strava', token.accessToken, token.refreshToken, token.expiresAt);
      res.redirect(home(config, { strava: 'connected' }));
    } catch {
      res.redirect(home(config, { strava: 'error', reason: 'Strava could not finish the connection' }));
    }
  });

  router.delete('/strava', requireUser, async (req, res, next) => {
    try {
      const row = repo.get(req.user.id, 'strava');
      if (row && strava?.configured) {
        let token = row.token;
        try {
          token = await freshStravaToken(strava, repo, row);
        } catch {
          token = row.token;
        }
        try {
          await strava.deauthorize(token);
        } catch (error) {
          if (!(error instanceof StravaError) || (error.status !== 401 && error.status !== 404)) throw error;
        }
      }
      if (row) repo.remove(req.user.id, 'strava');
      res.status(204).end();
    } catch (error) {
      next(error instanceof StravaError ? new HttpError(502, 'Strava could not be reached') : error);
    }
  });

  router.get('/strava/activities', requireUser, async (req, res, next) => {
    try {
      if (!strava?.configured) throw new HttpError(503, 'Strava is not configured on the server');
      const row = repo.get(req.user.id, 'strava');
      if (!row) throw new HttpError(404, 'Strava is not connected');

      const from = one(req.query.from);
      const to = one(req.query.to);
      const since = one(req.query.since);
      if ((from || to) && (!DATE.test(from) || !DATE.test(to) || from > to)) throw new HttpError(400, 'Enter a valid date range');
      if (from && (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > MAX_RANGE_DAYS) {
        throw new HttpError(400, 'Choose a period of at most a year');
      }
      if (since && !Number.isFinite(Date.parse(since))) throw new HttpError(400, 'Invalid since');

      let token;
      try {
        token = await freshStravaToken(strava, repo, row);
      } catch (error) {
        if (error instanceof StravaError && (error.status === 400 || error.status === 401)) {
          repo.remove(req.user.id, 'strava');
          throw new HttpError(404, 'Reconnect Strava');
        }
        throw error;
      }

      let fresh = [];
      try {
        fresh = await strava.fetchActivities(token, { from: from || undefined, to: to || undefined, since: since || undefined });
      } catch (error) {
        if (error instanceof StravaError && error.status === 401) {
          repo.remove(req.user.id, 'strava');
          throw new HttpError(404, 'Reconnect Strava');
        }
        if (error instanceof StravaError) throw new HttpError(502, 'Strava could not be reached');
        throw error;
      }
      repo.saveStravaActivities(req.user.id, fresh);
      const stored = from && to
        ? repo.stravaActivitiesBetween(req.user.id, from, to)
        : repo.stravaActivitiesSince(req.user.id, since || '1970-01-01T00:00:00.000Z');
      res.json(stored);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
