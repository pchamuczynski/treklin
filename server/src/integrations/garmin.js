/**
 * Garmin Connect Developer Program client (OAuth 2.0 with PKCE).
 * New activities arrive on the push endpoint. A pull is attempted for recent
 * uploads; Starter-tier apps are push-only, and a refused pull is empty.
 */
import { createHash, randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://connect.garmin.com/oauth2Confirm';
const TOKEN_URLS = [
  'https://diauth.garmin.com/di-oauth2-service/oauth/token',
  'https://connectapi.garmin.com/di-oauth2-service/oauth/token',
];
const API_URL = 'https://apis.garmin.com/wellness-api/rest';
const PULL_HOSTS = new Set(['apis.garmin.com', 'healthapi.garmin.com']);

const DAY = 24 * 60 * 60;
const BACKFILL_DAYS = 30;

export class GarminError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GarminError';
    this.status = status;
  }
}

const asSummaries = (body) => {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.activities)) return body.activities.filter((item) => item?.activityType || item?.activityId || item?.summaryId);
  return [];
};

/** Drops the user's access token before a summary is stored or sent to the browser. */
export const publicSummary = (summary) => {
  if (!summary || typeof summary !== 'object') return null;
  const rest = { ...summary };
  delete rest.userAccessToken;
  delete rest.userId;
  return rest;
};

const unixDay = (isoDate, endOfDay) => {
  const time = Date.parse(`${isoDate}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
};

const backfillWindows = (from, to) => {
  const start = unixDay(from, false);
  const end = unixDay(to, true);
  if (start == null || end == null || start > end) return [];
  const windows = [];
  for (let cursor = start; cursor <= end; cursor += BACKFILL_DAYS * DAY) {
    windows.push([cursor, Math.min(cursor + BACKFILL_DAYS * DAY - 1, end)]);
  }
  return windows;
};

const accessTokenOf = (token) => token?.token ?? token;

const expiresAtOf = (payload) => {
  const seconds = Number(payload?.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DAY;
  return new Date(Date.now() + lifetime * 1000).toISOString();
};

const userIdOf = (body) => {
  if (typeof body === 'string' && body.trim()) return body.trim();
  const id = body?.userId ?? body?.user_id;
  return id == null || id === '' ? null : String(id);
};

const refusedPull = (error) => error instanceof GarminError && [403, 404, 412].includes(error.status);

/**
 * @param {{ consumerKey: string, consumerSecret: string }} credentials
 * @param {typeof fetch} [fetchImpl]
 */
export const createGarminClient = ({ consumerKey = '', consumerSecret = '' } = {}, fetchImpl = fetch) => {
  const configured = Boolean(consumerKey && consumerSecret);

  const tokenRequest = async (fields) => {
    let lastError = new GarminError(502, 'Garmin could not be reached');
    for (const url of TOKEN_URLS) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(fields),
        });
      } catch {
        continue;
      }
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.access_token) return payload;
      lastError = new GarminError(response.status, 'Garmin rejected the token request');
      if (response.status !== 404 && response.status !== 405) throw lastError;
    }
    throw lastError;
  };

  const bearer = async (method, url, accessToken, query = null) => {
    const qs = query
      ? new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString()
      : '';
    const response = await fetchImpl(qs ? `${url}?${qs}` : url, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    const text = await response.text();
    if (response.status === 409) return null;
    if (!response.ok) throw new GarminError(response.status, `Garmin request failed (${response.status})`);
    if (!text) return null;
    return response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  };

  return {
    configured,

    beginConnect(callbackUrl) {
      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const params = new URLSearchParams({
        client_id: consumerKey,
        code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
        code_challenge_method: 'S256',
        redirect_uri: callbackUrl,
        response_type: 'code',
        state,
      });
      return {
        requestToken: state,
        requestSecret: codeVerifier,
        authorizeUrl: `${AUTHORIZE_URL}?${params}`,
      };
    },

    async finishConnect({ code, codeVerifier, redirectUri }) {
      const payload = await tokenRequest({
        client_id: consumerKey,
        client_secret: consumerSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const externalUserId = userIdOf(await bearer('GET', `${API_URL}/user/id`, payload.access_token));
      if (!externalUserId) throw new GarminError(502, 'Garmin did not return a user id');
      return {
        token: payload.access_token,
        secret: payload.refresh_token,
        expiresAt: expiresAtOf(payload),
        externalUserId,
      };
    },

    async refresh(row) {
      const payload = await tokenRequest({
        client_id: consumerKey,
        client_secret: consumerSecret,
        grant_type: 'refresh_token',
        refresh_token: row.token_secret,
      });
      return {
        token: payload.access_token,
        secret: payload.refresh_token || row.token_secret,
        expiresAt: expiresAtOf(payload),
        externalUserId: row.external_id ?? null,
      };
    },

    /**
     * Recent uploads, when the app is allowed to pull them, plus a backfill
     * request for a history range. Backfill is delivered later to the push endpoint.
     * A push-only app responds 403 or 404; that is an empty pull, not a failure.
     */
    async fetchActivities(token, { from, to, since } = {}) {
      const accessToken = accessTokenOf(token);
      if (from && to) {
        for (const [summaryStartTimeInSeconds, summaryEndTimeInSeconds] of backfillWindows(from, to)) {
          try {
            await bearer('GET', `${API_URL}/backfill/activities`, accessToken, { summaryStartTimeInSeconds, summaryEndTimeInSeconds });
          } catch (error) {
            if (refusedPull(error)) break;
            throw error;
          }
        }
      }
      const end = Math.floor(Date.now() / 1000);
      const sinceSec = since ? Math.floor(Date.parse(since) / 1000) : end - DAY;
      const uploadStartTimeInSeconds = Math.max(end - DAY, Number.isFinite(sinceSec) ? sinceSec : end - DAY);
      try {
        const pulled = await bearer('GET', `${API_URL}/activities`, accessToken, { uploadStartTimeInSeconds, uploadEndTimeInSeconds: end });
        return asSummaries(pulled).map(publicSummary).filter(Boolean);
      } catch (error) {
        if (refusedPull(error)) return [];
        throw error;
      }
    },

    /** Fetches a ping notification's callback, which must stay on Garmin's API host. */
    async pullUrl(token, callbackUrl) {
      const url = new URL(callbackUrl);
      if (url.protocol !== 'https:' || !PULL_HOSTS.has(url.hostname)) {
        throw new GarminError(400, 'Unexpected Garmin callback');
      }
      const pulled = await bearer('GET', url.toString(), accessTokenOf(token));
      return asSummaries(pulled).map(publicSummary).filter(Boolean);
    },

    async deregister(token) {
      try {
        await bearer('DELETE', `${API_URL}/user/registration`, accessTokenOf(token));
      } catch (error) {
        if (error?.status !== 401 && error?.status !== 404) throw error;
      }
    },
  };
};
