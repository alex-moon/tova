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

  it('me round-trips profile fields when set (issue #35)', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-profile@example.com', password: 'password123' });
    const cookie = reg.headers['set-cookie'];

    // Populate the fields directly on the model (PATCH /api/profile is task 3).
    const { User } = await import('../models/User');
    const doc = await User.findOne({ email: 'contract-profile@example.com' });
    if (!doc) throw new Error('user not found');
    doc.name = 'Alex Moon';
    doc.avatarUrl = 'https://example.com/a.png';
    doc.preferredName = 'Alex';
    doc.settings = { customInstructions: 'Be terse.' };
    await doc.save();

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const user: Record<string, unknown> = res.body.user;
    expect(user.name).toBe('Alex Moon');
    expect(user.avatarUrl).toBe('https://example.com/a.png');
    expect(user.preferredName).toBe('Alex');
    // settings stays internal, but the per-user prompt override ride-along on
    // AuthUser is required by the profile modal prefill (plan tasks 6–7).
    expect(user.settings).toBeUndefined();
    expect(user.customInstructions).toBe('Be terse.');
  });

  it('me rides the coarse location when resolved, and omits it otherwise (#50)', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-location@example.com', password: 'password123' });
    const cookie = reg.headers['set-cookie'];

    // Freshly registered: no location yet, and the loopback request IP skips
    // resolution entirely, so none must appear.
    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.user.location).toBeUndefined();

    // Populate the location exactly like the geo service does, then read.
    const { User } = await import('../models/User');
    const doc = await User.findOne({ email: 'contract-location@example.com' });
    if (!doc) throw new Error('user not found');
    doc.location = {
      country: 'Finland',
      countryCode: 'FI',
      resolvedAt: new Date(),
    } as never;
    await doc.save();

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const user: Record<string, unknown> = res.body.user;
    expect(user.location).toEqual({ country: 'Finland', countryCode: 'FI' });
    // resolvedAt is deliberately not exposed (see userService.toAuthUser).
    expect((user.location as Record<string, unknown>).resolvedAt).toBeUndefined();
  });

  it('me omits profile fields not yet set, even when other fields exist', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-partial@example.com', password: 'password123' });
    const cookie = reg.headers['set-cookie'];

    const { User } = await import('../models/User');
    const doc = await User.findOne({ email: 'contract-partial@example.com' });
    if (!doc) throw new Error('user not found');
    doc.settings = { customInstructions: 'Be terse.' };
    await doc.save();

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const user: Record<string, unknown> = res.body.user;
    expect(user.name).toBeUndefined();
    expect(user.avatarUrl).toBeUndefined();
    expect(user.preferredName).toBeUndefined();
    expect(user.settings).toBeUndefined();
    // The prompt override is set in this fixture, so it rides along.
    expect(user.customInstructions).toBe('Be terse.');
  });

  it('me values are trimmed and length-bounded at the schema level (issue #35)', async () => {
    const app = createApp();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'contract-validate@example.com', password: 'password123' });

    const { User } = await import('../models/User');
    const doc = await User.findOne({ email: 'contract-validate@example.com' });
    if (!doc) throw new Error('user not found');

    // Whitespace-only names trim away and must not surface on /me.
    doc.name = '   ';
    await doc.save();
    const blank = await request(app).get('/api/auth/me').set('Cookie', reg.headers['set-cookie']);
    expect(blank.body.user.name).toBeUndefined();

    // Names over 100 chars are rejected by the schema, not silently truncated.
    doc.name = 'x'.repeat(101);
    await expect(doc.save()).rejects.toThrow();

    // System prompts over 4000 chars are rejected by the schema.
    const doc2 = await User.findOne({ email: 'contract-validate@example.com' });
    if (!doc2) throw new Error('user not found');
    doc2.settings = { customInstructions: 'y'.repeat(4001) };
    await expect(doc2.save()).rejects.toThrow();
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
