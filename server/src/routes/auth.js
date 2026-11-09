/**
 * /api/auth - email/password and Google sign-in, sign-out, current user.
 */
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { transaction } from '../db.js';
import { HttpError } from '../middleware/errors.js';
import { requireUser } from '../middleware/session.js';
import { toPublicUser } from '../repositories/users.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from '../security/passwords.js';

export const emailField = z
  .string({ error: 'Enter your email address' })
  .trim()
  .toLowerCase()
  .max(254, 'Email address is too long')
  .pipe(z.email('Enter a valid email address'));

const password = z
  .string({ error: 'Enter a password' })
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const cleanName = (value) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

const registerBody = z.object({ email: emailField, password, name: z.string().max(200).optional() });
const loginBody = z.object({
  email: emailField,
  password: z.string({ error: 'Enter your password' }).min(1).max(PASSWORD_MAX_LENGTH),
});
const googleBody = z.object({ credential: z.string().min(1).max(4096) });

const INVALID_CREDENTIALS = 'Invalid email or password';

export const createAuthRouter = ({ users, sessions, db, config, verifyGoogleCredential }) => {
  const router = express.Router();

  // Throttle credential guessing and account creation per client IP.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.')),
  });

  const startSession = (req, res, userId) => {
    sessions.revoke(req.sessionToken); // never reuse a pre-login session (fixation)
    const { token, expiresAt } = sessions.create(userId);
    res.cookie(config.cookie.name, token, {
      httpOnly: true,
      secure: config.cookie.secure,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  };

  router.post('/register', limiter, async (req, res) => {
    const body = registerBody.parse(req.body);
    if (users.findByEmail(body.email)) {
      throw new HttpError(409, 'An account with this email already exists. Log in instead.');
    }
    const user = users.create({
      email: body.email,
      name: cleanName(body.name) || body.email.split('@')[0],
      passwordHash: await hashPassword(body.password),
    });
    startSession(req, res, user.id);
    res.status(201).json({ user: toPublicUser(user) });
  });

  router.post('/login', limiter, async (req, res) => {
    const body = loginBody.parse(req.body);
    const user = users.findByEmail(body.email);
    const valid = await verifyPassword(user?.password_hash, body.password);
    if (!user || !valid) throw new HttpError(401, INVALID_CREDENTIALS);
    startSession(req, res, user.id);
    res.json({ user: toPublicUser(user) });
  });

  router.post('/google', limiter, async (req, res) => {
    if (!verifyGoogleCredential) throw new HttpError(404, 'Google sign-in is not configured');
    const { credential } = googleBody.parse(req.body);

    const identity = await verifyGoogleCredential(credential).catch((error) => {
      // The reason (e.g. wrong audience, expired) helps diagnose setup problems; the token itself is never logged.
      console.warn(`Google token rejected: ${error.message}`);
      return null;
    });
    if (!identity) throw new HttpError(401, 'Google sign-in failed. Please try again.');
    if (!identity.email || !identity.emailVerified) {
      throw new HttpError(401, 'Your Google account has no verified email address.');
    }

    let notice = null;
    const user = transaction(db, () => {
      const linked = users.findByGoogleSub(identity.sub);
      if (linked) return linked;

      const existing = users.findByEmail(identity.email);
      if (!existing) {
        return users.create({
          email: identity.email,
          name: cleanName(identity.name) || identity.email.split('@')[0],
          googleSub: identity.sub,
          emailVerified: true,
          avatarUrl: identity.picture,
        });
      }
      if (existing.google_sub) throw new HttpError(409, 'This email is linked to a different Google account.');

      // The password on an unverified account may have been set by someone who does not own the
      // email address (account pre-hijacking). Google has just proven ownership, so the verified
      // owner takes over: the password is removed and all other sessions are signed out.
      const clearPassword = !existing.email_verified && Boolean(existing.password_hash);
      if (clearPassword) {
        sessions.revokeAllForUser(existing.id);
        notice = 'Your account is now linked to Google. Please sign in with Google from now on.';
      }
      return users.linkGoogle(existing.id, { googleSub: identity.sub, avatarUrl: identity.picture, clearPassword });
    });

    startSession(req, res, user.id);
    res.json({ user: toPublicUser(user), notice });
  });

  router.post('/logout', (req, res) => {
    sessions.revoke(req.sessionToken);
    res.clearCookie(config.cookie.name, { httpOnly: true, secure: config.cookie.secure, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });

  router.get('/me', requireUser, (req, res) => {
    res.json({ user: toPublicUser(req.user) });
  });

  return router;
};
