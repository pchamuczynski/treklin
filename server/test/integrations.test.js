import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './helpers.js';

const register = (c) => c.post('/api/auth/register', { email: 'runner@example.com', password: 'correct horse battery', name: 'Runner' });

const garmin = {
  configured: true,
  beginConnect: async () => ({
    authorizeUrl: 'https://connect.garmin.com/oauthConfirm?oauth_token=req',
    requestToken: 'req',
    requestSecret: 'sec',
  }),
  finishConnect: async ({ code }) => {
    if (code !== 'ok') throw Object.assign(new Error('denied'), { status: 400 });
    return { token: 'access', secret: 'access-secret', externalUserId: 'garmin-user' };
  },
  fetchActivities: async () => [
    {
      activityId: 42,
      activityType: 'RUNNING',
      distanceInMeters: 5000,
      startTimeInSeconds: 1740000000,
      startTimeOffsetInSeconds: 0,
    },
  ],
  deregister: async () => {},
};

describe('Garmin integration', () => {
  it('connects, stores pushed activities, and disconnects', async () => {
    const { app, client } = createTestServer({ garmin });
    const c = client();
    await register(c);

    expect((await c.get('/api/integrations')).body).toEqual({ connected: [] });

    const connect = await c.get('/api/integrations/garmin/connect');
    expect(connect.status).toBe(302);
    expect(connect.headers.location).toBe('https://connect.garmin.com/oauthConfirm?oauth_token=req');

    const callback = await c.get('/api/integrations/garmin/callback?code=ok&state=req');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('garmin=connected');
    expect((await c.get('/api/integrations')).body.connected).toEqual(['garmin']);

    const activities = await c.get('/api/integrations/garmin/activities?from=2025-01-01&to=2025-02-20');
    expect(activities.status).toBe(200);
    expect(activities.body.map((item) => item.activityId)).toEqual([42]);
    expect(JSON.stringify(activities.body)).not.toMatch(/access-secret|userAccessToken/);

    const pushed = await request(app)
      .post('/api/integrations/garmin/push')
      .send({
        activities: [
          {
            userId: 'garmin-user',
            activityId: 99,
            activityType: 'CYCLING',
            distanceInMeters: 1000,
            startTimeInSeconds: 1740001000,
          },
        ],
      });
    expect(pushed.status).toBe(200);

    const afterPush = await c.get('/api/integrations/garmin/activities?from=2025-01-01&to=2025-02-20');
    expect(afterPush.body.map((item) => item.activityId).sort()).toEqual([42, 99]);

    expect((await c.del('/api/integrations/garmin')).status).toBe(204);
    expect((await c.get('/api/integrations')).body.connected).toEqual([]);
    expect((await request(app).post('/api/integrations/garmin/push').send({
      activities: [{ userId: 'garmin-user', activityId: 100, activityType: 'RUNNING', distanceInMeters: 1, startTimeInSeconds: 1740002000 }],
    })).status).toBe(200);
    expect((await c.get('/api/integrations/garmin/activities?since=2020-01-01T00:00:00.000Z')).status).toBe(404);
  });

  it('imports with a personal key without an OAuth redirect', async () => {
    const personal = {
      configured: true,
      personal: true,
      fetchActivities: async () => [
        {
          activityId: 7,
          activityType: 'RUNNING',
          distanceInMeters: 1000,
          startTimeInSeconds: 1740000000,
          startTimeOffsetInSeconds: 0,
        },
      ],
      deregister: async () => {
        throw new Error('personal key has nothing to deregister');
      },
    };
    const { client } = createTestServer({ garmin: personal });
    const c = client();
    await register(c);

    const activities = await c.get('/api/integrations/garmin/activities?from=2025-01-01&to=2025-02-20');
    expect(activities.status).toBe(200);
    expect(activities.body.map((item) => item.activityId)).toEqual([7]);
    expect((await c.get('/api/integrations')).body.connected).toEqual(['garmin']);

    expect((await c.del('/api/integrations/garmin')).status).toBe(204);
    expect((await c.get('/api/integrations')).body.connected).toEqual([]);
  });

  it('explains when Garmin credentials are missing', async () => {
    const { client } = createTestServer();
    const c = client();
    await register(c);
    const connect = await c.get('/api/integrations/garmin/connect');
    expect(connect.status).toBe(302);
    expect(connect.headers.location).toContain('garmin=error');
    expect(decodeURIComponent(connect.headers.location)).toMatch(/credentials/);
  });
});
