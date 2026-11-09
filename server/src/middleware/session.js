import { HttpError } from './errors.js';

/** Resolves the session cookie to `req.user` (a users row) when it is valid. */
export const loadSession = ({ sessions, cookieName }) => (req, _res, next) => {
  const token = req.cookies?.[cookieName];
  req.sessionToken = token ?? null;
  req.user = token ? sessions.findUser(token) : null;
  next();
};

export const requireUser = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Not signed in')));

export const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  if (!req.user.is_admin) return next(new HttpError(403, 'Not allowed'));
  return next();
};
