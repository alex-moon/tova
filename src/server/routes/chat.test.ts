import request from 'supertest';
import { confirmationForToolResults, streamingErrorMessage } from './chat';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { AllModelsDisabledError } from '../services/modelConfigService';

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

const MOCK_ROUTING = { model: 'mock-small-model', reason: 'classifier-simple' };

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

  it('passes prior turns, oldest first, to the guard classifier — never the current turn (#169 phase 2)', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'routing-guard-history@example.com');
    const cookieHeader = Array.isArray(cookies) ? cookies : [cookies];

    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ content: 'first question' });
    expect(first.status).toBe(200);
    // First turn of a session: no prior turns exist, so the guard context
    // is the empty tail — the guard judges the bare message.
    expect(mockRouteQuery).toHaveBeenLastCalledWith('first question', undefined, undefined, {
      band: expect.any(String),
      hasImage: false,
      history: [],
    });

    const second = await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ sessionId: first.body.sessionId, content: 'second question' });
    expect(second.status).toBe(200);
    expect(mockRouteQuery).toHaveBeenLastCalledWith(
      'second question',
      undefined,
      undefined,
      expect.objectContaining({
        hasImage: false,
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'e2e-ok' },
        ],
      }),
    );
    // The current turn rides separately as the query — it must never
    // also appear inside the guard's history tail.
    const lastDeps = mockRouteQuery.mock.calls[mockRouteQuery.mock.calls.length - 1]?.[3] as {
      history?: { content: string }[];
    };
    expect(lastDeps.history?.some((m) => m.content === 'second question')).toBe(false);
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
    // #198: the connector strips the caller's leading system message(s) out of
    // the messages array and folds them into the per-call `instructions`
    // override, merged with the agent's tool instructions (which lead the
    // merged string, separated by exactly one blank line). Dropping only that
    // first separator leaves the caller's own system content — which may itself
    // contain blank lines — intact.
    const systemContentFromCall = (): string => {
      for (const call of mockGenerate.mock.calls) {
        const messages = call[0] as unknown as { role: string; content: string }[] | undefined;
        const options = call[1] as { instructions?: string } | undefined;
        if (
          Array.isArray(messages) &&
          typeof options?.instructions === 'string' &&
          !isClassifierCall({ messages })
        ) {
          const [, ...callerParts] = options.instructions.split('\n\n');
          return callerParts.join('\n\n');
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

describe('confirmationForToolResults (#195)', () => {
  it('returns null for an empty list', () => {
    expect(confirmationForToolResults([])).toBeNull();
  });

  it('returns null when only non-user-facing tools ran', () => {
    expect(confirmationForToolResults([{ name: 'current_datetime', result: {} }])).toBeNull();
  });

  it('names the file when generate_file succeeded', () => {
    expect(
      confirmationForToolResults([
        { name: 'generate_file', result: { file: { filename: 'agi-final.md' } } },
      ]),
    ).toBe('Created agi-final.md.');
  });

  it('falls back to a generic file sentence when generate_file failed', () => {
    expect(confirmationForToolResults([{ name: 'generate_file', result: { error: 'boom' } }])).toBe(
      'Created the file.',
    );
    expect(confirmationForToolResults([{ name: 'generate_file', result: { file: {} } }])).toBe(
      'Created the file.',
    );
  });

  it('uses a known sentence per first-party tool', () => {
    expect(confirmationForToolResults([{ name: 'web_search', result: {} }])).toBe(
      'Searched the web.',
    );
    expect(confirmationForToolResults([{ name: 'fetch_url', result: {} }])).toBe(
      'Fetched the page.',
    );
    expect(confirmationForToolResults([{ name: 'list_files', result: {} }])).toBe(
      'Listed your files.',
    );
    expect(confirmationForToolResults([{ name: 'read_file', result: {} }])).toBe('Read the file.');
  });

  it('falls back to a generic sentence for an unknown tool', () => {
    expect(confirmationForToolResults([{ name: 'list_repositories', result: {} }])).toBe(
      'Finished the task.',
    );
  });

  it('joins distinct phrases in first-execution order', () => {
    expect(
      confirmationForToolResults([
        { name: 'list_files', result: {} },
        { name: 'read_file', result: {} },
        { name: 'generate_file', result: { file: { filename: 'out.md' } } },
      ]),
    ).toBe('Listed your files. Read the file. Created out.md.');
  });

  it('deduplicates repeated phrases and caps long runs', () => {
    expect(
      confirmationForToolResults([
        { name: 'web_search', result: {} },
        { name: 'web_search', result: {} },
      ]),
    ).toBe('Searched the web.');
    expect(
      confirmationForToolResults([
        { name: 'web_search', result: {} },
        { name: 'fetch_url', result: {} },
        { name: 'list_files', result: {} },
        { name: 'read_file', result: {} },
      ]),
    ).toBe('Searched the web. Fetched the page. Listed your files. And more.');
  });

  it('ignores current_datetime when it accompanies a real tool', () => {
    expect(
      confirmationForToolResults([
        { name: 'current_datetime', result: {} },
        { name: 'read_file', result: {} },
      ]),
    ).toBe('Read the file.');
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

describe('#168 all-cooling-off surfacing', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
    });
    mockRouteQuery.mockReset().mockRejectedValue(new AllModelsDisabledError());
  });

  it('the non-stream route returns 503 with the friendly message as the primary text', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'all-disabled-nonstream@example.com');
    const res = await request(app).post('/api/chat').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/temporarily unavailable/);
    expect(res.body.detail).toMatch(/temporarily unavailable/);
  });

  it('the stream route returns 503 with the friendly message before any SSE event', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'all-disabled-stream@example.com');
    const res = await request(app).post('/api/chat/stream').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/temporarily unavailable/);
    expect(res.body.detail).toMatch(/temporarily unavailable/);
  });
});

describe('non-streaming tool-only confirmation (#195)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'e2e-ok' });
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
  });

  it('persists and returns a synthesized confirmation when a tool ran with no text', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) return { text: CLASSIFIER_REPLY };
      return {
        text: '',
        toolResults: [{ name: 'generate_file', result: { file: { filename: 'agi-final.md' } } }],
      };
    });
    const app = createApp();
    const cookies = await registerUser(app, 'confirm-nonstream@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Write the document' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('Created agi-final.md.');
    const saved = await Message.findOne({ role: 'assistant' });
    expect(saved?.content).toBe('Created agi-final.md.');
  });

  it('leaves a real assistant answer untouched even when tools ran', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) return { text: CLASSIFIER_REPLY };
      return {
        text: 'The document is ready.',
        toolResults: [{ name: 'generate_file', result: { file: { filename: 'agi-final.md' } } }],
      };
    });
    const app = createApp();
    const cookies = await registerUser(app, 'confirm-nonstream-real@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Write the document' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('The document is ready.');
  });

  it('does not confirm a turn whose only tool is current_datetime', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) return { text: CLASSIFIER_REPLY };
      return { text: '', toolResults: [{ name: 'current_datetime', result: {} }] };
    });
    const app = createApp();
    const cookies = await registerUser(app, 'confirm-nonstream-datetime@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'What is the time' });

    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe('');
  });
});
