/**
 * Server configuration from environment variables (see server/.env.example).
 * Invalid configuration fails fast at startup.
 */
import { z } from 'zod';

/** OAuth client IDs look like "123456789-abc123.apps.googleusercontent.com"; secrets start with "GOCSPX-". */
export const GOOGLE_CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default('./data/map-runner.sqlite'),
  // Comma-separated origins allowed to call the API (the frontend's URL).
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z
    .string()
    .trim()
    .default('')
    .refine((value) => value === '' || GOOGLE_CLIENT_ID_PATTERN.test(value), {
      message: 'must be an OAuth client ID ending in .apps.googleusercontent.com (not the client secret)',
    }),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Set when running behind a reverse proxy, e.g. "1" (hops) or "loopback".
  TRUST_PROXY: z.string().default(''),
  // Path to the built frontend (../dist) to serve it from this server in production.
  CLIENT_DIST: z.string().default(''),
  // Garmin Health API consumer credentials from https://developerportal.garmin.com/
  GARMIN_CONSUMER_KEY: z.string().trim().default(''),
  GARMIN_CONSUMER_SECRET: z.string().trim().default(''),
  // Personal API key. Reads only the key owner's data, used when the consumer pair is absent.
  GARMIN_PERSONAL_KEY: z.string().trim().default(''),
  // Strava API application. The secret never leaves the server.
  // Authorization Callback Domain is the host of APP_ORIGIN (treklin.com, or localhost for local testing).
  STRAVA_CLIENT_ID: z.string().trim().default(''),
  STRAVA_CLIENT_SECRET: z.string().trim().default(''),
  // Comma-separated account emails that may open /admin. Empty disables the panel.
  ADMIN_EMAILS: z.string().default(''),
});

export const loadConfig = (env = process.env) => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid server configuration - ${problems}`);
  }
  const values = parsed.data;
  const isProduction = values.NODE_ENV === 'production';
  const adminEmails = parseAdminEmails(values.ADMIN_EMAILS);

  return Object.freeze({
    env: values.NODE_ENV,
    port: values.PORT,
    databasePath: values.DATABASE_PATH,
    appOrigins: values.APP_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    googleClientId: values.GOOGLE_CLIENT_ID.trim(),
    sessionTtlMs: values.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    trustProxy: values.TRUST_PROXY.trim(),
    clientDist: values.CLIENT_DIST.trim(),
    garmin: Object.freeze({
      consumerKey: values.GARMIN_CONSUMER_KEY,
      consumerSecret: values.GARMIN_CONSUMER_SECRET,
      personalKey: values.GARMIN_PERSONAL_KEY,
    }),
    strava: Object.freeze({
      clientId: values.STRAVA_CLIENT_ID,
      clientSecret: values.STRAVA_CLIENT_SECRET,
    }),
    // Secure cookies require HTTPS; the __Host- prefix additionally pins the cookie to this exact host.
    cookie: Object.freeze({
      name: isProduction ? '__Host-mr_session' : 'mr_session',
      secure: isProduction,
    }),
    // Auth attempts per IP per 15 minutes (relaxed only for automated tests).
    authRateLimit: values.NODE_ENV === 'test' ? 1000 : 20,
    adminEmails,
  });
};

/** Lowercased, de-duplicated account emails. Invalid entries fail startup. */
const parseAdminEmails = (value) => {
  const emails = [...new Set(value.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean))];
  const invalid = emails.filter((item) => !z.email().safeParse(item).success);
  if (invalid.length > 0) {
    throw new Error(`Invalid server configuration - ADMIN_EMAILS: ${invalid.join(', ')}`);
  }
  return Object.freeze(emails);
};
