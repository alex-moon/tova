import request from 'supertest';
import { confirmationForToolResults, streamingErrorMessage } from '../../main/routes/chat';
import { createApp } from '../../main/index';
import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';
import { User } from '../../main/models/User';
const mockGenerate = jest.fn();

jest.mock('@mastra/core/agent', () => {
  return {
    Agent: jest.fn().mockImplementation(() => ({
      generate: (...args: unknown[]) => mockGenerate(...args),
    })),
  };
});

const MOCK_ROUTING = {
  model: 'mock-small-model',
  provider: 'deepinfra',
  reason: 'fixed-model',
};

// Routing uses the fixed-roster racing path; the mock stays the seam.
// @see #233
const mockRacingState: { routing: typeof MOCK_ROUTING | null; error?: unknown } = {
  routing: MOCK_ROUTING,
};

jest.mock('../../main/services/chatRace', () => {
  const { inferenceService } = jest.requireActual('../../main/services/inferenceService');
  const failIfSet = () => {
    if (mockRacingState.error) throw mockRacingState.error;
  };
  return {
    chatRoute: () => mockRacingState.routing,
    raceChatCompletion: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const completion = await inferenceService.createCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, completion };
    },
    raceChatStream: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const stream = await inferenceService.createStreamingCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, stream };
    },
  };
});

jest.mock('../../main/services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

// Subtitle revision is fire-and-forget on a turn cadence; mock it here.
// @see #359
const mockRevise = jest.fn();
jest.mock('../../main/services/subtitleService', () => ({
  reviseSessionSubtitle: (...args: unknown[]) => mockRevise(...args),
}));

// Enrichment aux stubbed off; the trace-fact helpers stay real.
// @see #238 #310
jest.mock('../../main/services/workspaceTraceFacts', () =>
  jest.requireActual('../../main/services/workspaceTraceFacts'),
);

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  return response.headers['set-cookie'];
};

beforeEach(() => {
  mockRacingState.routing = MOCK_ROUTING;
  mockRacingState.error = undefined;
});

