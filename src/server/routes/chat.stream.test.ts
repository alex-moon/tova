import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';

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

const mockStream = async (chunks: string[]) => {
  mockCreate.mockResolvedValueOnce({
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield { choices: [{ delta: { content: chunk } }] };
      }
    },
  });
};

const registerUser = async (email: string): Promise<string[]> => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies];
};

describe('Chat streaming route', () => {
  it('rejects unauthenticated requests', async () => {
    const app = createApp();
    const response = await request(app).post('/api/chat/stream').send({ content: 'hello' });

    expect(response.status).toBe(401);
  });

  it('rejects requests without content', async () => {
    const cookies = await registerUser('stream-no-content@example.com');
    const app = createApp();
    const response = await request(app).post('/api/chat/stream').set('Cookie', cookies).send({});

    expect(response.status).toBe(400);
  });

  it('streams an assistant response over SSE and persists the messages', async () => {
    const cookies = await registerUser('stream-happy@example.com');
    await mockStream(['He', 'llo!', ' Done.']);

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const events = response.text
      .split('\n\n')
      .filter((part) => part.trim().length > 0)
      .map((part) => {
        const eventLine = part.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        return {
          event: eventLine?.slice(7),
          data: dataLine ? JSON.parse(dataLine.slice(6)) : undefined,
        };
      });

    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data).toMatchObject({
      sessionId: expect.any(String),
      routing: { model: 'llama3-8b-8192', reason: 'deterministic-short' },
    });

    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.map((e) => e.data.content).join('')).toBe('Hello! Done.');

    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({ complete: true, message: { role: 'assistant' } });

    const sessionId = meta?.data.sessionId;
    const persisted = await Message.find({ sessionId }).sort({ timestamp: 1 });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ role: 'user', content: 'hello there' });
    expect(persisted[1]).toMatchObject({
      role: 'assistant',
      content: 'Hello! Done.',
      modelName: 'llama3-8b-8192',
    });
    const session = await Session.findById(sessionId);
    expect(session).not.toBeNull();
  });
});
