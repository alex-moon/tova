import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';

const registerUser = async (email: string) => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return { app, cookie: response.headers['set-cookie'] };
};

const patchProfile = (
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: Record<string, unknown>,
) => request(app).patch('/api/profile').set('Cookie', cookie).send(body);

const getUser = (email: string) =>
  User.findOne({ email }).then((doc) => {
    if (!doc) throw new Error(`user ${email} not found`);
    return doc;
  });

describe('PATCH /api/profile (issue #35)', () => {
  it('sets preferredName and systemPrompt and returns the /me payload shape', async () => {
    const { app, cookie } = await registerUser('patch-happy@example.com');

    const res = await patchProfile(app, cookie, {
      preferredName: '  Alex  ',
      systemPrompt: 'Always answer in list form.',
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: 'patch-happy@example.com',
      role: 'user',
      permissions: [],
      preferredName: 'Alex',
      systemPrompt: 'Always answer in list form.',
    });

    const user = await getUser('patch-happy@example.com');
    expect(user.preferredName).toBe('Alex');
    expect(user.settings?.systemPrompt).toBe('Always answer in list form.');

    // PATCH response and GET /me must carry an identical field set (plan
    // task 3 drift requirement).
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(Object.keys(res.body.user).sort()).toEqual(Object.keys(me.body.user).sort());
    expect(me.body.user).toEqual(res.body.user);
  });

  it('leaves a key absent from the body untouched', async () => {
    const { app, cookie } = await registerUser('patch-partial@example.com');
    await patchProfile(app, cookie, { preferredName: 'Alex', systemPrompt: 'Be terse.' });

    const res = await patchProfile(app, cookie, { preferredName: 'A' });

    expect(res.status).toBe(200);
    const user = await getUser('patch-partial@example.com');
    expect(user.preferredName).toBe('A');
    expect(user.settings?.systemPrompt).toBe('Be terse.');
  });

  it('clears preferredName via present-but-empty string', async () => {
    const { app, cookie } = await registerUser('patch-clear-name@example.com');
    await patchProfile(app, cookie, { preferredName: 'Alex' });

    const res = await patchProfile(app, cookie, { preferredName: '   ' });

    expect(res.status).toBe(200);
    const user = await getUser('patch-clear-name@example.com');
    expect(user.preferredName).toBeNull();
    expect(res.body.user).not.toHaveProperty('preferredName');
  });

  it('clears and round-trips systemPrompt as absent, not empty string', async () => {
    const { app, cookie } = await registerUser('patch-clear-prompt@example.com');
    await patchProfile(app, cookie, { systemPrompt: 'Be terse.' });

    await patchProfile(app, cookie, { systemPrompt: '' });

    const user = await getUser('patch-clear-prompt@example.com');
    // Schema rehydrates a cleared field as its default (null), never '':
    // '' would block per-user prompt resolution downstream.
    expect(user.settings?.systemPrompt).toBeNull();

    // Whitespace-only input clears too, so a blank prompt cannot disable the
    // system message.
    await patchProfile(app, cookie, { systemPrompt: '   ' });
    const user2 = await getUser('patch-clear-prompt@example.com');
    expect(user2.settings?.systemPrompt).toBeNull();
  });

  it('rejects unknown keys (name, avatarUrl, role) with 400', async () => {
    const { app, cookie } = await registerUser('patch-strict@example.com');

    for (const hostile of [
      { name: 'Injected' },
      { avatarUrl: 'https://x.png' },
      { role: 'admin' },
    ]) {
      const res = await patchProfile(app, cookie, hostile);
      expect(res.status).toBe(400);
      // A reject must not partially apply anything else in the same body.
      expect(res.body.user).toBeUndefined();
    }

    // Mixed valid + unknown key must be rejected wholesale.
    const res = await patchProfile(app, cookie, { preferredName: 'Alex', role: 'admin' });
    expect(res.status).toBe(400);
    const user = await getUser('patch-strict@example.com');
    expect(user.preferredName).toBeNull();
    expect(user.role).toBe('user');
  });

  it('rejects too-long and non-string values with 400', async () => {
    const { app, cookie } = await registerUser('patch-validate@example.com');

    const res = await patchProfile(app, cookie, { preferredName: 'x'.repeat(101) });
    expect(res.status).toBe(400);

    const res2 = await patchProfile(app, cookie, { systemPrompt: 'y'.repeat(4001) });
    expect(res2.status).toBe(400);

    const res3 = await patchProfile(app, cookie, { preferredName: 42 as unknown as string });
    expect(res3.status).toBe(400);

    const res4 = await patchProfile(app, cookie, { systemPrompt: null });
    expect(res4.status).toBe(400);

    const user = await getUser('patch-validate@example.com');
    expect(user.preferredName).toBeNull();
    expect(user.settings?.systemPrompt).toBeUndefined();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const app = createApp();
    const res = await request(app).patch('/api/profile').send({ preferredName: 'Alex' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBeDefined();
  });

  it('rejects non-object bodies (array, string, number) with 400', async () => {
    const { app, cookie } = await registerUser('patch-shape@example.com');

    for (const body of [['preferredName: Alex'], '"Alex"', 42, true] as unknown as [
      Record<string, unknown>,
    ]) {
      const res = await request(app)
        .patch('/api/profile')
        .set('Content-type', 'application/json')
        .set('Cookie', cookie)
        .send(body);
      expect(res.status).toBe(400);
    }

    // An entirely empty object is a legal no-op PATCH, not an error.
    const res = await patchProfile(app, cookie, {});
    expect(res.status).toBe(200);
  });

  it('rejects a nonexistent user with 401 and clears the cookie', async () => {
    const { app, cookie } = await registerUser('patch-deleted@example.com');
    await User.deleteOne({ email: 'patch-deleted@example.com' });

    const res = await patchProfile(app, cookie, { preferredName: 'Alex' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeDefined();
  });
});