describe('Chat route routing metadata', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
    });
    mockRacingState.routing = MOCK_ROUTING;
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

  it('initializes the feedback slot on the assistant message', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'feedback-slot@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello there' });

    expect(response.status).toBe(200);
    const assistantMessage = await Message.findOne({ role: 'assistant' });
    expect(assistantMessage?.feedback).toMatchObject({ value: null, updatedAt: null });
  });

  it('persists the turn token usage on the assistant message (#224)', async () => {
    mockGenerate.mockResolvedValue({
      text: 'e2e-ok',
      totalUsage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    });
    const app = createApp();
    const cookies = await registerUser(app, 'usage-meta-1@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello there' });

    expect(response.status).toBe(200);
    const assistantMessage = await Message.findOne({ role: 'assistant' });
    expect(assistantMessage?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 11,
    });
  });

  it('omits usage on the assistant message when the provider reports none (#224)', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'usage-meta-none@example.com');

    const response = await request(app)
      .post('/api/chat')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
      .send({ content: 'Hello there' });

    expect(response.status).toBe(200);
    const assistantMessage = await Message.findOne({ role: 'assistant' });
    expect(assistantMessage?.usage).toBeUndefined();
  });

  it('dispatches a DeepInfra-routed turn to the DeepInfra provider end-to-end', async () => {
    // The DeepInfra path must be exercised at the route level too.
    mockRacingState.routing = {
      model: 'Qwen/Qwen2.5-72B-Instruct',
      reason: 'fixed-model',
      provider: 'deepinfra',
    } as typeof MOCK_ROUTING;
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
    // The classifier also calls generate; only chat may carry the tools.
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return structured(CLASSIFIER_REPLY);
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
    // Leading system message(s) fold into the `instructions` override.
    // @see #198
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

    // The non-streaming route injects the block like the streaming route.
    // @see #253 #310
    it('injects the workspace-memory block when the flag is on (#253, #310)', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-workspace@example.com');

      const retrieve = jest
        .spyOn(
          jest.requireActual<typeof import('../../main/services/workspaceRetrievalService')>(
            '../../main/services/workspaceRetrievalService',
          ),
          'retrieveWorkspaceBlock',
        )
        .mockResolvedValue('- chat "Move" (2026-10-01) — budget is twelve thousand');
      process.env.WORKSPACE_MEMORY_ENABLED = '1';

      try {
        const response = await request(app)
          .post('/api/chat')
          .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
          .send({ content: 'what did we decide about the budget' });

        expect(response.status).toBe(200);
        const content = systemContentFromCall();
        expect(content).toContain('<user:workspace>');
        expect(content).toContain('budget is twelve thousand');
      } finally {
        delete process.env.WORKSPACE_MEMORY_ENABLED;
        retrieve.mockRestore();
      }
    });

    // Kill switch unset: no block injected, retrieval never reached.
    // @see #293
    it('injects no workspace block when the flag is off (#293)', async () => {
      const app = createApp();
      const cookies = await registerUser(app, 'prompt-workspace-off@example.com');

      const retrieve = jest.spyOn(
        jest.requireActual<typeof import('../../main/services/workspaceRetrievalService')>(
          '../../main/services/workspaceRetrievalService',
        ),
        'retrieveWorkspaceBlock',
      );
      delete process.env.WORKSPACE_MEMORY_ENABLED;

      try {
        const response = await request(app)
          .post('/api/chat')
          .set('Cookie', Array.isArray(cookies) ? cookies : [cookies])
          .send({ content: 'what did we decide about the budget' });

        expect(response.status).toBe(200);
        expect(systemContentFromCall()).not.toContain('<user:workspace>');
        expect(retrieve).not.toHaveBeenCalled();
      } finally {
        retrieve.mockRestore();
      }
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

// The mocked Agent bypasses Mastra's parsing; aux mocks carry the object.
// @see #368
const structured = (text: string) => ({ text, object: JSON.parse(text) });

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
    mockRacingState.routing = MOCK_ROUTING;
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
    });
  });

  it('persists deterministic metrics for both turns and the LLM classification for the user turn', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return structured(CLASSIFIER_REPLY);
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

  it('names the file when edit_file succeeded (#325)', () => {
    expect(
      confirmationForToolResults([
        { name: 'edit_file', result: { file: { filename: 'agi-final.md' } } },
      ]),
    ).toBe('Updated agi-final.md.');
    expect(confirmationForToolResults([{ name: 'edit_file', result: { error: 'no_match' } }])).toBe(
      'Updated the file.',
    );
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
  it('maps 413 / request-too-large errors to an actionable connector-rate-limit message (#333)', () => {
    expect(streamingErrorMessage({ statusCode: 413 })).toMatch(/connectors/);
    expect(
      streamingErrorMessage(new Error('Request too large for model `openai/gpt-oss-120b`')),
    ).toMatch(/connectors/);
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
    // Slug-form bodies without a status code must match too.
    expect(streamingErrorMessage(new Error('rate_limit_exceeded'))).toMatch(/Rate limited/);
    // 413 takes precedence within the "tokens" family.
    // @see #117 #77
    expect(streamingErrorMessage({ statusCode: 413, message: 'TPM exceeded' })).toMatch(
      /connectors/,
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
    mockRacingState.error = Object.assign(
      new Error('Rate limit reached on tokens per minute (TPM)'),
      { statusCode: 429 },
    );
    const cookie = await registerUser(app, 'prestream-nonstream-429@example.com');
    const res = await request(app).post('/api/chat').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error processing chat');
    expect(res.body.detail).toMatch(/Rate limited/);
  });

  it('the stream route surfaces the rate-limit detail as an SSE error event', async () => {
    const app = createApp();
    mockGenerate.mockResolvedValue({ text: 'e2e-ok' });
    mockRacingState.error = Object.assign(
      new Error('Rate limit reached on tokens per minute (TPM)'),
      { statusCode: 429 },
    );
    const cookie = await registerUser(app, 'prestream-stream-429@example.com');
    const res = await request(app).post('/api/chat/stream').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    // SSE headers precede the race; failures surface as an error event.
    // @see #387
    expect(res.status).toBe(200);
    const errorEvent = res.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Rate limited');
  });
});

describe('all-backends-failed surfacing (#387)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({
      text: 'e2e-ok',
    });
    // Every backend failing surfaces the actionable error, not a 503.
    mockRacingState.error = new Error('All chat backends failed');
  });

  it('the non-stream route returns 500 with the failure as the detail', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'all-failed-nonstream@example.com');
    const res = await request(app).post('/api/chat').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error processing chat');
    expect(res.body.detail).toMatch(/Error streaming from model/);
  });

  it('the stream route surfaces the failure as an SSE error event', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'all-failed-stream@example.com');
    const res = await request(app).post('/api/chat/stream').set('Cookie', cookie).send({
      content: 'Give me restaurant ideas near Bandra in Mumbai',
    });
    expect(res.status).toBe(200);
    const errorEvent = res.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Error streaming from model');
  });
});

