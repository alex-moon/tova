import request from 'supertest';
import { createApp } from '../../main/index';
import { Session } from '../../main/models/Session';
import { Message } from '../../main/models/Message';
import { User } from '../../main/models/User';

const mockCreate = jest.fn();

jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreate(...args),
      },
    },
  }));
});

const feedbackRequest = (
  app: ReturnType<typeof createApp>,
  cookie: string | undefined,
  messageId: string,
  body: Record<string, unknown>,
) =>
  request(app)
    .post(`/api/messages/${messageId}/feedback`)
    .set('Cookie', cookie ? [cookie] : [])
    .send(body);

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return response.headers['set-cookie'] as unknown as string;
};

const seedMessage = async (
  overrides: Partial<{
    ownerId: string;
    sessionId: string;
    role: string;
  }> = {},
) => {
  // Create a fresh owner per call so seed order never depends on registration side effects.
  const owner =
    overrides.ownerId ??
    String(
      (await User.create({ email: `sender-${crypto.randomUUID()}@example.com`, passwordHash: 'x' }))
        ._id,
    );
  const session = overrides.sessionId ?? String((await Session.create({ userId: owner }))._id);
  const message = await Message.create({
    sessionId: session,
    role: overrides.role ?? 'assistant',
    content: 'here you go',
    modelName: 'openai/gpt-oss-20b',
  });
  return String(message._id);
};

/* The thumbs route covered as a user feature only. */
// @see #233
describe('POST /api/messages/:messageId/feedback', () => {
  it('records a vote and returns the updated message with feedback state', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'sender@example.com');

    const messageId = await seedMessage({
      ownerId: String((await User.findOne({ email: 'sender@example.com' }))!._id),
    });
    const res = await feedbackRequest(app, cookie, messageId, { value: 'up' });

    expect(res.status).toBe(200);
    expect(res.body.feedback).toMatchObject({ value: 'up' });
    expect(res.body.feedback.updatedAt).toBeTruthy();
  });

  it('overwrites a revote', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'sender@example.com');

    const messageId = await seedMessage({
      ownerId: String((await User.findOne({ email: 'sender@example.com' }))!._id),
    });
    await feedbackRequest(app, cookie, messageId, { value: 'up' });
    const res = await feedbackRequest(app, cookie, messageId, { value: 'down' });

    expect(res.status).toBe(200);
    expect(res.body.feedback.value).toBe('down');
  });

  it('returns 401 for unauthenticated requests', async () => {
    const app = createApp();
    const messageId = await seedMessage();

    const res = await request(app)
      .post(`/api/messages/${messageId}/feedback`)
      .send({ value: 'up' });

    expect(res.status).toBe(401);
  });

  it('returns 400 for a missing or invalid value', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'sender@example.com');
    const messageId = await seedMessage();

    const missing = await feedbackRequest(app, cookie, messageId, {});
    expect(missing.status).toBe(400);

    const invalid = await feedbackRequest(app, cookie, messageId, { value: 'meh' });
    expect(invalid.status).toBe(400);
  });

  it('returns 403 when the message belongs to a foreign session', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'intruder@example.com');
    const receiver = await User.create({
      email: `receiver-${crypto.randomUUID()}@example.com`,
      passwordHash: 'x',
    });
    const messageId = await seedMessage({ ownerId: String(receiver._id) });

    const res = await feedbackRequest(app, cookie, messageId, { value: 'up' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown message id', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'sender@example.com');

    const res = await feedbackRequest(app, cookie, '000000000000000000000000', { value: 'up' });

    expect(res.status).toBe(404);
  });

  it('rejects feedback on user-role messages with 400', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'sender@example.com');
    const messageId = await seedMessage({
      ownerId: String((await User.findOne({ email: 'sender@example.com' }))!._id),
      role: 'user',
    });

    const res = await feedbackRequest(app, cookie, messageId, { value: 'up' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/messages/:messageId/feedback', () => {
  it('clears a vote (issue #18 comment on Q1)', async () => {
    const app = createApp();
    const email = `clearer-${crypto.randomUUID()}@example.com`;
    const cookie = await registerUser(app, email);
    const messageId = await seedMessage({ ownerId: String((await User.findOne({ email }))!._id) });

    await feedbackRequest(app, cookie, messageId, { value: 'down' });

    const res = await request(app)
      .delete(`/api/messages/${messageId}/feedback`)
      .set('Cookie', cookie ? [cookie] : []);
    expect(res.status).toBe(200);
    expect(res.body.feedback.value).toBeNull();

    const cleared = await Message.findById(messageId);
    expect(cleared?.feedback?.value).toBeNull();
  });

  it('is idempotent: clearing when nothing is set is a no-op', async () => {
    const app = createApp();
    const email = `clearer-${crypto.randomUUID()}@example.com`;
    const cookie = await registerUser(app, email);
    const messageId = await seedMessage({ ownerId: String((await User.findOne({ email }))!._id) });

    const res = await request(app)
      .delete(`/api/messages/${messageId}/feedback`)
      .set('Cookie', cookie ? [cookie] : []);

    expect(res.status).toBe(200);
    expect(res.body.feedback.value).toBeNull();
  });

  it('returns 403 on a foreign session and 401 unauthenticated', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'intruder@example.com');
    const receiver = await User.create({
      email: `receiver-${crypto.randomUUID()}@example.com`,
      passwordHash: 'x',
    });
    const messageId = await seedMessage({ ownerId: String(receiver._id) });

    const foreign = await request(app)
      .delete(`/api/messages/${messageId}/feedback`)
      .set('Cookie', cookie ? [cookie] : []);
    expect(foreign.status).toBe(403);

    const anon = await request(app).delete(`/api/messages/${messageId}/feedback`);
    expect(anon.status).toBe(401);
  });
});
