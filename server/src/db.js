/**
 * SQLite via Node's built-in driver (node:sqlite) - no native dependencies.
 * Schema changes are append-only migrations applied at startup.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  // 1: accounts, sessions and per-user route storage
  `
  CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    password_hash  TEXT,
    google_sub     TEXT UNIQUE,
    name           TEXT NOT NULL,
    avatar_url     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  CREATE INDEX sessions_expires_at ON sessions(expires_at);

  CREATE TABLE route_sets (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 2: connected providers (Garmin OAuth tokens) and activities Garmin has pushed
  `
  CREATE TABLE integrations (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    token        TEXT NOT NULL,
    token_secret TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );
  CREATE INDEX integrations_token ON integrations(provider, token);

  CREATE TABLE oauth_requests (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    token_secret TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE garmin_activities (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    payload     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, external_id)
  );
  `,
  // 3: Strava OAuth expiry and the activities pulled for a user
  `
  ALTER TABLE integrations ADD COLUMN expires_at TEXT;

  CREATE TABLE strava_activities (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    payload     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, external_id)
  );
  `,
  // 4: Garmin Connect user id, used to match OAuth 2 push notifications
  `
  ALTER TABLE integrations ADD COLUMN external_id TEXT;
  CREATE INDEX integrations_external_id ON integrations(provider, external_id);
  `,
  // 5: accounts allowed to open the admin panel. ADMIN_EMAILS is applied at startup.
  `
  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  `,
];

/** Runs `fn` atomically; rolls back if it throws. */
export const transaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

const migrate = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { current } = db.prepare('SELECT COALESCE(MAX(version), 0) AS current FROM schema_migrations').get();
  MIGRATIONS.slice(current).forEach((sql, index) => {
    transaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        current + index + 1,
        new Date().toISOString(),
      );
    });
  });
};

export const openDatabase = (path) => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
};
