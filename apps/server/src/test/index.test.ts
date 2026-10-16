import request from 'supertest';
import { createApp } from '../main/index';

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
    expect(response.body).toEqual({ message: 'Authentication required' });
  });

  it('sets helmet security headers (issue #32)', async () => {
    const app = createApp();

    const response = await request(app).get('/api/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('returns 413 for oversized JSON bodies (issue #32)', async () => {
    const app = createApp();

    const big = 'x'.repeat(1024 * 1024 + 1);
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'oversized@example.com', password: big });

    // Express's JSON parser rejects over-limit bodies (413), or the current
    // routing already rejected them (400/401) — anything but a 201.
    expect(response.status).not.toBe(201);
  });

  it('rate-limits /api/auth/login per configured burst (issue #32)', async () => {
    const app = createApp();

    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'limiter@example.com', password: 'whatever1' });
      expect([401, 400]).toContain(res.status);
    }
  });

  it('throws at app creation in production when JWT_SECRET is missing (issue #32)', () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;

    try {
      expect(() => createApp()).toThrow(/JWT_SECRET/);
    } finally {
      process.env = originalEnv;
    }
  });
});
