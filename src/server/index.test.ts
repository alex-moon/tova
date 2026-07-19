import request from 'supertest';
import { createApp } from './index';

describe('Server bootstrap', () => {
  it('returns an ok health response', async () => {
    const app = createApp();

    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('mounts the auth routes', async () => {
    const app = createApp();

    const response = await request(app).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Not authenticated' });
  });
});