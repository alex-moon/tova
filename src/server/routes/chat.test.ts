import request from 'supertest';
import { streamingErrorMessage } from './chat';
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

  describe('per-user system prompt (issue #35)', () => {
    const systemContentFromCall = (): string => {
      for (const call of mockGenerate.mock.calls) {
        const messages = call[0] as unknown as { role: string; content: string }[] | undefined;
        if (
          Array.isArray(messages) &&
          messages[0]?.role === 'system' &&
          !isClassifierCall({ messages })
        ) {
          return messages[0].content;
        }
      }
      throw new Error('no chat completion call with a system message found');
    };

    it('uses the global prompt when the user has no setting', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-global@example.com');

      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
        .send({ content: 'Hello' });

      expect(response.status).toBe(200);
      expect(systemContentFromCall()).toMatch(/^You are Tova/);
    });

    it('overrides the global prompt with user.settings.customInstructions', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-custom@example.com');
      const doc = await User.findOne({ email: 'prompt-custom@example.com' });
      if (!doc) throw new Error('user not found');
      doc.settings = { customInstructions: 'Always answer in rhyming couplets.' };
      await doc.save();

      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
        .send({ content: 'Hello' });

      expect(response.status).toBe(200);
      expect(systemContentFromCall()).toContain(
        '<user:custom_instructions>\nAlways answer in rhyming couplets.\n</user:custom_instructions>',
      );
    });

    it('appends the profile-context block from the user document', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-profile@example.com');
      const doc = await User.findOne({ email: 'prompt-profile@example.com' });
      if (!doc) throw new Error('user not found');
      doc.preferredName = 'Alex';
      await doc.save();

      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
        .send({ content: 'Hello' });

      expect(response.status).toBe(200);
      const content = systemContentFromCall();
      expect(content).toMatch(/^You are Tova/);
      expect(content).toContain('<user:preferred_name>\nAlex\n</user:preferred_name>');
    });

    it("never leaks one user's customInstructions into another user's request", async () => {
      const app = createApp();
      const ownerCookies = await registerUser(app, 'prompt-owner@example.com');
      const otherCookies = await registerUser(app, 'prompt-isolation@example.com');
      const doc = await User.findOne({ email: 'prompt-owner@example.com' });
      if (!doc) throw new Error('user not found');
      doc.settings = { customInstructions: 'Owner-only secret prompt.' };
      await doc.save();

      const mine = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(ownerCookies) ? ownerCookies : [ownerCookies])
        .send({ content: 'Hello' });
      expect(mine.status).toBe(200);
      expect(systemContentFromCall()).toContain('Owner-only secret prompt.');

      mockGenerate.mockClear();
      const others = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(otherCookies) ? otherCookies : [otherCookies])
        .send({ content: 'Hello' });
      expect(others.status).toBe(200);
      expect(systemContentFromCall()).not.toContain('Owner-only secret prompt.');
      expect(systemContentFromCall()).toMatch(/^You are Tova/);
    });

    it('reflects a PATCH-route clear on the very next message (request-time resolution)', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'patch-clear@example.com');
      const cookieList = Array.isArray(cookies) ? cookies : [cookies];

      const doc = await User.findOne({ email: 'patch-clear@example.com' });
      if (!doc) throw new Error('user not found');
      doc.settings = { customInstructions: 'Temporary override.' };
      await doc.save();

      const first = await request(app)
        .post('/api/chat')
        .set('Cookie', cookieList)
        .send({ content: 'Hello' });
      expect(first.status).toBe(200);
      expect(systemContentFromCall()).toContain(
        '<user:custom_instructions>\nTemporary override.\n</user:custom_instructions>',
      );

      await request(app)
        .patch('/api/profile')
        .set('Cookie', cookieList)
        .send({ customInstructions: '' });
      mockGenerate.mockClear();

      const second = await request(app)
        .post('/api/chat')
        .set('Cookie', cookieList)
        .send({ content: 'Hello' });
      expect(second.status).toBe(200);
      expect(systemContentFromCall()).toMatch(/^You are Tova/);
    });

    it('ignores a whitespace-only customInstructions and falls back to the global prompt', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-blank@example.com');
      const doc = await User.findOne({ email: 'prompt-blank@example.com' });
      if (!doc) throw new Error('user not found');
      doc.settings = { customInstructions: '   \n' };
      await doc.save();

      const response = await request(app)
        .post('/api/chat')
        .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
        .send({ content: 'Hello' });

      expect(response.status).toBe(200);
      expect(systemContentFromCall()).toMatch(/^You are Tova/);
    });
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

describe('streamingErrorMessage (#77, #117)', () => {
  it('maps 413 / request-too-large errors to an actionable MCP-rate-limit message', () => {
    expect(streamingErrorMessage({ statusCode: 413 })).toMatch(/MCP servers/);
    expect(
      streamingErrorMessage(new Error('Request too large for model `openai/gpt-oss-120b`')),
    ).toMatch(/MCP servers/);
  });

  it('maps 429 / rate-limit errors to an actionable retry message (#117)', () => {
    expect(streamingErrorMessage({ statusCode: 429 })).toMatch(/Rate limited/);
    expect(
      streamingErrorMessage(
        new Error(
          'Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000',
        ),
      ),
    ).toMatch(/Rate limited/);
    expect(streamingErrorMessage(new Error('helpful nudge: TPM exceeded'))).toMatch(/Rate limited/);
    // Slug-form bodies rethrown without a status code (DeepInfra-style
    // `rate_limit_exceeded`) must match too — separators are not just spaces.
    expect(streamingErrorMessage(new Error('rate_limit_exceeded'))).toMatch(/Rate limited/);
    // 413 takes precedence — it is the more specific diagnosis of the same
    // "tokens" family, and #117 must not unlink #77's message.
    expect(streamingErrorMessage({ statusCode: 413, message: 'TPM exceeded' })).toMatch(
      /MCP servers/,
    );
  });

  it('keeps the generic message for everything else', () => {
    expect(streamingErrorMessage(new Error('boom'))).toBe('Error streaming from model');
    expect(streamingErrorMessage(null)).toBe('Error streaming from model');
    expect(streamingErrorMessage({ statusCode: 500 })).toBe('Error streaming from model');
  });
});

describe('pre-stream 429 surfacing (#117)', () => {
  it('the non-stream route surfaces the rate-limit detail additively on failure', async () => {
    const app = createApp();
    mockGenerate.mockResolvedValue({ text: 'e2e-ok' });
    mockRouteQuery.mockRejectedValueOnce(
      Object.assign(new Error('Rate limit reached on tokens per minute (TPM)'), {
        statusCode: 429,
      }),
    );
    const cookie = await registerUser(app, 'prestream-nonstream-429@example.com');
    const res = await request(app).post('/api/chat').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error processing chat');
    expect(res.body.detail).toMatch(/Rate limited/);
  });

  it('the stream route surfaces the rate-limit detail when it fails before any SSE event', async () => {
    const app = createApp();
    mockGenerate.mockResolvedValue({ text: 'e2e-ok' });
    mockRouteQuery.mockRejectedValueOnce(
      Object.assign(new Error('Rate limit reached on tokens per minute (TPM)'), {
        statusCode: 429,
      }),
    );
    const cookie = await registerUser(app, 'prestream-stream-429@example.com');
    const res = await request(app).post('/api/chat/stream').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error processing chat');
    expect(res.body.detail).toMatch(/Rate limited/);
  });
});
