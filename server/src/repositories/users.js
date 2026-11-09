import { randomUUID } from 'node:crypto';
import { transaction } from '../db.js';

/** The shape returned to the client - never includes hashes or provider ids. */
export const toPublicUser = (row) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  avatarUrl: row.avatar_url ?? null,
  hasPassword: Boolean(row.password_hash),
  googleLinked: Boolean(row.google_sub),
  isAdmin: Boolean(row.is_admin),
});

/** Account fields an admin may see. Still excludes hashes and provider ids. */
export const toAdminUser = (row) => ({
  ...toPublicUser(row),
  emailVerified: Boolean(row.email_verified),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const likePattern = (query) => `%${String(query).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export const createUserRepository = (db, { adminEmails = [] } = {}) => {
  const listed = new Set(adminEmails.map((email) => email.toLowerCase()));
  const isListed = (email) => listed.has(String(email).toLowerCase());

  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const byGoogleSub = db.prepare('SELECT * FROM users WHERE google_sub = ?');
  const insert = db.prepare(`
    INSERT INTO users (id, email, email_verified, password_hash, google_sub, name, avatar_url, is_admin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const linkGoogle = db.prepare(`
    UPDATE users SET google_sub = ?, email_verified = 1, avatar_url = COALESCE(avatar_url, ?),
      password_hash = CASE WHEN ? THEN NULL ELSE password_hash END, updated_at = ?
    WHERE id = ?
  `);
  const updateAccountStmt = db.prepare(`
    UPDATE users SET email = ?, email_verified = ?, name = ?, is_admin = ?, updated_at = ? WHERE id = ?
  `);
  const setAdminFlag = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
  const listStmt = db.prepare(`
    SELECT * FROM users
    WHERE (? = '' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
    ORDER BY created_at DESC, id ASC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS total FROM users
    WHERE (? = '' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
  `);
  const allAccounts = db.prepare('SELECT id, email, is_admin FROM users');

  const create = ({ email, name, passwordHash = null, googleSub = null, emailVerified = false, avatarUrl = null }) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    insert.run(id, email, emailVerified ? 1 : 0, passwordHash, googleSub, name, avatarUrl, isListed(email) ? 1 : 0, now, now);
    return byId.get(id);
  };

  return {
    findById: (id) => byId.get(id) ?? null,
    findByEmail: (email) => byEmail.get(email) ?? null,
    findByGoogleSub: (sub) => byGoogleSub.get(sub) ?? null,
    create,
    /** Attaches a Google identity; `clearPassword` removes a password set before the email was verified. */
    linkGoogle(id, { googleSub, avatarUrl, clearPassword }) {
      linkGoogle.run(googleSub, avatarUrl ?? null, clearPassword ? 1 : 0, new Date().toISOString(), id);
      return byId.get(id);
    },
    /**
     * Makes `is_admin` match the configured email list.
     * Called at startup so accounts that already exist pick up ADMIN_EMAILS without a re-register.
     * @returns {number} rows whose flag changed
     */
    syncAdmins() {
      return transaction(db, () => {
        let changed = 0;
        for (const row of allAccounts.all()) {
          const next = isListed(row.email) ? 1 : 0;
          if (Number(row.is_admin) !== next) {
            setAdminFlag.run(next, row.id);
            changed += 1;
          }
        }
        return changed;
      });
    },
    list({ query = '', limit = 50, offset = 0 } = {}) {
      const pattern = likePattern(query);
      return {
        users: listStmt.all(query, pattern, pattern, limit, offset),
        total: countStmt.get(query, pattern, pattern).total,
      };
    },
    /**
     * Updates the account fields an admin is allowed to change.
     * Admin status follows the email list, so renaming onto or off that list updates the flag.
     * @returns {object | null} the updated row, or null when the id does not exist
     */
    updateAccount(id, { email, name, emailVerified }) {
      return transaction(db, () => {
        const current = byId.get(id);
        if (!current) return null;
        const nextEmail = email ?? current.email;
        const nextName = name ?? current.name;
        const nextVerified = emailVerified == null ? current.email_verified : emailVerified ? 1 : 0;
        if (nextEmail !== current.email && byEmail.get(nextEmail)) {
          const error = new Error('An account with this email already exists.');
          error.code = 'EMAIL_TAKEN';
          throw error;
        }
        updateAccountStmt.run(nextEmail, nextVerified, nextName, isListed(nextEmail) ? 1 : 0, new Date().toISOString(), id);
        return byId.get(id);
      });
    },
  };
};
