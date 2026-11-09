import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';

export const ORIGIN = 'http://localhost:5173';

/** Fake Google verifier: the "credential" is a JSON-encoded identity; "invalid" fails verification. */
const fakeGoogleVerifier = async (credential) => {
  if (credential === 'invalid') throw new Error('bad token');
  return { emailVerified: true, name: null, picture: null, ...JSON.parse(credential) };
};

export const createTestServer = ({ googleEnabled = true, env = {}, garmin, strava } = {}) => {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: ORIGIN, ...env });
  const db = openDatabase(':memory:');
  const { app, sessions } = createApp({
    config,
    db,
    verifyGoogleCredential: googleEnabled ? fakeGoogleVerifier : null,
    ...(garmin ? { garmin } : {}),
    ...(strava ? { strava } : {}),
  });

  /** A cookie-keeping client that sends the headers the real frontend sends. */
  const client = () => {
    const agent = request.agent(app);
    const withHeaders = (req) => req.set('X-Requested-With', 'map-runner').set('Origin', ORIGIN);
    return {
      get: (path) => agent.get(path),
      post: (path, body) => withHeaders(agent.post(path)).send(body),
      put: (path, body) => withHeaders(agent.put(path)).send(body),
      patch: (path, body) => withHeaders(agent.patch(path)).send(body),
      del: (path) => withHeaders(agent.delete(path)),
      raw: agent,
    };
  };

  return { app, db, sessions, config, client };
};

export const googleCredential = (identity) => JSON.stringify(identity);
