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

const mockWebSearch = jest.fn();

jest.mock('../services/webSearchService', () => ({
  webSearch: (...args: unknown[]) => mockWebSearch(...args),
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

describe('Chat route web search tool loop', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
    mockWebSearch
      .mockReset()
      .mockResolvedValue([
        { title: 'Brave result', snippet: 'fresh info', url: 'https://example.com/fresh' },
      ]);
  });

  it('executes the tool round and persists the grounded answer with sources', async () => {
    mockCreate.mockImplementation(
      (args?: { tools?: unknown[]; messages?: { role: string; content: string }[] }) => {
        if (isClassifierCall(args)) {
          return { choices: [{ message: { content: CLASSIFIER_REPLY } }] };
        }
        const chatCallNumber = mockCreate.mock.calls.filter(
          (c) => !isClassifierCall(c?.[0]),
        ).length;
        if (chatCallNumber === 1) {
          expect(args?.tools?.[0]).toMatchObject({ function: { name: 'web_search' } });
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'web_search', arguments: '{"query":"groq news"}' },
                    },
                  ],
                },
              },
            ],
          };
        }
        return {
          choices: [
            {
              message: {
                content: 'Grounded answer citing [fresh info](https://example.com/fresh).',
              },
            },
          ],
        };
      },
    );

    const app = createApp();
    const cookies = await registerUser(app, 'search-nonstream@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'What is the latest Groq news?' });

    expect(response.status).toBe(200);
    // A call must carry the tool result back to the model
    const secondCallArgs = mockCreate.mock.calls
      .map((c) => c[0])
      .find((a) =>
        (a as { messages?: { role: string }[] }).messages?.some((m) => m.role === 'tool'),
      ) as { messages: { role: string }[] } | undefined;
    expect(secondCallArgs?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool' })]),
    );
    expect(mockWebSearch).toHaveBeenCalledWith('groq news');

    expect(response.body.message.sources).toEqual(['https://example.com/fresh']);
    const saved = await Message.findOne({ role: 'assistant', sessionId: response.body.sessionId });
    expect(saved?.sources).toEqual(['https://example.com/fresh']);
    expect(saved?.content).toContain('Grounded answer');
  });

  it('persists no sources when the model answers without tool calls', async () => {
    mockCreate.mockImplementation(
      (args?: { tools?: unknown[]; messages?: { role: string; content: string }[] }) => {
        if (isClassifierCall(args)) {
          return { choices: [{ message: { content: CLASSIFIER_REPLY } }] };
        }
        expect(args?.tools?.[0]).toMatchObject({ function: { name: 'web_search' } });
        return { choices: [{ message: { content: 'No search needed' } }] };
      },
    );

    const app = createApp();
    const cookies = await registerUser(app, 'search-noop@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello' });

    expect(response.status).toBe(200);
    expect(mockWebSearch).not.toHaveBeenCalled();
    expect(response.body.message.sources).toBeUndefined();
  });

  it('degrades gracefully when the search returns no results', async () => {
    mockWebSearch.mockResolvedValue([]);
    mockCreate
      .mockImplementationOnce(async () => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"x"}' },
                },
              ],
            },
          },
        ],
      }))
      .mockImplementationOnce(async () => ({
        choices: [{ message: { content: 'Answered without results' } }],
      }));

    const app = createApp();
    const cookies = await registerUser(app, 'search-empty@example.com');
    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Search something' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('Answered without results');
    expect(response.body.message.sources).toBeUndefined();
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
