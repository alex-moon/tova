import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { Session } from '../models/Session';
import { Message } from '../models/Message';

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
  it('sets preferredName and customInstructions and returns the /me payload shape', async () => {
    const { app, cookie } = await registerUser('patch-happy@example.com');

    const res = await patchProfile(app, cookie, {
      preferredName: '  Alex  ',
      customInstructions: 'Always answer in list form.',
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: 'patch-happy@example.com',
      role: 'user',
      permissions: [],
      preferredName: 'Alex',
      customInstructions: 'Always answer in list form.',
    });

    const user = await getUser('patch-happy@example.com');
    expect(user.preferredName).toBe('Alex');
    expect(user.settings?.customInstructions).toBe('Always answer in list form.');

    // PATCH response and GET /me must carry an identical field set (plan
    // task 3 drift requirement).
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(Object.keys(res.body.user).sort()).toEqual(Object.keys(me.body.user).sort());
    expect(me.body.user).toEqual(res.body.user);
  });

  it('leaves a key absent from the body untouched', async () => {
    const { app, cookie } = await registerUser('patch-partial@example.com');
    await patchProfile(app, cookie, { preferredName: 'Alex', customInstructions: 'Be terse.' });

    const res = await patchProfile(app, cookie, { preferredName: 'A' });

    expect(res.status).toBe(200);
    const user = await getUser('patch-partial@example.com');
    expect(user.preferredName).toBe('A');
    expect(user.settings?.customInstructions).toBe('Be terse.');
  });

  it('strips JSON/XML-like characters and newlines from preferredName', async () => {
    const { app, cookie } = await registerUser('patch-strip@example.com');

    await patchProfile(app, cookie, {
      preferredName: '{Alex\n<y>}',
    });

    const user = await getUser('patch-strip@example.com');
    expect(user.preferredName).toBe('Alexy');
  });

  it('clears a preferred name that is only hostile characters', async () => {
    const { app, cookie } = await registerUser('patch-strip-empty@example.com');
    await patchProfile(app, cookie, { preferredName: 'Alex' });

    await patchProfile(app, cookie, { preferredName: '{"<>' });
    const user = await getUser('patch-strip-empty@example.com');
    expect(user.preferredName).toBeNull();
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

  it('clears and round-trips customInstructions as absent, not empty string', async () => {
    const { app, cookie } = await registerUser('patch-clear-prompt@example.com');
    await patchProfile(app, cookie, { customInstructions: 'Be terse.' });

    await patchProfile(app, cookie, { customInstructions: '' });

    const user = await getUser('patch-clear-prompt@example.com');
    // Schema rehydrates a cleared field as its default (null), never '':
    // '' would block per-user prompt resolution downstream.
    expect(user.settings?.customInstructions).toBeNull();

    // Whitespace-only input clears too, so a blank prompt cannot disable the
    // system message.
    await patchProfile(app, cookie, { customInstructions: '   ' });
    const user2 = await getUser('patch-clear-prompt@example.com');
    expect(user2.settings?.customInstructions).toBeNull();
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

    const res = await patchProfile(app, cookie, { preferredName: 'x'.repeat(21) });
    expect(res.status).toBe(400);

    const res2 = await patchProfile(app, cookie, { customInstructions: 'y'.repeat(4001) });
    expect(res2.status).toBe(400);

    const res3 = await patchProfile(app, cookie, { preferredName: 42 as unknown as string });
    expect(res3.status).toBe(400);

    const res4 = await patchProfile(app, cookie, { customInstructions: null });
    expect(res4.status).toBe(400);

    const user = await getUser('patch-validate@example.com');
    expect(user.preferredName).toBeNull();
    expect(user.settings?.customInstructions).toBeUndefined();
  });

  it('saves a theme preference and reports it on PATCH and /me, omitted when unset', async () => {
    const { app, cookie } = await registerUser('patch-theme@example.com');

    // Before any save the field is absent from the wire payload (same
    // convention as preferredName/customInstructions).
    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.user).not.toHaveProperty('theme');

    const res = await patchProfile(app, cookie, { theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body.user.theme).toBe('dark');

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user).toEqual(res.body.user);

    const user = await getUser('patch-theme@example.com');
    expect(user.settings?.theme).toBe('dark');

    // Switching is a normal PATCH; other settings survive.
    await patchProfile(app, cookie, { customInstructions: 'Be terse.' });
    const switchRes = await patchProfile(app, cookie, { theme: 'light' });
    expect(switchRes.body.user.theme).toBe('light');
    expect(switchRes.body.user.customInstructions).toBe('Be terse.');
  });

  it('leaves the theme untouched when absent from the body', async () => {
    const { app, cookie } = await registerUser('patch-theme-partial@example.com');
    await patchProfile(app, cookie, { theme: 'dark' });

    const res = await patchProfile(app, cookie, { preferredName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.user.theme).toBe('dark');
  });

  it('rejects invalid theme values with 400', async () => {
    const { app, cookie } = await registerUser('patch-theme-invalid@example.com');

    for (const bad of ['midnight', '', null, 42, 'SYSTEM']) {
      const res = await patchProfile(app, cookie, { theme: bad });
      expect(res.status).toBe(400);
    }

    // Unset on a fresh user: settings stays null (lazily created), so a
    // rejected body must never have materialized a preference.
    const user = await getUser('patch-theme-invalid@example.com');
    expect(user.settings?.theme ?? null).toBeNull();
  });

  it('saves granular delete-confirmation prefs and round-trips them (issue #59)', async () => {
    const { app, cookie } = await registerUser('patch-delete-confirm@example.com');

    // Grandular single-key patch: the untouched key holds the doc default (true).
    const res = await patchProfile(app, cookie, { confirmDeletes: { chat: false } });
    expect(res.status).toBe(200);
    expect(res.body.user.confirmDeletes).toEqual({ chat: false, file: true });

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.confirmDeletes).toEqual({ chat: false, file: true });

    const persisted = await User.findOne({ email: 'patch-delete-confirm@example.com' }).lean();
    expect(persisted?.settings?.confirmDeletes).toEqual({ chat: false, file: true });

    // Turning it back on.
    const on = await patchProfile(app, cookie, { confirmDeletes: { chat: true, file: false } });
    expect(on.body.user.confirmDeletes).toEqual({ chat: true, file: false });
  });

  it('leaves confirmDeletes untouched when absent from the body (issue #59)', async () => {
    const { app, cookie } = await registerUser('patch-delete-confirm-partial@example.com');
    await patchProfile(app, cookie, { confirmDeletes: { file: false } });

    const res = await patchProfile(app, cookie, { preferredName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.user.confirmDeletes).toEqual({ chat: true, file: false });
  });

  it('rejects bad confirmDeletes payloads with 400 (issue #59)', async () => {
    const { app, cookie } = await registerUser('patch-delete-confirm-invalid@example.com');

    for (const bad of ['yes', 42, null, true, { other: false }, { chat: 'no' }]) {
      const res = await patchProfile(app, cookie, { confirmDeletes: bad });
      expect(res.status).toBe(400);
    }

    const user = await getUser('patch-delete-confirm-invalid@example.com');
    expect(user.settings?.confirmDeletes ?? null).toBeNull();
  });

  it('saves a startupChat preference and reports it on PATCH and /me, omitted when unset (issue #96)', async () => {
    const { app, cookie } = await registerUser('patch-startup@example.com');

    // Before any save the field is absent from the wire payload (same
    // convention as theme).
    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.user).not.toHaveProperty('startupChat');

    const res = await patchProfile(app, cookie, { startupChat: 'new' });
    expect(res.status).toBe(200);
    expect(res.body.user.startupChat).toBe('new');

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user).toEqual(res.body.user);

    const user = await getUser('patch-startup@example.com');
    expect(user.settings?.startupChat).toBe('new');

    // Switching is a normal PATCH; other settings survive.
    await patchProfile(app, cookie, { customInstructions: 'Be terse.' });
    const switchRes = await patchProfile(app, cookie, { startupChat: 'recent' });
    expect(switchRes.body.user.startupChat).toBe('recent');
    expect(switchRes.body.user.customInstructions).toBe('Be terse.');
  });

  it('leaves startupChat untouched when absent from the body (issue #96)', async () => {
    const { app, cookie } = await registerUser('patch-startup-partial@example.com');
    await patchProfile(app, cookie, { startupChat: 'new' });

    const res = await patchProfile(app, cookie, { preferredName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.user.startupChat).toBe('new');
  });

  it('rejects invalid startupChat values with 400 (issue #96)', async () => {
    const { app, cookie } = await registerUser('patch-startup-invalid@example.com');

    for (const bad of ['old', 'NEW', '', null, 42]) {
      const res = await patchProfile(app, cookie, { startupChat: bad });
      expect(res.status).toBe(400);
    }

    // Unset on a fresh user: settings stays null (lazily created), so a
    // rejected body must never have materialized a preference.
    const user = await getUser('patch-startup-invalid@example.com');
    expect(user.settings?.startupChat ?? null).toBeNull();
  });

  it('saves the zdr preference and reports it on PATCH and /me (issue #116)', async () => {
    const { app, cookie } = await registerUser('patch-zdr@example.com');

    // Before any save the field is absent from the wire payload (same
    // convention as theme: false is the default, never explicitly sent).
    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.user).not.toHaveProperty('zdr');

    const res = await patchProfile(app, cookie, { zdr: true });
    expect(res.status).toBe(200);
    expect(res.body.user.zdr).toBe(true);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user).toEqual(res.body.user);

    const user = await getUser('patch-zdr@example.com');
    expect(user.settings?.zdr).toBe(true);

    // Turning it back off persists false but keeps the payload omitted
    // (truthy-only delivery, same as theme/startupChat).
    const off = await patchProfile(app, cookie, { zdr: false });
    expect(off.status).toBe(200);
    expect(off.body.user).not.toHaveProperty('zdr');
    const user2 = await getUser('patch-zdr@example.com');
    expect(user2.settings?.zdr).toBe(false);
  });

  it('leaves zdr untouched when absent from the body (issue #116)', async () => {
    const { app, cookie } = await registerUser('patch-zdr-partial@example.com');
    await patchProfile(app, cookie, { zdr: true });

    const res = await patchProfile(app, cookie, { preferredName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.user.zdr).toBe(true);
    const user = await getUser('patch-zdr-partial@example.com');
    expect(user.settings?.zdr).toBe(true);
  });

  it('rejects non-boolean zdr values with 400 (issue #116)', async () => {
    const { app, cookie } = await registerUser('patch-zdr-invalid@example.com');

    for (const bad of ['yes', 1, null, 0]) {
      const res = await patchProfile(app, cookie, { zdr: bad });
      expect(res.status).toBe(400);
    }

    // Unset on a fresh user: settings stays null (lazily created), so a
    // rejected body must never have materialized a preference.
    const user = await getUser('patch-zdr-invalid@example.com');
    expect(user.settings?.zdr ?? null).toBeNull();
  });

  it('rejects non-boolean incognitoByDefault values with 400', async () => {
    const { app, cookie } = await registerUser('patch-incognito-invalid@example.com');

    for (const bad of ['yes', 1, null, 0]) {
      const res = await patchProfile(app, cookie, { incognitoByDefault: bad });
      expect(res.status).toBe(400);
    }

    const user = await getUser('patch-incognito-invalid@example.com');
    expect(user.settings?.zdr ?? null).toBeNull();
  });

  it('patching incognitoByDefault writes the same settings.zdr slot (issue #144)', async () => {
    const { app, cookie } = await registerUser('patch-incognito-slot@example.com');

    const before = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(before.body.user).not.toHaveProperty('incognitoByDefault');

    const on = await patchProfile(app, cookie, { incognitoByDefault: true });
    expect(on.status).toBe(200);
    expect(on.body.user.incognitoByDefault).toBe(true);
    expect(on.body.user.zdr).toBe(true);

    const off = await patchProfile(app, cookie, { incognitoByDefault: false });
    expect(off.status).toBe(200);
    expect(off.body.user).not.toHaveProperty('incognitoByDefault');

    const user = await getUser('patch-incognito-slot@example.com');
    expect(user.settings?.zdr).toBe(false);
  });

  it('rejects conflicting zdr and incognitoByDefault values with 400', async () => {
    const { app, cookie } = await registerUser('patch-incognito-conflict@example.com');

    const res = await patchProfile(app, cookie, { zdr: true, incognitoByDefault: false });
    expect(res.status).toBe(400);

    const user = await getUser('patch-incognito-conflict@example.com');
    expect(user.settings?.zdr ?? null).toBeNull();
  });

  describe('first-enable auto-purge (issue #116 Q5)', () => {
    const seedChats = async (email: string, sessions: number, withMessages = true) => {
      const user = await getUser(email);
      const docIds = [];
      for (let i = 0; i < sessions; i++) {
        const session = await Session.create({ userId: user._id, title: `Chat ${i}` });
        if (withMessages) {
          await Message.create([
            { sessionId: session._id, role: 'user', content: `question ${i}` },
            { sessionId: session._id, role: 'assistant', content: `answer ${i}` },
          ]);
        }
        docIds.push(session._id);
      }
      return { user, docIds };
    };

    it('enabling zdr leaves existing sessions and messages untouched', async () => {
      const { app, cookie } = await registerUser('patch-zdr-nopurge@example.com');
      const { docIds } = await seedChats('patch-zdr-nopurge@example.com', 2);

      const res = await patchProfile(app, cookie, { zdr: true });
      expect(res.status).toBe(200);

      const remaining = await Session.find({ _id: { $in: docIds } }).lean();
      expect(remaining).toHaveLength(2);
      // Not even soft-deleted: the flag no longer touches data at all.
      expect(remaining.every((s) => s.deletedAt === null)).toBe(true);
      expect(await Message.countDocuments({ sessionId: { $in: docIds } })).toBe(4);
    });

    it('toggling off and back on still changes nothing (the old re-purge concern is moot)', async () => {
      const { app, cookie } = await registerUser('patch-zdr-nopurge-again@example.com');
      const { docIds } = await seedChats('patch-zdr-nopurge-again@example.com', 1);

      await patchProfile(app, cookie, { zdr: true });
      await patchProfile(app, cookie, { zdr: false });
      await patchProfile(app, cookie, { zdr: true });

      expect(await Session.countDocuments({ _id: { $in: docIds } })).toBe(1);
      expect(await Message.countDocuments({ sessionId: { $in: docIds } })).toBe(2);
    });

    it('a failed PATCH body (400) still never touches data', async () => {
      const { app, cookie } = await registerUser('patch-zdr-nopurge-invalid@example.com');
      const { docIds } = await seedChats('patch-zdr-nopurge-invalid@example.com', 1);

      await patchProfile(app, cookie, { zdr: 'yes', theme: 'dark' });

      expect(await Session.countDocuments({ _id: { $in: docIds } })).toBe(1);
      expect(await Message.countDocuments()).toBe(2);
    });
  });

  it('applies zdr alongside other settings keys in one PATCH without clobbering them (issue #116)', async () => {
    const { app, cookie } = await registerUser('patch-zdr-multi@example.com');

    const res = await patchProfile(app, cookie, {
      theme: 'dark',
      preferredName: 'Alex',
      confirmDeletes: { chat: false },
      zdr: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.user.zdr).toBe(true);
    expect(res.body.user.theme).toBe('dark');
    expect(res.body.user.confirmDeletes).toEqual({ chat: false, file: true });

    // The reverse order: zdr off together with an unrelated key must not
    // resurrect any other persisted field (order-dependence guard).
    const off = await patchProfile(app, cookie, { preferredName: 'A', zdr: false });
    expect(off.status).toBe(200);
    expect(off.body.user).not.toHaveProperty('zdr');
    expect(off.body.user.theme).toBe('dark');
    expect(off.body.user.confirmDeletes).toEqual({ chat: false, file: true });
    expect(off.body.user.preferredName).toBe('A');

    const user = await getUser('patch-zdr-multi@example.com');
    expect(user.settings?.zdr).toBe(false);
    expect(user.settings?.theme).toBe('dark');
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
