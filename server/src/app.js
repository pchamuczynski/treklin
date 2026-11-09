/**
 * Express application. Built by a factory so tests can inject an in-memory database
 * and a fake Google verifier.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { createGoogleVerifier } from './auth/google.js';
import { createGarminClient } from './integrations/garmin.js';
import { createPersonalGarminClient } from './integrations/garminPersonal.js';
import { createStravaClient } from './integrations/strava.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { loadSession, requireAdmin, requireUser } from './middleware/session.js';
import { createRouteSetRepository } from './repositories/routeSets.js';
import { createUserRepository } from './repositories/users.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createGarminPushHandler, createIntegrationRouter } from './routes/integrations.js';
import { createRouteSetRouter } from './routes/routeSets.js';
import { csrfProtection } from './security/csrf.js';
import { createSessionStore } from './security/sessions.js';

const garminFromConfig = (garmin) =>
  garmin?.consumerKey && garmin?.consumerSecret
    ? createGarminClient(garmin)
    : createPersonalGarminClient({ apiKey: garmin?.personalKey ?? '' });

export const createApp = ({
  config,
  db,
  verifyGoogleCredential = createGoogleVerifier(config.googleClientId),
  garmin = garminFromConfig(config.garmin),
  strava = createStravaClient(config.strava),
}) => {
  const users = createUserRepository(db, { adminEmails: config.adminEmails });
  users.syncAdmins();
  const sessions = createSessionStore(db, { ttlMs: config.sessionTtlMs });
  const routeSets = createRouteSetRepository(db);

  const app = express();
  if (config.trustProxy) {
    app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  }

  app.use(
    helmet({
      // The page's CSP is the <meta> tag generated at build time (see vite.config.js).
      contentSecurityPolicy: false,
      // Google sign-in opens a popup that must be able to report back.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );
  // frame-ancestors cannot be set via <meta>, so it comes from the header (clickjacking protection).
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });
  app.use(cookieParser());
  // Garmin calls this itself, with no session cookie and no CSRF header.
  app.post('/api/integrations/garmin/push', express.json({ limit: '2mb' }), createGarminPushHandler({ db, garmin }));

  const api = express.Router();
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfProtection(config.appOrigins));
  api.use(loadSession({ sessions, cookieName: config.cookie.name }));
  api.use('/auth', express.json({ limit: '10kb' }), createAuthRouter({ users, sessions, db, config, verifyGoogleCredential }));
  api.use('/admin', requireAdmin, express.json({ limit: '10mb' }), createAdminRouter({ users, routeSets, sessions, db }));
  api.use('/routes', requireUser, express.json({ limit: '10mb' }), createRouteSetRouter({ routeSets }));
  api.use('/integrations', createIntegrationRouter({ config, db, garmin, strava }));
  api.use(notFound);
  app.use('/api', api);

  // Production: serve the built frontend from the same origin (no CORS, first-party cookies).
  const clientDist = config.clientDist ? resolve(config.clientDist) : null;
  if (clientDist && existsSync(resolve(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return { app, sessions };
};
