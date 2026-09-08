import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';

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

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return response.headers['set-cookie'];
};

const streamRequest = (app: ReturnType<typeof createApp>, cookie: string) =>
  request(app)
    .post('/api/chat/stream')
    .set('Cookie', Array.isArray(cookie) ? cookie : [cookie])
    .send({ content: 'Hello' });

describe('chat route routing permission guard', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('streams an error event when the user lacks the routing permission', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'no-routing@example.com');
    await User.updateOne({ email: 'no-routing@example.com' }, { permissions: [] });

    const res = await streamRequest(app, cookie);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You don't have permission to use the model router.");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('streams normally when the user has the routing permission', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'has-routing@example.com');
    await User.updateOne({ email: 'has-routing@example.com' }, { permissions: ['routing'] });
    mockCreate.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'hi' } }] };
      },
    });

    const res = await streamRequest(app, cookie);
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: done');
    expect(mockCreate).toHaveBeenCalled();
  });
});
