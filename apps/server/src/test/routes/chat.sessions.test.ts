import request from 'supertest';
import { createApp } from '../../main/index';
import { Session } from '../../main/models/Session';
import { User } from '../../main/models/User';
/*
 * #359: the title is user-owned (PATCH sets it and marks titleSource 'user')
 * and the subtitle is a system-maintained line that rides every session
 * response for the client header/sidebar.
 */

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  return response.headers['set-cookie'];
};

const cookiesOf = (cookie: unknown): string[] =>
  Array.isArray(cookie) ? cookie : [String(cookie)];

describe('PATCH /api/chat/sessions/:id (rename, #359)', () => {
  it('renames the session and marks it user-owned', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'rename-1@example.com');
    const session = await Session.create({
      userId: (await User.findOne({ email: 'rename-1@example.com' }))!._id,
    });

    const res = await request(app)
      .patch(`/api/chat/sessions/${session._id}`)
      .set('Cookie', cookiesOf(cookies))
      .send({ title: '  Predictive processing  ' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Predictive processing');
    expect(res.body.titleSource).toBe('user');
  });

  it('refuses another user’s session', async () => {
    const app = createApp();
    await registerUser(app, 'rename-owner@example.com');
    const outsider = await registerUser(app, 'rename-outsider@example.com');
    const session = await Session.create({
      userId: (await User.findOne({ email: 'rename-owner@example.com' }))!._id,
    });

    const res = await request(app)
      .patch(`/api/chat/sessions/${session._id}`)
      .set('Cookie', cookiesOf(outsider))
      .send({ title: 'Mine now' });

    expect(res.status).toBe(404);
    expect((await Session.findById(session._id))!.title).toBe('New Chat');
  });

  it('rejects an empty or oversized title', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'rename-2@example.com');
    const session = await Session.create({
      userId: (await User.findOne({ email: 'rename-2@example.com' }))!._id,
    });

    for (const title of ['', '   ', 'x'.repeat(121), undefined]) {
      const res = await request(app)
        .patch(`/api/chat/sessions/${session._id}`)
        .set('Cookie', cookiesOf(cookies))
        .send({ title });
      expect(res.status).toBe(400);
    }
    expect((await Session.findById(session._id))!.title).toBe('New Chat');
  });

  it('keeps subtitle riding the session list', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'rename-3@example.com');
    await Session.create({
      userId: (await User.findOne({ email: 'rename-3@example.com' }))!._id,
      title: 'Titled',
      subtitle: 'The predictive-processing thread',
    });

    const res = await request(app).get('/api/chat/sessions').set('Cookie', cookiesOf(cookies));
    expect(res.status).toBe(200);
    const row = res.body;
    expect(row[0].subtitle).toBe('The predictive-processing thread');
    expect(row[0].titleSource).toBe('system');
  });
});
