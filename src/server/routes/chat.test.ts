import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
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

const mockRouteQuery = jest.fn();

jest.mock('../services/routerService', () => ({
  routeQuery: (...args: unknown[]) => mockRouteQuery(...args),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const MOCK_ROUTING = { model: 'mock-small-model', reason: 'deterministic-short' };

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  return response.headers['set-cookie'];
};

describe('Chat route routing metadata', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({
      choices: [{ message: { content: 'e2e-ok' } }],
    });
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
  });

  it('exposes the routing decision (model, reason) in the response', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'routing-meta-1@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body.routing).toEqual(MOCK_ROUTING);
    expect(response.body.message.modelName).toBe('mock-small-model');

    const saved = await Message.exists({ role: 'assistant', modelName: 'mock-small-model' });
    expect(saved).toBeTruthy();
  });
});

const CLASSIFIER_REPLY =
  '{"emotional": true, "technical": false, "abstract": false, "sentiment": "negative", "openEnded": true}';

const isClassifierCall = (args?: { messages?: { role: string; content: string }[] }) =>
  args?.messages?.[0]?.content.startsWith('Classify the user prompt') ?? false;

// Let the fire-and-forget classification promise fully settle.
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

describe('Chat route prompt metrics', () => {
  beforeEach(() => {
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
    mockCreate.mockReset().mockResolvedValue({
      choices: [{ message: { content: 'e2e-ok' } }],
    });
  });

  it('persists deterministic metrics for both turns and the LLM classification for the user turn', async () => {
    mockCreate.mockImplementation(
      async (args?: { messages?: { role: string; content: string }[] }) => {
        if (isClassifierCall(args)) {
          return { choices: [{ message: { content: `\`\`\`json\n${CLASSIFIER_REPLY}\n\`\`\`` } }] };
        }
        return { choices: [{ message: { content: 'e2e-ok' } }] };
      },
    );

    const app = createApp();
    const cookies = await registerUser(app, 'metrics-happy@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Write me a test?' });

    expect(response.status).toBe(200);

    const userMessage = await Message.findOne({ role: 'user' });
    const assistantMessage = await Message.findOne({ role: 'assistant' });
    expect(userMessage?.metrics).toMatchObject({
      wordCount: expect.any(Number),
      charCount: 'Write me a test?'.length,
      hasQuestionMark: true,
      hasImperative: true,
      codeIndicators: { fences: 0, backticks: 0, codeTokenCount: 0 },
      sessionMessageIndex: 0,
    });
    expect(assistantMessage?.metrics).toMatchObject({
      sessionMessageIndex: 1,
    });

    await flush();
    const updated = await Message.findOne({ role: 'user' });
    expect(updated?.metrics?.llm).toEqual({
      emotional: true,
      technical: false,
      abstract: false,
      sentiment: 'negative',
      openEnded: true,
    });
    expect(updated?.metrics?.llmSkipReason).toBeNull();
    // Assistant turns are never LLM-classified
    expect((await Message.findOne({ role: 'assistant' }))?.metrics?.llm).toMatchObject({
      emotional: null,
      technical: null,
      abstract: null,
      sentiment: null,
      openEnded: null,
    });
  });

  it('keeps the chat response intact with null LLM flags when classification fails', async () => {
    mockCreate.mockImplementation(
      async (args?: { messages?: { role: string; content: string }[] }) => {
        if (isClassifierCall(args)) {
          throw new Error('groq down');
        }
        return { choices: [{ message: { content: 'e2e-ok' } }] };
      },
    );

    const app = createApp();
    const cookies = await registerUser(app, 'metrics-fail@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello' });

    expect(response.status).toBe(200);
    expect(response.body.message.modelName).toBe('mock-small-model');

    await flush();
    const userMessage = await Message.findOne({ role: 'user' });
    expect(userMessage?.metrics?.llm).toMatchObject({
      emotional: null,
      technical: null,
      abstract: null,
      sentiment: null,
      openEnded: null,
    });
    // The DB records why the flags are missing
    expect(userMessage?.metrics?.llmSkipReason).toBe('error');
  });

  it('skips classification for trivially neutral prompts but records the skip', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'metrics-trivial@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'tell me more' });

    expect(response.status).toBe(200);
    await flush();
    expect(isClassifierCall(mockCreate.mock.calls[0]?.[0])).toBe(false);
    const userMessage = await Message.findOne({ role: 'user' });
    expect(userMessage?.metrics?.llm).toMatchObject({
      emotional: null,
      technical: null,
      abstract: null,
      sentiment: null,
      openEnded: null,
    });
    expect(userMessage?.metrics?.llmSkipReason).toBe('trivial');
  });

  it('increments session indices across 12 turns in one session', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'metrics-12turns@example.com');
    const cookieHeader = Array.isArray(cookies) ? cookies : [cookies];

    let sessionId: string | undefined;
    for (let turn = 0; turn < 12; turn++) {
      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', cookieHeader)
        .send({ sessionId, content: `Write turn ${turn}` });

      expect(response.status).toBe(200);
      sessionId = response.body.sessionId;
      expect(response.body.message.metrics.sessionMessageIndex).toBe(turn * 2 + 1);

      const userMessage = await Message.findOne({
        sessionId,
        role: 'user',
        content: `Write turn ${turn}`,
      });
      expect(userMessage?.metrics?.sessionMessageIndex).toBe(turn * 2);
    }
  });
});
