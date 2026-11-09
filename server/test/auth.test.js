import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestServer, googleCredential } from './helpers.js';

const register = (c, body = {}) =>
  c.post('/api/auth/register', { email: 'Runner@Example.com', password: 'correct horse battery', name: 'Runner', ...body });

describe('email + password', () => {
  it('registers, keeps the session, and logs out', async () => {
    const { client } = createTestServer();
    const c = client();

    const created = await register(c);
    expect(created.status).toBe(201);
    expect(created.body.user).toEqual({
      id: expect.any(String),
      email: 'runner@example.com',
      name: 'Runner',
      avatarUrl: null,
      hasPassword: true,
      googleLinked: false,
      isAdmin: false,
    });
    const cookie = created.headers['set-cookie'][0];
    expect(cookie).toMatch(/^mr_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    expect((await c.get('/api/auth/me')).body.user.email).toBe('runner@example.com');

    expect((await c.post('/api/auth/logout')).status).toBe(204);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('never returns password hashes', async () => {
    const { client } = createTestServer();
    const res = await register(client());
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash/);
  });

  it('logs in with the right password only, with a generic error', async () => {
    const { client } = createTestServer();
    await register(client());

    const ok = await client().post('/api/auth/login', { email: 'runner@example.com', password: 'correct horse battery' });
    expect(ok.status).toBe(200);

    const wrongPassword = await client().post('/api/auth/login', { email: 'runner@example.com', password: 'nope-nope' });
    const unknownUser = await client().post('/api/auth/login', { email: 'ghost@example.com', password: 'nope-nope' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownUser.body.error); // no account enumeration via login
  });

  it('validates input', async () => {
    const { client } = createTestServer();
    expect((await register(client(), { email: 'not-an-email' })).body.error).toMatch(/valid email/);
    expect((await register(client(), { password: 'short' })).body.error).toMatch(/at least 8/);
    expect((await register(client(), { password: 'x'.repeat(129) })).status).toBe(400);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    const { client } = createTestServer();
    await register(client());
    const again = await register(client(), { email: 'RUNNER@example.com' });
    expect(again.status).toBe(409);
  });

  it('issues a new session token on every login', async () => {
    const { client, app } = createTestServer();
    const c = client();
    const first = (await register(c)).headers['set-cookie'][0].split(';')[0];
    const second = (await c.post('/api/auth/login', { email: 'runner@example.com', password: 'correct horse battery' })).headers[
      'set-cookie'
    ][0].split(';')[0];
    expect(second).not.toBe(first);
    // the pre-login token is revoked
    const reuse = await request(app).get('/api/auth/me').set('Cookie', first);
    expect(reuse.status).toBe(401);
  });
});

describe('Google sign-in', () => {
  const identity = { sub: 'google-123', email: 'runner@example.com', name: 'Google Runner', picture: 'https://lh3.example/a.png' };

  it('creates an account and signs in again with the same Google identity', async () => {
    const { client } = createTestServer();
    const first = await client().post('/api/auth/google', { credential: googleCredential(identity) });
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({ email: 'runner@example.com', name: 'Google Runner', googleLinked: true, hasPassword: false });

    const second = await client().post('/api/auth/google', { credential: googleCredential(identity) });
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it('rejects invalid tokens and unverified emails', async () => {
    const { client } = createTestServer();
    expect((await client().post('/api/auth/google', { credential: 'invalid' })).status).toBe(401);
    const unverified = await client().post('/api/auth/google', { credential: googleCredential({ ...identity, emailVerified: false }) });
    expect(unverified.status).toBe(401);
  });

  it('takes over an unverified password account with the same email (pre-hijacking protection)', async () => {
    const { client } = createTestServer();
    const attacker = client();
    await register(attacker); // someone registered the victim's email with their own password

    const owner = await client().post('/api/auth/google', { credential: googleCredential(identity) });
    expect(owner.body.user).toMatchObject({ googleLinked: true, hasPassword: false });
    expect(owner.body.notice).toMatch(/linked to Google/);

    expect((await attacker.get('/api/auth/me')).status).toBe(401); // attacker's session revoked
    const passwordLogin = await client().post('/api/auth/login', { email: 'runner@example.com', password: 'correct horse battery' });
    expect(passwordLogin.status).toBe(401); // and their password no longer works
  });

  it('refuses a different Google account for an already linked email', async () => {
    const { client } = createTestServer();
    await client().post('/api/auth/google', { credential: googleCredential(identity) });
    const other = await client().post('/api/auth/google', { credential: googleCredential({ ...identity, sub: 'google-999' }) });
    expect(other.status).toBe(409);
  });

  it('is unavailable when not configured', async () => {
    const { client } = createTestServer({ googleEnabled: false });
    expect((await client().post('/api/auth/google', { credential: 'x' })).status).toBe(404);
  });
});

describe('request protection', () => {
  it('rejects state-changing requests without the CSRF header or from other origins', async () => {
    const { app } = createTestServer();
    const body = { email: 'a@example.com', password: 'long enough pw' };
    expect((await request(app).post('/api/auth/register').send(body)).status).toBe(403);
    const evil = await request(app)
      .post('/api/auth/register')
      .set('X-Requested-With', 'map-runner')
      .set('Origin', 'https://evil.example')
      .send(body);
    expect(evil.status).toBe(403);
  });

  it('rate-limits authentication attempts', async () => {
    const { client } = createTestServer({ env: { NODE_ENV: 'development' } });
    const c = client();
    const attempts = [];
    for (let i = 0; i < 21; i += 1) attempts.push((await c.post('/api/auth/login', { email: 'x@example.com', password: 'wrong-pass' })).status);
    expect(attempts.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(attempts[20]).toBe(429);
  });

  it('sets security headers and does not cache API responses', async () => {
    const { app } = createTestServer();
    const res = await request(app).get('/api/auth/me');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('expires sessions', async () => {
    const { client, sessions } = createTestServer();
    const c = client();
    await register(c);
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(sessions.purgeExpired(later)).toBe(1);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('configuration', () => {
  it('rejects a client secret in place of the Google client ID', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ NODE_ENV: 'test', GOOGLE_CLIENT_ID: 'GOCSPX-not-a-client-id' })).toThrow(/client secret/);
    expect(loadConfig({ NODE_ENV: 'test', GOOGLE_CLIENT_ID: '123456789012-abcdef123.apps.googleusercontent.com' }).googleClientId).toMatch(
      /apps\.googleusercontent\.com$/,
    );
  });
});
