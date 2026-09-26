import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { AllModelsDisabledError } from '../services/modelConfigService';

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

const mockRouteQuery = jest.fn();

jest.mock('../services/routerService', () => ({
  routeQuery: (...args: unknown[]) => mockRouteQuery(...args),
}));

const mockDisableModel = jest.fn();

jest.mock('../services/modelConfigService', () => ({
  // Keep the real module; stub only disableModel so the cool-off path never
  // touches the DB (#168).
  ...jest.requireActual('../services/modelConfigService'),
  disableModel: (...args: unknown[]) => mockDisableModel(...args),
}));

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const MOCK_ROUTING = {
  model: 'mock-small-model',
  provider: 'deepinfra',
  reason: 'classifier-simple',
};

const isClassifierCall = (args?: { messages?: { role: string; content: string }[] }) =>
  args?.messages?.[0]?.content.startsWith('Classify the user prompt') ?? false;

const fullStreamFrom = (chunks: string[]) =>
  (async function* () {
    for (const chunk of chunks) {
      yield { type: 'text-delta', payload: { text: chunk } };
    }
  })();

const mockStream = (chunks: string[]) => {
  mockAgentStream.mockImplementation(async () => ({ fullStream: fullStreamFrom(chunks) }));
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
    mockAgentStream
      .mockReset()
      .mockImplementation(async () => Promise.resolve({ fullStream: fullStreamFrom(['chunk']) }));
    mockGenerate.mockReset().mockResolvedValue({ text: 'plain' });
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
      provider: 'deepinfra',
    });
    const session = await Session.findById(sessionId);
    expect(session).not.toBeNull();
  });

  it('passes prior turns, oldest first, to the guard classifier — never the current turn (#169 phase 2)', async () => {
    const cookies = await registerUser('stream-guard-history@example.com');
    const app = createApp();

    const first = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'first question' });
    expect(first.status).toBe(200);
    // First turn of a session: the guard context is the empty tail.
    expect(mockRouteQuery).toHaveBeenLastCalledWith('first question', undefined, undefined, {
      band: expect.any(String),
      hasImage: false,
      history: [],
    });

    const meta = first.text
      .split('\n\n')
      .map((part) => part.split('\n').find((l) => l.startsWith('data: ')))
      .find((l) => l?.includes('"sessionId"'));
    const { sessionId } = JSON.parse((meta as string).slice(6));

    const second = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'second question' });
    expect(second.status).toBe(200);
    expect(mockRouteQuery).toHaveBeenLastCalledWith(
      'second question',
      undefined,
      undefined,
      expect.objectContaining({
        hasImage: false,
        history: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'chunk' },
        ],
      }),
    );
    const lastDeps = mockRouteQuery.mock.calls[mockRouteQuery.mock.calls.length - 1]?.[3] as {
      history?: { content: string }[];
    };
    expect(lastDeps.history?.some((m) => m.content === 'second question')).toBe(false);
  });

  it('passes a client-disconnect abort signal into the provider stream call', async () => {
    const cookies = await registerUser('stream-abort@example.com');
    await mockStream(['ok']);

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const [messages, options] = mockAgentStream.mock.calls[0] as unknown as [
      unknown,
      { abortSignal: AbortSignal },
    ];
    expect(messages).toBeDefined();
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    expect(options.abortSignal.aborted).toBe(false);
  });

  it('emits no delta event and persists an empty-content turn for empty-string deltas', async () => {
    // The stream consumer skips falsy deltas (`if (delta)`): an
    // empty-string text-delta must not surface as an SSE `delta` event, and
    // an all-empty stream must still send `done` and persist an assistant
    // message with content: '' (#4 J) — the UI shows the placeholder.
    const cookies = await registerUser('stream-empty-delta@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: '' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('event: delta');
    const doneLine = response.text.split('\n\n').find((part) => part.includes('event: done'));
    expect(doneLine).toContain('"complete":true');
    const persisted = await Message.findOne({
      role: 'assistant',
      modelName: 'mock-small-model',
    });
    expect(persisted?.content).toBe('');
  });

  it('emits structured tool events when the agent calls web_search and persists deduped sources (#33)', async () => {
    const cookies = await registerUser('stream-search@example.com');
    // The agent ran the tool during a searchable turn: fullStream carries
    // the tool call/result interleaved with the final answer's deltas, and
    // duplicate URLs across two searches are deduped for persistence.
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          payload: { toolName: 'web_search', args: { query: 'groq pricing' } },
        };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'web_search',
            result: {
              results: [
                { title: 'A page', snippet: 'a', url: 'https://a.example.com' },
                { title: 'B page', snippet: 'b', url: 'https://b.example.com' },
              ],
            },
          },
        };
        yield { type: 'text-delta', payload: { text: 'Based on research…' } };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'web_search',
            result: {
              results: [
                { title: 'A page', snippet: 'a', url: 'https://a.example.com' },
                { title: 'C page', snippet: 'c', url: 'https://c.example.com' },
              ],
            },
          },
        };
        yield { type: 'text-delta', payload: { text: ' more' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'what happened today' });

    expect(response.status).toBe(200);
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
    const toolEvents = events.filter((e) => e.event === 'tool');
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0].data).toMatchObject({
      phase: 'call',
      name: 'web_search',
      label: 'Searched the web',
      query: 'groq pricing',
    });
    expect(toolEvents[1].data).toMatchObject({
      phase: 'result',
      name: 'web_search',
      status: 'ok',
      resultCount: 2,
    });
    expect(toolEvents[1].data.domains).toEqual(
      expect.arrayContaining(['a.example.com', 'b.example.com']),
    );
    expect(toolEvents[2].data).toMatchObject({ phase: 'result', name: 'web_search' });
    // No prose-only status events remain from #16.
    expect(response.text).not.toContain('event: status');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.sources).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
    // Per-source titles persisted with the URL (#33).
    expect(persisted?.toObject().sourceTitles).toEqual([
      { url: 'https://a.example.com', title: 'A page' },
      { url: 'https://b.example.com', title: 'B page' },
      { url: 'https://c.example.com', title: 'C page' },
    ]);
    // Titles ride the final done event so the client has them mid-stream.
    const done = events.find((e) => e.event === 'done');
    expect(done?.data.sourceTitles).toHaveLength(3);
  });

  it('emits structured tool events when the agent calls fetch_url and persists the fetched page (#113)', async () => {
    const cookies = await registerUser('stream-fetch-url@example.com');
    // A pasted URL turn: the agent fetches the link via `fetch_url`, which
    // mirrors web_search's `{ results: [...] }` shape so the same provenance
    // extraction persists the fetched URL + page title as a source.
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          payload: {
            toolName: 'fetch_url',
            args: { url: 'https://example.com/groq-docs' },
          },
        };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'fetch_url',
            result: {
              results: [
                {
                  title: 'Groq docs',
                  snippet: 'Fetched page content…',
                  url: 'https://example.com/groq-docs',
                },
              ],
            },
          },
        };
        yield { type: 'text-delta', payload: { text: 'Here is the page summary…' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'summarise https://example.com/groq-docs' });

    expect(response.status).toBe(200);
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
    const toolEvents = events.filter((e) => e.event === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].data).toMatchObject({
      phase: 'call',
      name: 'fetch_url',
      label: 'Fetched the page',
    });
    expect(toolEvents[1].data).toMatchObject({
      phase: 'result',
      name: 'fetch_url',
      status: 'ok',
      resultCount: 1,
      domains: ['example.com'],
    });
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.sources).toEqual(['https://example.com/groq-docs']);
    expect(persisted?.toObject().sourceTitles).toEqual([
      { url: 'https://example.com/groq-docs', title: 'Groq docs' },
    ]);
    const done = events.find((e) => e.event === 'done');
    expect(done?.data.sourceTitles).toEqual([
      { url: 'https://example.com/groq-docs', title: 'Groq docs' },
    ]);
  });

  it('emits an empty-status tool result when the search returns nothing', async () => {
    const cookies = await registerUser('stream-search-empty@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'web_search', input: { query: 'q' } } };
        yield { type: 'tool-result', payload: { toolName: 'web_search', result: { results: [] } } };
        yield { type: 'text-delta', payload: { text: 'no luck' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'search for something obscure' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"phase":"result"');
    expect(response.text).toContain('"status":"empty"');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.sources).toBeUndefined();
  });

  it('maps result counts per tool (#114): list_files files.length, MCP single-array field, no count otherwise', async () => {
    const cookies = await registerUser('stream-tool-counts@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'list_files', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'list_files', result: { files: ['a.txt', 'b.txt'] } },
        };
        yield { type: 'tool-call', payload: { toolName: 'list_repositories', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'list_repositories', result: { repositories: [1, 2, 3, 4] } },
        };
        yield { type: 'tool-call', payload: { toolName: 'read_file', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'read_file', result: { content: 'hello', path: 'x.txt' } },
        };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'list things' });

    const toolEvents = response.text
      .split('\n\n')
      .filter((part) => part.includes('event: tool'))
      .map((part) =>
        JSON.parse(
          part
            .split('\n')
            .find((l) => l.startsWith('data: '))!
            .slice(6),
        ),
      )
      .filter((e) => e.phase === 'result');
    expect(toolEvents).toEqual([
      expect.objectContaining({
        name: 'list_files',
        status: 'ok',
        resultCount: 2,
      }),
      expect.objectContaining({
        name: 'list_repositories',
        status: 'ok',
        resultCount: 4,
      }),
      expect.objectContaining({ name: 'read_file', status: 'ok' }),
    ]);
    expect(toolEvents[0].domains).toBeUndefined();
    expect(toolEvents[2].resultCount).toBeUndefined();
  });

  it('suppresses the count on a degraded list_files result (empty files + error)', async () => {
    const cookies = await registerUser('stream-degraded-list@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'list_files', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'list_files', result: { files: [], error: 'assets unavailable' } },
        };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'list things' });

    const toolEvent = response.text
      .split('\n\n')
      .filter((part) => part.includes('event: tool'))
      .map((part) =>
        JSON.parse(
          part
            .split('\n')
            .find((l) => l.startsWith('data: '))!
            .slice(6),
        ),
      )
      .find((e) => e.phase === 'result');
    expect(toolEvent).toEqual(expect.objectContaining({ name: 'list_files', status: 'empty' }));
    expect(toolEvent.resultCount).toBeUndefined();
  });

  it('delivers follow-up suggestions on done and persists them on the message', async () => {
    const cookies = await registerUser('stream-suggestions@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['A thoughtful answer.']),
    }));
    // The follow-up generator is the next plain completion call (the chat
    // itself streams); classification also rides mockGenerate, so gate it.
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) return { text: CLASSIFIER_REPLY };
      if (
        messages?.[0]?.role === 'system' &&
        String(messages[0].content).startsWith('Generate 2-3')
      ) {
        return { text: '["What about pricing?","Show an example"]' };
      }
      return { text: 'plain' };
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const done = response.text.split('\n\n').find((part) => part.includes('event: done'));
    const doneData = JSON.parse(
      done!
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6),
    );
    expect(doneData.message.suggestions).toEqual(['What about pricing?', 'Show an example']);
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.suggestions).toEqual(['What about pricing?', 'Show an example']);
  });

  it('omits suggestions for trivially neutral prompts', async () => {
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['done.']),
    }));
    mockGenerate.mockImplementation(async () =>
      Promise.reject(new Error('no completion calls expected')),
    );

    const cookies = await registerUser('stream-suggest-trivial@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'please continue' });

    expect(response.status).toBe(200);
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.suggestions).toBeUndefined();
  });

  it('omits sources entirely on a tool-free turn', async () => {
    const cookies = await registerUser('stream-no-search@example.com');
    await mockStream(['plain answer']);

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hi' });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('event: tool');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.sources).toBeUndefined();
  });

  describe('per-user system prompt (issue #35)', () => {
    const streamSystemContent = (): string => {
      const [messages] = mockAgentStream.mock.calls[
        mockAgentStream.mock.calls.length - 1
      ] as unknown as [{ role: string; content: string }[]];
      const system = messages.find((m) => m.role === 'system');
      if (!system) throw new Error('no system message found in stream call');
      return system.content;
    };

    it('uses the global prompt when the user has no setting or profile', async () => {
      const cookies = await registerUser('stream-prompt-global@example.com');
      await mockStream(['ok']);

      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'hi' });

      expect(response.status).toBe(200);
      expect(streamSystemContent()).toMatch(/^You are Tova/);
    });

    it('uses user.settings.customInstructions when set, in place of the global prompt', async () => {
      const cookies = await registerUser('stream-prompt-custom@example.com');
      const doc = await User.findOne({ email: 'stream-prompt-custom@example.com' });
      if (!doc) throw new Error('user not found');
      doc.settings = { customInstructions: 'Stream-time custom prompt.' };
      await doc.save();
      await mockStream(['ok']);

      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'hi' });

      expect(response.status).toBe(200);
      expect(streamSystemContent()).toContain(
        '<user:custom_instructions>\nStream-time custom prompt.\n</user:custom_instructions>',
      );
    });

    it('appends the profile-context block from the user document', async () => {
      const cookies = await registerUser('stream-prompt-profile@example.com');
      const doc = await User.findOne({ email: 'stream-prompt-profile@example.com' });
      if (!doc) throw new Error('user not found');
      doc.name = 'Ada Lovelace';
      doc.preferredName = 'Ada';
      await doc.save();
      await mockStream(['ok']);

      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'hi' });

      expect(response.status).toBe(200);
      const content = streamSystemContent();
      expect(content).toMatch(/^You are Tova/);
      expect(content).toContain('<user:preferred_name>\nAda\n</user:preferred_name>');
      expect(content).toContain('<user:full_name>\nAda Lovelace\n</user:full_name>');
      expect(content).toContain('never address the user by it');
    });
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
    mockGenerate.mockReset();
    mockAgentStream.mockReset();
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
  });

  it('attaches metrics to streamed turns and classifies the user message', async () => {
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['Hi.']),
    }));
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return { text: `\`\`\`json\n${CLASSIFIER_REPLY}\n\`\`\`` };
      }
      return { text: 'plain' };
    });

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
    mockGenerate.mockImplementation(async () =>
      Promise.reject(new Error('classifier should not be called')),
    );
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['done.']),
    }));

    const cookies = await registerUser('stream-trivial@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'please continue' });

    expect(response.status).toBe(200);
    await flush();
    // The only completion call is the streamed chat itself — no classifier.
    for (const call of mockGenerate.mock.calls) {
      expect(isClassifierCall({ messages: call[0] as { role: string; content: string }[] })).toBe(
        false,
      );
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

/*
 * #168 streaming failover: an endpoint failure with no deltas yet disables
 * the model and re-routes (re-emitting 'meta'); a rate-limit failure fails
 * loudly without disabling; a failed cool-off write stops the loop with the
 * original error; a fully cooled-off pool returns 503 before the stream
 * opens. Mastra rethrows provider stream errors as plain Errors carrying the
 * payload text (no status code), which is exactly the message-shaped
 * classification these tests use.
 */
describe('Chat streaming route — #168 endpoint failures', () => {
  const errorStreamFrom = (message: string) =>
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'error', payload: { error: { message } } };
      })(),
    }));

  const sseEvents = (response: { text: string }) =>
    response.text
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

  beforeEach(() => {
    mockAgentStream.mockReset();
    mockGenerate.mockReset().mockResolvedValue({ text: 'plain' });
    mockRouteQuery.mockReset().mockResolvedValue(MOCK_ROUTING);
    mockDisableModel.mockReset().mockResolvedValue(true);
  });

  it('disables a failing stream endpoint and re-emits meta after re-routing', async () => {
    mockRouteQuery
      .mockResolvedValueOnce({ model: 'first-model', provider: 'deepinfra', reason: 'test' })
      .mockResolvedValueOnce({ model: 'second-model', provider: 'deepinfra', reason: 'test' });
    mockAgentStream
      .mockImplementationOnce(async () => ({
        fullStream: (async function* () {
          yield { type: 'error', payload: { error: { message: 'upstream exploded' } } };
        })(),
      }))
      .mockImplementationOnce(async () => ({ fullStream: fullStreamFrom(['recovered.']) }));

    const cookies = await registerUser('stream-failover@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const events = sseEvents(response);
    const metas = events.filter((e) => e.event === 'meta');
    expect(metas).toHaveLength(2);
    expect(metas[1].data).toMatchObject({ routing: { model: 'second-model' } });
    expect(
      events
        .filter((e) => e.event === 'delta')
        .map((e) => e.data.content)
        .join(''),
    ).toBe('recovered.');
    expect(mockDisableModel).toHaveBeenCalledTimes(1);
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'first-model');
  });

  it('a rate-limit stream failure surfaces the retry hint without disabling the model', async () => {
    errorStreamFrom('rate limit exceeded');

    const cookies = await registerUser('stream-429@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const errorEvent = response.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Rate limited by the model provider');
    expect(mockDisableModel).not.toHaveBeenCalled();
    expect(mockRouteQuery).toHaveBeenCalledTimes(1);
  });

  it('stops the loop and surfaces the original error when the cool-off write fails', async () => {
    mockDisableModel.mockResolvedValueOnce(false);
    errorStreamFrom('upstream exploded');

    const cookies = await registerUser('stream-write-fail@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const errorEvent = response.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Error streaming from model');
    expect(mockDisableModel).toHaveBeenCalledTimes(1);
    expect(mockDisableModel).toHaveBeenCalledWith('deepinfra', 'mock-small-model');
    expect(mockRouteQuery).toHaveBeenCalledTimes(1); // no re-route happened
  });

  it('returns 503 with the all-disabled message when routing fails before the stream opens (#168)', async () => {
    // Every completion model already cooling off at turn start: routeQuery
    // throws AllModelsDisabledError pre-SSE — the user must see the friendly
    // message, not "Error processing chat" / a generic client failure.
    mockRouteQuery.mockReset().mockRejectedValue(new AllModelsDisabledError());

    const cookies = await registerUser('stream-pool-empty@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/);
    expect(response.body.detail).toMatch(/temporarily unavailable/);
    expect(mockDisableModel).not.toHaveBeenCalled();
  });
});
