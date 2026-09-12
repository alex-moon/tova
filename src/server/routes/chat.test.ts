import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { User } from '../models/User';

const mockGenerate = jest.fn();

jest.mock('@mastra/core/agent', () => {
  return {
    Agent: jest.fn().mockImplementation(() => ({
      generate: (...args: unknown[]) => mockGenerate(...args),
    })),
  };
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
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
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

  it('persists a routingBand captured from the user turn on the assistant message', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'band-meta-1@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello there' });

    expect(response.status).toBe(200);
    const assistantMessage = await Message.findOne({ role: 'assistant' });
    // "Hello there" is a short prose prompt → short|prose band
    expect(assistantMessage?.routingBand).toBe('short|prose');
    expect(assistantMessage?.feedback).toMatchObject({ value: null, updatedAt: null });
  });

  it('dispatches a DeepInfra-routed turn to the DeepInfra provider end-to-end', async () => {
    // Plan task-9 bullet: the DeepInfra path must be exercised at the route
    // level, not only in the connector unit tests. The mocked Agent ctor
    // model string is the observable dispatch boundary.
    mockRouteQuery.mockResolvedValueOnce({
      model: 'Qwen/Qwen2.5-72B-Instruct',
      reason: 'classifier-complex',
      provider: 'deepinfra',
    });
    const app = createApp();
    const cookies = await registerUser(app, 'routing-deepinfra@example.com');
    const agentCtor = jest.requireMock('@mastra/core/agent').Agent as jest.Mock;

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'Explain something complex' });

    expect(response.status).toBe(200);
    expect(response.body.message.modelName).toBe('Qwen/Qwen2.5-72B-Instruct');
    const ctorCall = agentCtor.mock.calls[agentCtor.mock.calls.length - 1] as unknown as [
      { model: string },
    ];
    expect(ctorCall[0].model).toBe('deepinfra/Qwen/Qwen2.5-72B-Instruct');
  });

  it('persists deduped sources when the agent ran web_search (#16)', async () => {
    // The fire-and-forget classifier also calls generate; only the chat
    // completion may carry the tool results.
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return { text: CLASSIFIER_REPLY };
      }
      return {
        text: 'Grounded answer',
        toolResults: [
          {
            name: 'web_search',
            result: {
              results: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }],
            },
          },
          {
            name: 'web_search',
            result: {
              results: [{ url: 'https://a.example.com' }, { url: 'https://c.example.com' }],
            },
          },
        ],
      };
    });
    const app = createApp();
    const cookies = await registerUser(app, 'search-sources@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Requires current info' });

    expect(response.status).toBe(200);
    const saved = await Message.findOne({ role: 'assistant' });
    expect(saved?.sources).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('omits sources on a tool-free turn', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'search-none@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello' });

    expect(response.status).toBe(200);
    const saved = await Message.findOne({ role: 'assistant' });
    expect(saved?.sources).toBeUndefined();
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
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
    });
  });

  it('persists deterministic metrics for both turns and the LLM classification for the user turn', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return { text: `\`\`\`json\n${CLASSIFIER_REPLY}\n\`\`\`` };
      }
      return { text: 'e2e-ok' };
    });

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
    // Code-fenced user prompts get the code band, deterministically
    expect(assistantMessage?.routingBand).toBe('short|prose');

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
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        throw new Error('groq down');
      }
      return { text: 'e2e-ok' };
    });

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
    expect(isClassifierCall({ messages: mockGenerate.mock.calls[0]?.[0] })).toBe(false);
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
