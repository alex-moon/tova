import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';

const mockGenerate = jest.fn();
const mockAgentStream = jest.fn();

jest.mock('@mastra/core/agent', () => {
  return {
    Agent: jest.fn().mockImplementation(() => ({
      generate: (...args: unknown[]) => mockGenerate(...args),
      stream: (...args: unknown[]) => mockAgentStream(...args),
    })),
  };
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
    mockGenerate.mockReset();
    mockAgentStream.mockReset();
  });

  it('streams an error event when the user lacks the routing permission', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'no-routing@example.com');
    await User.updateOne({ email: 'no-routing@example.com' }, { permissions: [] });

    const res = await streamRequest(app, cookie);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You don't have permission to use the model router.");
    expect(mockAgentStream).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('streams normally when the user has the routing permission', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'has-routing@example.com');
    await User.updateOne({ email: 'has-routing@example.com' }, { permissions: ['routing'] });
    mockAgentStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', delta: 'hi' };
      })(),
    });

    const res = await streamRequest(app, cookie);
    expect(res.text).toContain('event: delta');
    expect(res.text).toContain('event: done');
    expect(mockAgentStream).toHaveBeenCalled();
  });
});