describe('non-streaming tool-only confirmation (#195)', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'e2e-ok' });
    mockRacingState.routing = MOCK_ROUTING;
  });

  it('persists and returns a synthesized confirmation when a tool ran with no text', async () => {
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
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
      if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
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
      if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
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

describe('#226 sessions ordered by most recent message', () => {
  beforeEach(() => {
    mockGenerate.mockReset().mockResolvedValue({ text: 'e2e-ok' });
    mockRacingState.routing = MOCK_ROUTING;
  });

  const listSessionIds = async (
    app: ReturnType<typeof createApp>,
    cookies: string | string[],
  ): Promise<string[]> => {
    const res = await request(app)
      .get('/api/chat/sessions')
      .set('Cookie', Array.isArray(cookies) ? cookies : [cookies]);
    expect(res.status).toBe(200);
    return (res.body as { _id: string }[]).map((s) => s._id);
  };

  it('moves a messaged older session above a newer, never-messaged one', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'order-older-messaged@example.com');
    const cookieHeader = Array.isArray(cookies) ? cookies : [cookies];

    // First session created first, then messaged.
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ content: 'first session turn' });
    const firstId: string = first.body.sessionId;

    // Second session created later but never receives a message.
    const user = await User.findOne({ email: 'order-older-messaged@example.com' });
    const laterEmpty = await Session.create({ userId: user?._id });

    const ids = await listSessionIds(app, cookies);
    // The messaged session (created first) precedes the newer empty one.
    expect(ids[0]).toBe(firstId);
    expect(ids).toContain(String(laterEmpty._id));
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(String(laterEmpty._id)));
  });

  it('reorders a reply to an older chat above a newer chat once it is messaged last', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'order-reorder@example.com');
    const cookieHeader = Array.isArray(cookies) ? cookies : [cookies];

    const older = await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ content: 'older chat first turn' });
    const olderId: string = older.body.sessionId;

    // Newer chat, messaged after the older one's first turn.
    await new Promise((r) => setTimeout(r, 5));
    const newer = await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ content: 'newer chat turn' });
    const newerId: string = newer.body.sessionId;

    // Before the second turn on the older chat, the newer chat is on top.
    let ids = await listSessionIds(app, cookies);
    expect(ids.indexOf(newerId)).toBeLessThan(ids.indexOf(olderId));

    // Message the older chat last; it must jump to the top.
    await new Promise((r) => setTimeout(r, 5));
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookieHeader)
      .send({ sessionId: olderId, content: 'older chat second turn' });

    ids = await listSessionIds(app, cookies);
    expect(ids[0]).toBe(olderId);
    expect(ids.indexOf(olderId)).toBeLessThan(ids.indexOf(newerId));
  });

  it('stamps lastMessageAt with the user message timestamp on a turn', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'order-stamp@example.com');
    const res = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'stamp the session' });
    const sessionId: string = res.body.sessionId;

    const session = await Session.findById(sessionId);
    const userMessage = await Message.findOne({ sessionId, role: 'user' });
    expect(session?.lastMessageAt).toBeTruthy();
    expect(new Date(session!.lastMessageAt as Date).getTime()).toBe(
      new Date(userMessage!.timestamp as Date).getTime(),
    );
  });
});

describe('Subtitle revision cadence (#359)', () => {
  beforeEach(() => {
    mockRevise.mockReset().mockResolvedValue('Fresh subtitle');
  });

  const turn = (
    app: ReturnType<typeof createApp>,
    cookies: string,
    body: Record<string, unknown>,
  ) => request(app).post('/api/chat').set('Cookie', cookies).send(body);

  it('fires after turn 2 (not 1), then not again until the every-6th cadence', async () => {
    const app = createApp();
    const cookies = await registerUser(app, 'subtitle-cadence@example.com');

    const settle = () => new Promise((r) => setTimeout(r, 100));

    const first = await turn(app, cookies, { content: 'turn one' });
    expect(first.status).toBe(200);
    await settle();
    expect(mockRevise).not.toHaveBeenCalled();

    const sessionId: string = first.body.sessionId;
    const second = await turn(app, cookies, { content: 'turn two', sessionId });
    expect(second.status).toBe(200);
    await settle();
    expect(mockRevise).toHaveBeenCalledTimes(1);
    // First revision starts from no subtitle and the latest turns as context.
    expect(mockRevise.mock.calls[0][0]).toBeNull();
    expect(mockRevise.mock.calls[0][1].length).toBeGreaterThan(0);

    await turn(app, cookies, { content: 'turn three', sessionId });
    await settle();
    expect(mockRevise).toHaveBeenCalledTimes(1);

    // Persist the first subtitle so the turn-6 revision reads it back.
    await Session.updateOne({ _id: sessionId }, { $set: { subtitle: 'Fresh subtitle' } });
    for (let i = 4; i <= 6; i += 1) {
      await turn(app, cookies, { content: `turn ${i}`, sessionId });
    }
    await settle();
    expect(mockRevise).toHaveBeenCalledTimes(2);
    expect(mockRevise.mock.calls[1][0]).toBe('Fresh subtitle');
  });
});
