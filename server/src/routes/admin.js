/**
 * /api/admin - browse and correct accounts. Password hashes and provider tokens are never returned.
 * Who counts as an admin comes from ADMIN_EMAILS, applied to the users.is_admin column.
 */
import express from 'express';
import { z } from 'zod';
import { sanitizeRoutes } from '../../../src/domain/schema.js';
import { HttpError } from '../middleware/errors.js';
import { createIntegrationRepository } from '../repositories/integrations.js';
import { toAdminUser } from '../repositories/users.js';
import { cleanName, emailField } from './auth.js';

const MAX_ROUTES = 500;

const listQuery = z.object({
  q: z.string().max(100).optional().default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const userParams = z.object({ id: z.uuid('Unknown account') });

const patchBody = z
  .object({
    name: z.string().max(200).optional(),
    email: emailField.optional(),
    emailVerified: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.email !== undefined || value.emailVerified !== undefined, {
    message: 'Nothing to update',
  });

const routesBody = z.object({
  version: z.number().int().min(0),
  routes: z.array(z.unknown()).max(MAX_ROUTES, `At most ${MAX_ROUTES} routes`),
});

export const createAdminRouter = ({ users, routeSets, sessions, db }) => {
  const router = express.Router();
  const integrations = createIntegrationRepository(db);

  const loadUser = (id) => {
    const user = users.findById(userParams.parse({ id }).id);
    if (!user) throw new HttpError(404, 'Unknown account');
    return user;
  };

  router.get('/users', (req, res) => {
    const query = listQuery.parse(req.query);
    const { users: rows, total } = users.list({ query: query.q.trim(), limit: query.limit, offset: query.offset });
    res.json({ users: rows.map(toAdminUser), total });
  });

  router.get('/users/:id', (req, res) => {
    const user = loadUser(req.params.id);
    res.json({
      user: toAdminUser(user),
      connections: integrations.list(user.id),
      routes: routeSets.get(user.id),
    });
  });

  router.patch('/users/:id', (req, res) => {
    const user = loadUser(req.params.id);
    const body = patchBody.parse(req.body);
    const name = body.name === undefined ? undefined : cleanName(body.name);
    if (body.name !== undefined && !name) throw new HttpError(400, 'Enter a name');

    let updated;
    try {
      updated = users.updateAccount(user.id, {
        name,
        email: body.email,
        emailVerified: body.emailVerified,
      });
    } catch (error) {
      if (error?.code === 'EMAIL_TAKEN') throw new HttpError(409, error.message);
      throw error;
    }
    res.json({ user: toAdminUser(updated) });
  });

  router.put('/users/:id/routes', (req, res) => {
    const user = loadUser(req.params.id);
    const body = routesBody.parse(req.body);
    const routes = sanitizeRoutes(body.routes);
    const result = routeSets.save(user.id, routes, body.version);
    if (!result.ok) {
      throw new HttpError(409, 'These routes were changed elsewhere.', { version: result.version });
    }
    res.json({ version: result.version, routes, dropped: body.routes.length - routes.length });
  });

  router.post('/users/:id/sessions/revoke', (req, res) => {
    const user = loadUser(req.params.id);
    sessions.revokeAllForUser(user.id);
    res.status(204).end();
  });

  return router;
};
