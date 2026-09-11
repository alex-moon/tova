import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
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

const mockStream = (chunks: string[]) => {
  const streamIterator = async function* () {
    for (const chunk of chunks) {
      yield { choices: [{ delta: { content: chunk } }] };
    }
  };
  mockCreate.mockImplementation(async (args?: { stream?: boolean }) => {
    if (args?.stream) {
      return { [Symbol.asyncIterator]: streamIterator };
    }
    return { choices: [{ message: { content: 'plain' } }] };
  });
};

const registerUser = async (email: string): Promise<string[]> => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies];
};

describe('Chat streaming route', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockImplementation(async (args?: { stream?: boolean }) =>
      args?.stream
        ? {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: 'chunk' } }] };
            },
          }
        : { choices: [{ message: { content: 'plain' } }] },
    );
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
  });

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
      routing: MOCK_ROUTING,
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
      modelName: 'mock-small-model',
    });
    const session = await Session.findById(sessionId);
    expect(session).not.toBeNull();
  });
});

const CLASSIFIER_REPLY =
  '{"emotional": true, "technical": false, "abstract": false, "sentiment": "neutral", "openEnded": false}';

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

describe('Chat streaming prompt metrics', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
  });

  it('attaches metrics to streamed turns and classifies the user message', async () => {
    const streamIterator = async function* () {
      yield { choices: [{ delta: { content: 'Hi.' } }] };
    };
    mockCreate.mockImplementation(
      async (args?: { stream?: boolean; messages?: { role: string; content: string }[] }) => {
        if (args?.stream) {
          return { [Symbol.asyncIterator]: streamIterator };
        }
        if (args?.messages?.[0]?.content.startsWith('Classify the user prompt')) {
          return { choices: [{ message: { content: `\`\`\`json\n${CLASSIFIER_REPLY}\n\`\`\`` } }] };
        }
        return { choices: [{ message: { content: 'plain' } }] };
      },
    );

    const cookies = await registerUser('stream-metrics@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'Fix this for me please' });

    expect(response.status).toBe(200);

    const persisted = await Message.find().sort({ timestamp: 1 });
    const sessionId = persisted[0]?.sessionId;
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.metrics).toMatchObject({
      hasImperative: true,
      hasQuestionMark: false,
      sessionMessageIndex: 0,
    });
    expect(persisted[1]?.metrics).toMatchObject({
      sessionMessageIndex: 1,
      codeIndicators: { fences: 0, backticks: 0, codeTokenCount: 0 },
    });
    expect((await Session.findById(sessionId)) ?? null).not.toBeNull();

    // User turn (not assistant) gets an LLM classification. Re-fetch after
    // the flush so the assertion cannot depend on stale pre-classification
    // documents.
    await flush();
    const [userMessage, assistantMessage] = await Message.find({ sessionId }).sort({
      timestamp: 1,
    });
    expect(userMessage.metrics?.llm).toEqual({
      emotional: true,
      technical: false,
      abstract: false,
      sentiment: 'neutral',
      openEnded: false,
    });
    expect(userMessage.metrics?.llmSkipReason).toBeNull();
    expect(assistantMessage.metrics?.llm).toMatchObject({
      emotional: null,
      technical: null,
      abstract: null,
      sentiment: null,
      openEnded: null,
    });
  });

  it('skips classification for trivially neutral prompts on the streaming endpoint', async () => {
    // Any classifier call here would find a mock client that leaves an
    // 'error'/'parse' reason behind; the skip must avoid the call entirely.
    mockCreate.mockImplementation(async (args?: { stream?: boolean }) =>
      args?.stream
        ? {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: 'done.' } }] };
            },
          }
        : Promise.reject(new Error('classifier should not be called')),
    );

    const cookies = await registerUser('stream-trivial@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'please continue' });

    expect(response.status).toBe(200);
    await flush();
    // The only completion call is the streamed chat itself — no classifier.
    for (const call of mockCreate.mock.calls) {
      expect(
        (
          call[0] as { messages?: { content: string }[] } | undefined
        )?.messages?.[0]?.content.startsWith('Classify the user prompt'),
      ).toBe(false);
    }

    const userMessage = await Message.findOne({ role: 'user' });
    expect(userMessage?.metrics?.llm).toMatchObject({
      emotional: null,
      technical: null,
      abstract: null,
      sentiment: null,
      openEnded: null,
    });
    expect(userMessage?.metrics?.llmSkipReason).toBe('trivial');
    // Deterministic metrics are still attached to the trivial skip
    expect(userMessage?.metrics?.sessionMessageIndex).toBe(0);
  });
});
