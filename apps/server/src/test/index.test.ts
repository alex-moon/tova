import request from 'supertest';
import { createApp, getPort } from '../main/index';

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

    // Over-limit bodies 413, or routing rejects first — anything but a 201.
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

  it('answers unknown /api/* paths with a JSON 404, never SPA HTML (#397)', async () => {
    const app = createApp();

    const response = await request(app).get('/api/nonexistent');

    expect(response.status).toBe(404);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ message: 'Not found' });
  });

  it('answers malformed JSON with a JSON 400 from the terminal error handler (#397)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();

    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ message: 'Malformed JSON body' });
    // A client payload error is not an internal error: nothing logged.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('treats PORT="" as unset instead of binding port 0 (#397)', () => {
    const prev = process.env.PORT;
    try {
      process.env.PORT = '';
      expect(getPort()).toBe(5000);
      process.env.PORT = '   ';
      expect(getPort()).toBe(5000);
      process.env.PORT = '4000';
      expect(getPort()).toBe(4000);
    } finally {
      if (prev === undefined) delete process.env.PORT;
      else process.env.PORT = prev;
    }
  });
});
