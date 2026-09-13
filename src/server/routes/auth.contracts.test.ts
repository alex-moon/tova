import request from 'supertest';
import { createApp } from '../index';

// Drift tests for the shared auth contracts (issue #20): pin the wire
// payloads of /api/auth/register, /login and /me to the exact field sets
// of LoginUserPayload and AuthUser in src/shared/contracts.ts. If a route
// starts returning a different shape than the contract, these fail.
describe('auth route contract drift', () => {
  it('register returns a user payload matching LoginUserPayload exactly', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-register@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    const user: Record<string, unknown> = res.body.user;
    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'role']);
    expect(typeof user.id).toBe('string');
    expect(user.id).toBeTruthy();
    expect(user.email).toBe('contract-register@example.com');
    expect(user.role).toBe('user');
  });

  it('login returns a user payload matching LoginUserPayload exactly', async () => {
    const app = createApp();
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-login@example.com', password: 'password123' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'contract-login@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    const user: Record<string, unknown> = res.body.user;
    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'role']);
    expect(typeof user.id).toBe('string');
    expect(user.email).toBe('contract-login@example.com');
    expect(user.role).toBe('user');
  });

  it('me returns a user payload matching AuthUser exactly', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-me@example.com', password: 'password123' });
    const cookie = reg.headers['set-cookie'];

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const user: Record<string, unknown> = res.body.user;
    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'permissions', 'role']);
    expect(typeof user.id).toBe('string');
    expect(user.email).toBe('contract-me@example.com');
    expect(user.role).toBe('user');
    expect(Array.isArray(user.permissions)).toBe(true);
  });
});

describe('auth route hardening (issue #32)', () => {
  it.each([
    ['invalid email', { email: 'not-an-email', password: 'password123' }, 'valid email'],
    ['short password', { email: 'zod-validation@example.com', password: 'short' }, '8 characters'],
    ['missing fields', {}, 'valid email'],
  ])('register returns 400 for %s', async (_label, body, messagePart) => {
    const app = createApp();

    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain(messagePart);
  });

  it('register rejects other field types without leaking a stack', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"password": 42}');

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('at ');
  });

  it('login returns 400 for a missing password', async () => {
    const app = createApp();

    const res = await request(app).post('/api/auth/login').send({ email: 'zod-login@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Password is required');
  });

  it('session cookie carries sameSite=Lax (issue #32)', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cookie-flags@example.com', password: 'password123' });

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const sessionCookie = setCookie.find((c) => c.startsWith('token='));
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('HttpOnly');
  });
});
