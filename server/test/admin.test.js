import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestServer, googleCredential, ORIGIN } from './helpers.js';

const route = (id, extra = {}) => ({
  id,
  name: `Route ${id}`,
  from: 'Warsaw',
  to: 'Krakow',
  activities: ['Running'],
  coordinates: [
    [52.2297, 21.0122],
    [50.0647, 19.945],
  ],
  distance: 295000,
  duration: 10000,
  provider: 'osrm',
  workouts: [],
  createdAt: '2025-01-01T00:00:00.000Z',
  ...extra,
});

const register = (c, body = {}) =>
  c.post('/api/auth/register', { email: 'runner@example.com', password: 'correct horse battery', name: 'Runner', ...body });

const adminServer = () => createTestServer({ env: { ADMIN_EMAILS: 'admin@example.com' } });

describe('/api/admin', () => {
  it('rejects anonymous and ordinary accounts', async () => {
    const server = adminServer();
    expect((await server.client().get('/api/admin/users')).status).toBe(401);

    const member = await register(server.client(), { email: 'runner@example.com' });
    expect(member.body.user.isAdmin).toBe(false);
    expect((await server.client().get('/api/admin/users')).status).toBe(401);

    const signedIn = server.client();
    await register(signedIn, { email: 'member@example.com', name: 'Member' });
    expect((await signedIn.get('/api/admin/users')).status).toBe(403);
  });

  it('lists and updates accounts without exposing secrets', async () => {
    const server = adminServer();
    const admin = server.client();
    const created = await register(admin, { email: 'admin@example.com', name: 'Admin' });
    expect(created.body.user.isAdmin).toBe(true);
    const adminId = created.body.user.id;

    const member = server.client();
    const memberCreated = await register(member, { email: 'runner@example.com', name: '100%' });
    const memberId = memberCreated.body.user.id;
    await member.put('/api/routes', { version: 0, routes: [route('r1'), route('bad', { coordinates: [[999, 999]] })] });
    const now = new Date().toISOString();
    server.db
      .prepare(
        `INSERT INTO integrations (user_id, provider, token, token_secret, created_at, updated_at)
         VALUES (?, 'strava', 'access-token-secret', 'refresh-token-secret', ?, ?)`,
      )
      .run(memberId, now, now);

    const listed = await admin.get('/api/admin/users?q=%');
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.users.map((user) => user.email)).toEqual(['runner@example.com']);
    expect(JSON.stringify(listed.body)).not.toMatch(/password_hash|argon2|google_sub|access-token-secret|refresh-token-secret/);

    const detail = await admin.get(`/api/admin/users/${memberId}`);
    expect(detail.body.user).toMatchObject({
      email: 'runner@example.com',
      name: '100%',
      emailVerified: false,
      hasPassword: true,
      isAdmin: false,
    });
    expect(detail.body.connections).toEqual(['strava']);
    expect(detail.body.routes.routes.map((item) => item.id)).toEqual(['r1']);
    expect(JSON.stringify(detail.body)).not.toMatch(/password_hash|access-token-secret|refresh-token-secret|google_sub/);

    const renamed = await admin.patch(`/api/admin/users/${memberId}`, {
      name: 'Pat',
      email: 'Pat@Example.com',
      emailVerified: true,
      password: 'should-be-ignored',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.user).toMatchObject({ name: 'Pat', email: 'pat@example.com', emailVerified: true, isAdmin: false });
    expect((await member.post('/api/auth/login', { email: 'pat@example.com', password: 'correct horse battery' })).status).toBe(200);

    const taken = await admin.patch(`/api/admin/users/${memberId}`, { email: 'admin@example.com' });
    expect(taken.status).toBe(409);

    const saved = await admin.put(`/api/admin/users/${memberId}/routes`, {
      version: detail.body.routes.version,
      routes: [route('r2'), 'junk'],
    });
    expect(saved.body).toMatchObject({ version: 2, dropped: 1 });
    expect(saved.body.routes.map((item) => item.id)).toEqual(['r2']);
    expect((await member.get('/api/routes')).body.routes.map((item) => item.id)).toEqual(['r2']);

    const stale = await admin.put(`/api/admin/users/${memberId}/routes`, { version: 0, routes: [route('r3')] });
    expect(stale.status).toBe(409);

    expect((await admin.post(`/api/admin/users/${memberId}/sessions/revoke`)).status).toBe(204);
    expect((await member.get('/api/auth/me')).status).toBe(401);
    expect((await admin.get('/api/auth/me')).body.user.id).toBe(adminId);
  });

  it('removes admin access when the account email leaves the allowlist', async () => {
    const server = adminServer();
    const admin = server.client();
    const { id } = (await register(admin, { email: 'admin@example.com', name: 'Admin' })).body.user;

    const moved = await admin.patch(`/api/admin/users/${id}`, { email: 'moved@example.com' });
    expect(moved.body.user.isAdmin).toBe(false);
    expect((await admin.get('/api/admin/users')).status).toBe(403);
  });

  it('promotes an existing account when the server starts with that email', async () => {
    const first = createTestServer();
    const created = await register(first.client(), { email: 'admin@example.com', name: 'Admin' });
    expect(created.body.user.isAdmin).toBe(false);
    const cookie = created.headers['set-cookie'][0].split(';')[0];

    const promotedConfig = loadConfig({
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      APP_ORIGIN: ORIGIN,
      ADMIN_EMAILS: 'Admin@Example.com',
    });
    const promoted = createApp({ config: promotedConfig, db: first.db, verifyGoogleCredential: null });
    const me = await request(promoted.app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.isAdmin).toBe(true);

    const demotedConfig = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: ORIGIN, ADMIN_EMAILS: '' });
    const demoted = createApp({ config: demotedConfig, db: first.db, verifyGoogleCredential: null });
    const again = await request(demoted.app).get('/api/auth/me').set('Cookie', cookie);
    expect(again.body.user.isAdmin).toBe(false);
  });

  it('rejects an invalid admin email list', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ADMIN_EMAILS: 'not-an-email, admin@example.com' })).toThrow(/ADMIN_EMAILS/);
    expect(loadConfig({ NODE_ENV: 'test', ADMIN_EMAILS: ' Admin@Example.com, admin@example.com ' }).adminEmails).toEqual(['admin@example.com']);
  });

  it('keeps a Google account visible without its provider id', async () => {
    const server = adminServer();
    const admin = server.client();
    await register(admin, { email: 'admin@example.com', name: 'Admin' });
    await server.client().post('/api/auth/google', {
      credential: googleCredential({ sub: 'google-secret-sub', email: 'google@example.com', name: 'Google Runner' }),
    });

    const listed = await admin.get('/api/admin/users?q=google@example.com');
    expect(listed.body.users[0]).toMatchObject({ email: 'google@example.com', googleLinked: true, hasPassword: false });
    expect(JSON.stringify(listed.body)).not.toMatch(/google-secret-sub/);
  });
});
