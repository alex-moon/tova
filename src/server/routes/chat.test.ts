import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';

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

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return response.headers['set-cookie'];
};

describe('Chat route routing metadata', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValueOnce({
      choices: [{ message: { content: 'e2e-ok' } }],
    });
  });

  it('exposes the routing decision (model, reason) in the response', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'routing-meta-1@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body.routing).toEqual({
      model: 'llama3-8b-8192',
      reason: 'deterministic-short',
    });
    expect(response.body.message.modelName).toBe('llama3-8b-8192');

    const saved = await Message.exists({ role: 'assistant', modelName: 'llama3-8b-8192' });
    expect(saved).toBeTruthy();
  });
});
