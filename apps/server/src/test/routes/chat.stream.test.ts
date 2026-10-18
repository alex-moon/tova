import request from 'supertest';
import { createApp } from '../../main/index';
import { Message } from '../../main/models/Message';
import { Session } from '../../main/models/Session';
import { User } from '../../main/models/User';
import {
  HISTORY_MAX_CHARS,
  HISTORY_MAX_MESSAGES,
  messagesFromPersistedHistory,
  paragraphBreakFor,
  reconcileToolEvent,
  stripProvenanceLines,
  toolProvenanceLine,
  windowedHistory,
  type PersistedToolEvent,
} from '../../main/routes/chat';

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

const MOCK_ROUTING = {
  model: 'mock-small-model',
  provider: 'deepinfra',
  reason: 'fixed-model',
};

// Routing uses the fixed-roster racing path; `mockRacingState` stays the seam.
// @see #233
const mockRacingState: {
  routing: typeof MOCK_ROUTING | null;
  error?: unknown;
} = { routing: MOCK_ROUTING };

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

// Enrichment aux stubbed out; trace-fact helpers stay real for route metadata.
// @see #238 #310
jest.mock('../../main/services/workspaceTraceFacts', () =>
  jest.requireActual('../../main/services/workspaceTraceFacts'),
);

const isClassifierCall = (args?: { messages?: { role: string; content: string }[] }) =>
  args?.messages?.[0]?.content.startsWith('Classify the user prompt') ?? false;

// Honesty guard audit calls identify themselves by their system prompt.
// @see #371
const isHonestyGuardCall = (args?: { messages?: { role: string; content: string }[] }) =>
  args?.messages?.[0]?.content.startsWith('You audit assistant replies') ?? false;

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
    mockRacingState.routing = MOCK_ROUTING;
    mockRacingState.error = undefined;
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

  // User turns are stamped (models would echo stamps); assistants are not.
  // @see #261 #315
  it('stamps user turns only and drops the date line in the prompt (#261, #315)', async () => {
    const cookies = await registerUser('stream-timestamps@example.com');
    await mockStream(['ok']);

    const userId = (await User.findOne({ email: 'stream-timestamps@example.com' }))!._id;
    const session = await Session.create({ userId, title: 'timestamps' });
    // Seeds are relative to now so the asserted gap does not rot with time.
    const firstTurnAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60 * 1000);
    const firstReplyAt = new Date(firstTurnAt.getTime() + 60 * 1000);
    await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'first turn',
      timestamp: firstTurnAt,
    });
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'first reply',
      timestamp: firstReplyAt,
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ sessionId: String(session._id), content: 'second turn' });

    expect(response.status).toBe(200);
    const [turns, options] = mockAgentStream.mock.calls[0] as unknown as [
      { role: string; content: string }[],
      { instructions: string },
    ];
    // The date line is gone on the persisted path.
    expect(options.instructions).not.toContain("Today's date is");
    // Seeded user turns carry absolute stamps; assistant turns ride bare.
    // @see #315
    const stamp = (d: Date) =>
      `[${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC]`;
    const userTurns = turns.filter((m) => m.role === 'user');
    expect(userTurns[0].content).toBe(`${stamp(firstTurnAt)}\nfirst turn`);
    // The assistant turn is unstamped — no stamp, no echo pressure.
    // @see #315
    const assistantTurn = turns.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toBe('first reply');
    // The gap still measures from the previous turn regardless of role.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const currentStamp = `${now.toISOString().slice(0, 10)} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
    expect(userTurns[1].content).toMatch(
      new RegExp(
        `^\\[${currentStamp} UTC — \\d+ (hour|day|week|month|year)s? since the last message\\]\\nsecond turn$`,
      ),
    );
  });

  // With the flag on the block is retrieved unconditionally and wired in.
  // @see #253 #310
  it('injects the workspace-memory block when the flag is on (#253, #310)', async () => {
    const cookies = await registerUser('stream-workspace@example.com');
    await mockStream(['ok']);

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
      const userId = (await User.findOne({ email: 'stream-workspace@example.com' }))!._id;
      const session = await Session.create({ userId, title: 'workspace' });
      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ sessionId: String(session._id), content: 'what did we decide about the budget' });

      expect(response.status).toBe(200);
      const [, options] = mockAgentStream.mock.calls[0] as unknown as [
        unknown,
        { instructions: string; tracingOptions?: { metadata?: Record<string, unknown> } },
      ];
      expect(options.instructions).toContain('<user:workspace>');
      expect(options.instructions).toContain('budget is twelve thousand');
      // The retrieval outcome + hit count ride the main call's trace metadata.
      // @see #308
      expect(options.tracingOptions?.metadata).toMatchObject({
        tova_workspace_gate: 'yes',
        tova_workspace_hits: 1,
      });
    } finally {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
      retrieve.mockRestore();
    }
  });

  // ZDR/incognito turns keep the date line as their only clock.
  // @see #261
  it('keeps the date line and leaves ZDR replay turns unstamped (#261)', async () => {
    const cookies = await registerUser('stream-timestamps-zdr@example.com');
    await mockStream(['ok']);

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({
        content: 'second turn',
        zdr: true,
        history: [
          { role: 'user', content: 'first turn' },
          { role: 'assistant', content: 'first reply' },
        ],
      });

    expect(response.status).toBe(200);
    const [turns, options] = mockAgentStream.mock.calls[0] as unknown as [
      { role: string; content: string }[],
      { instructions: string },
    ];
    expect(options.instructions).toMatch(/Today's date is/);
    expect(turns.find((m) => m.role === 'user')?.content).toBe('first turn');
    expect(turns.find((m) => m.role === 'assistant')?.content).toBe('first reply');
  });

  // With a stored zone the prompt carries local times; storage stays UTC.
  // @see #261
  it('renders the prompt in the user’s local zone when settings.timezone is set (#261)', async () => {
    const cookies = await registerUser('stream-timestamps-tz@example.com');
    await User.updateOne(
      { email: 'stream-timestamps-tz@example.com' },
      { settings: { customInstructions: null, timezone: 'Europe/London' } },
    );
    await mockStream(['ok']);

    const userId = (await User.findOne({ email: 'stream-timestamps-tz@example.com' }))!._id;
    const session = await Session.create({ userId, title: 'tz' });
    await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'first turn',
      timestamp: new Date('2026-10-08T14:32:00Z'), // 15:32 BST
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ sessionId: String(session._id), content: 'second turn' });

    expect(response.status).toBe(200);
    const [turns, options] = mockAgentStream.mock.calls[0] as unknown as [
      { role: string; content: string }[],
      { instructions: string },
    ];
    // The UTC instant renders as the user's wall clock; the zone is named.
    expect(turns.find((m) => m.role === 'user')?.content).toBe(
      '[2026-10-08 15:32 GMT+1]\nfirst turn',
    );
    expect(options.instructions).toMatch(
      /The user's timezone is Europe\/London \(currently GMT(?:[+-]\d+(?::\d+)?)?\)\./,
    );
    // The persisted path still drops the redundant date line.
    // @see #261
    expect(options.instructions).not.toContain("Today's date is");
    // Storage is untouched: the message keeps raw content; sort explicitly.
    // @see #377
    const stored = await Message.findOne({ sessionId: session._id, role: 'user' }).sort({
      timestamp: 1,
    });
    expect(stored?.content).toBe('first turn');
    expect(new Date(stored?.timestamp as Date).toISOString()).toBe('2026-10-08T14:32:00.000Z');
  });

  it('persists the turn token usage on the assistant message (#224)', async () => {
    const cookies = await registerUser('stream-usage@example.com');
    // Usage surfaces as one trailing chunk mapped from `totalUsage`.
    // @see #224
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'hi' } };
      })(),
      totalUsage: Promise.resolve({ inputTokens: 11, outputTokens: 22, totalTokens: 33 }),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });
    expect(response.status).toBe(200);

    const meta = response.text
      .split('\n\n')
      .map((part) => part.split('\n').find((l) => l.startsWith('data: ')))
      .find((l) => l?.includes('"sessionId"'));
    const { sessionId } = JSON.parse((meta as string).slice(6));

    const assistant = await Message.findOne({ sessionId, role: 'assistant' });
    expect(assistant?.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    });
  });

  it('omits usage on the assistant message when the provider reports none (#224)', async () => {
    const cookies = await registerUser('stream-no-usage@example.com');
    await mockStream(['ok']);

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });
    expect(response.status).toBe(200);

    const meta = response.text
      .split('\n\n')
      .map((part) => part.split('\n').find((l) => l.startsWith('data: ')))
      .find((l) => l?.includes('"sessionId"'));
    const { sessionId } = JSON.parse((meta as string).slice(6));

    const assistant = await Message.findOne({ sessionId, role: 'assistant' });
    expect(assistant?.usage).toBeUndefined();
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
    // Falsy deltas are skipped; an all-empty stream still persists ''.
    // @see #4
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
    // Tool call/result interleaves with deltas; duplicate URLs are deduped.
    // @see #33
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
    // No prose-only status events remain.
    // @see #16
    expect(response.text).not.toContain('event: status');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.sources).toEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
    // Per-source titles persisted with the URL.
    // @see #33
    expect(persisted?.toObject().sourceTitles).toEqual([
      { url: 'https://a.example.com', title: 'A page' },
      { url: 'https://b.example.com', title: 'B page' },
      { url: 'https://c.example.com', title: 'C page' },
    ]);
    // Titles ride the final done event so the client has them mid-stream.
    const done = events.find((e) => e.event === 'done');
    expect(done?.data.sourceTitles).toHaveLength(3);
    // Reconciled summaries persist: calls merge with results, none 'call'.
    // @see #196
    const tools = persisted?.toObject().tools;
    expect(tools).toEqual([
      {
        phase: 'result',
        name: 'web_search',
        label: 'Searched the web',
        query: 'groq pricing',
        status: 'ok',
        resultCount: 2,
        domains: expect.arrayContaining(['a.example.com', 'b.example.com']),
      },
      expect.objectContaining({ phase: 'result', name: 'web_search' }),
    ]);
    expect(tools?.some((t) => t.phase === 'call')).toBe(false);
  });

  it('emits structured tool events when the agent calls fetch_url and persists the fetched page (#113)', async () => {
    const cookies = await registerUser('stream-fetch-url@example.com');
    // `fetch_url` mirrors web_search's shape for provenance extraction.
    // @see #113
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

  // A tool use between text runs separates them; live view and refresh agree.
  // @see #262
  it('separates text runs with a paragraph break when a tool use falls between them (#262)', async () => {
    const cookies = await registerUser('stream-paragraph-break@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'Let me look that up.' } };
        yield {
          type: 'tool-call',
          payload: { toolName: 'web_search', args: { query: 'groq pricing' } },
        };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'web_search',
            result: { results: [{ title: 'A page', snippet: 'a', url: 'https://a.example.com' }] },
          },
        };
        yield { type: 'text-delta', payload: { text: 'Here is the answer.' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'what happened today' });

    expect(response.status).toBe(200);
    // The break rides the delta stream too, so the live view matches.
    // @see #262
    expect(response.text).toContain('"content":"\\n\\nHere is the answer."');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.content).toBe('Let me look that up.\n\nHere is the answer.');
  });

  // No leading break on search-first; a lone-newline tail is topped up.
  // @see #262
  it('paragraph break boundary cases (#262): no leading break, lone-newline tail topped up', () => {
    expect(paragraphBreakFor('')).toBe('\n\n');
    expect(paragraphBreakFor('answer')).toBe('\n\n');
    expect(paragraphBreakFor('answer\n')).toBe('\n');
    expect(paragraphBreakFor('answer\n\n')).toBe('');
    expect(paragraphBreakFor('answer\n\n\n')).toBe('');
  });

  it('a tool that ends the turn leaves no trailing paragraph break (#262)', async () => {
    const cookies = await registerUser('stream-tool-ending@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'Searching now.' } };
        yield { type: 'tool-call', payload: { toolName: 'web_search', args: { query: 'x' } } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'web_search', result: { results: [] } },
        };
      })(),
    }));

    const app = createApp();
    await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'look this up' });

    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.content).toBe('Searching now.');
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
    // The persisted array mirrors the reconciled events, all resolved results.
    // @see #196
    const persisted = await Message.findOne({ role: 'assistant' });
    const tools = persisted?.toObject().tools;
    expect(tools).toEqual([
      expect.objectContaining({ phase: 'result', name: 'list_files', resultCount: 2 }),
      expect.objectContaining({ phase: 'result', name: 'list_repositories', resultCount: 4 }),
      expect.objectContaining({ phase: 'result', name: 'read_file' }),
    ]);
    expect(tools?.[2].resultCount).toBeUndefined();
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

  it('emits a confirmation delta and persists it when a tool ran with no assistant text (#195)', async () => {
    const cookies = await registerUser('stream-confirm-tool-only@example.com');
    // The run ends on a tool call: call/result but no text-delta.
    // @see #195
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'generate_file', args: {} } };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'generate_file',
            result: { file: { filename: 'agi-final.md' } },
          },
        };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'write the document' });

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
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.map((e) => e.data.content)).toEqual(['Created agi-final.md.']);
    const done = events.find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({
      complete: true,
      message: { content: 'Created agi-final.md.' },
    });
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.content).toBe('Created agi-final.md.');
  });

  it('leaves deltas as exactly the model text when a tool also ran (#195)', async () => {
    const cookies = await registerUser('stream-confirm-real-text@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'web_search', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'web_search', result: { results: [] } },
        };
        yield { type: 'text-delta', payload: { text: 'Here is the answer.' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'look it up' });

    expect(response.status).toBe(200);
    const deltas = response.text
      .split('\n\n')
      .filter((part) => part.includes('event: delta'))
      .map((part) =>
        JSON.parse(
          part
            .split('\n')
            .find((l) => l.startsWith('data: '))!
            .slice(6),
        ),
      );
    expect(deltas.map((d) => d.content).join('')).toBe('Here is the answer.');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.content).toBe('Here is the answer.');
  });

  it('labels generate_file and reports its filename on the result event (#195)', async () => {
    const cookies = await registerUser('stream-generate-file-label@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'generate_file', args: {} } };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'generate_file',
            result: { file: { filename: 'agi-final.md' } },
          },
        };
        yield { type: 'text-delta', payload: { text: 'Done.' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'write it' });

    expect(response.status).toBe(200);
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
      );
    expect(toolEvents[0]).toMatchObject({
      phase: 'call',
      name: 'generate_file',
      label: 'Created a file',
    });
    expect(toolEvents[1]).toEqual(
      expect.objectContaining({
        phase: 'result',
        name: 'generate_file',
        status: 'ok',
        filename: 'agi-final.md',
      }),
    );
  });

  it('reports an empty status when generate_file returned an error (#195)', async () => {
    const cookies = await registerUser('stream-generate-file-error@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'generate_file', args: {} } };
        yield {
          type: 'tool-result',
          payload: { toolName: 'generate_file', result: { error: 'disk full' } },
        };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'write it' });

    expect(response.status).toBe(200);
    const resultEvent = response.text
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
    expect(resultEvent).toMatchObject({ name: 'generate_file', status: 'empty' });
    expect(resultEvent.filename).toBeUndefined();
  });

  it('labels edit_file and reports its filename on the result event (#325)', async () => {
    const cookies = await registerUser('stream-edit-file-label@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'tool-call', payload: { toolName: 'edit_file', args: {} } };
        yield {
          type: 'tool-result',
          payload: {
            toolName: 'edit_file',
            result: { file: { filename: 'agi-final.md', version: 2 } },
          },
        };
        yield { type: 'text-delta', payload: { text: 'Done.' } };
      })(),
    }));

    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'update it' });

    expect(response.status).toBe(200);
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
      );
    expect(toolEvents[0]).toMatchObject({
      phase: 'call',
      name: 'edit_file',
      label: 'Updated a file',
    });
    expect(toolEvents[1]).toEqual(
      expect.objectContaining({
        phase: 'result',
        name: 'edit_file',
        status: 'ok',
        filename: 'agi-final.md',
      }),
    );
  });

  it('delivers follow-up suggestions on done and persists them on the message', async () => {
    const cookies = await registerUser('stream-suggestions@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['A thoughtful answer.']),
    }));
    // The follow-up call is identified by its `instructions` override.
    // @see #198
    mockGenerate.mockImplementation(
      async (
        messages?: { role: string; content: string }[],
        options?: { instructions?: string },
      ) => {
        if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
        if (String(options?.instructions ?? '').startsWith('Generate 2-3')) {
          return {
            object: { suggestions: ['What about pricing?', 'Show an example'] },
          };
        }
        return { text: 'plain' };
      },
    );

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

  describe('honesty guard (#371, #381)', () => {
    // The guard audits one user message embedding the assistant reply.
    const mockGuard = (
      flaggedWhen: (reply: string) => boolean,
      reason = 'fabricated tool claim',
    ) => {
      mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
        if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
        if (isHonestyGuardCall({ messages })) {
          const reply = messages?.[0]?.content.split('Assistant reply:\n')[1] ?? '';
          return {
            text: `{"claimsToolUse": ${flaggedWhen(reply)}, "reason": "${reason}"}`,
            object: { claimsToolUse: flaggedWhen(reply), reason },
            finishReason: 'stop',
          };
        }
        return { text: '[]' };
      });
    };

    const frameOf = (responseText: string, event: string): Record<string, unknown> => {
      const frame = responseText.split('\n\n').find((part) => part.includes(`event: ${event}`))!;
      return JSON.parse(
        frame
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
      );
    };

    it('auto-retries a flagged attempt and persists only the clean restart (#381)', async () => {
      let call = 0;
      mockAgentStream.mockImplementation(async () => {
        call += 1;
        return {
          fullStream: fullStreamFrom([
            call === 1 ? 'Read it — 87 lines, all of it.' : 'I cannot read files on my own.',
          ]),
        };
      });
      mockGuard((reply) => reply.includes('87 lines'), 'claims a file read with no tools executed');

      const cookies = await registerUser('stream-honesty-retry@example.com');
      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'read the file' });

      expect(response.status).toBe(200);
      const frames = response.text.split('\n\n');
      const retryIdx = frames.findIndex((part) => part.includes('event: honesty'));
      const doneIdx = frames.findIndex((part) => part.includes('event: done'));
      expect(retryIdx).toBeGreaterThan(-1);
      expect(doneIdx).toBeGreaterThan(retryIdx);
      const retryFrame = frameOf(response.text, 'honesty');
      expect(retryFrame).toEqual({
        flagged: true,
        reason: 'claims a file read with no tools executed',
        retrying: true,
      });
      // The settled turn is the restart, not the discarded attempt.
      expect(frameOf(response.text, 'done')).toMatchObject({
        complete: true,
        message: { content: 'I cannot read files on my own.' },
      });
      // Exactly one assistant message persists with the clean verdict.
      const persisted = await Message.find({ role: 'assistant' });
      expect(persisted).toHaveLength(1);
      expect(persisted[0].content).toBe('I cannot read files on my own.');
      expect(persisted[0].honesty?.flagged).toBe(false);
      // The restart's prompt carries the retry note, not the discarded reply.
      expect(mockAgentStream).toHaveBeenCalledTimes(2);
      const retryCall = mockAgentStream.mock.calls[1] as unknown as [
        { role: string; content: string }[],
      ];
      const retryUserTurn = retryCall[0].filter((m) => m.role === 'user').at(-1);
      expect(retryUserTurn?.content).toContain('discarded before the user saw');
      expect(retryUserTurn?.content).not.toContain('87 lines');
    });

    it('falls back to the post-done flag when the retry is flagged too (#371)', async () => {
      mockStream(['Read it — 87 lines, all of it.']);
      mockGuard(() => true, 'claims a file read with no tools executed');

      const cookies = await registerUser('stream-honesty-exhausted@example.com');
      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'read the file' });

      expect(response.status).toBe(200);
      const frames = response.text.split('\n\n');
      const retryIdx = frames.findIndex((part) => part.includes('event: honesty'));
      const doneIdx = frames.findIndex((part) => part.includes('event: done'));
      expect(retryIdx).toBeGreaterThan(-1);
      expect(retryIdx).toBeLessThan(doneIdx);
      // Post-done frame has no retry marker — the badge path took over.
      const lastHonesty = frames
        .map((part) => (part.includes('event: honesty') ? part : ''))
        .filter(Boolean)
        .at(-1)!;
      expect(
        JSON.parse(
          lastHonesty
            .split('\n')
            .find((l) => l.startsWith('data: '))!
            .slice(6),
        ),
      ).toEqual({
        flagged: true,
        reason: 'claims a file read with no tools executed',
      });
      const persisted = await Message.findOne({ role: 'assistant' });
      expect(persisted?.honesty?.flagged).toBe(true);
    });

    it('skips the honesty guard entirely when tools executed', async () => {
      mockAgentStream.mockImplementation(async () => ({
        fullStream: (async function* () {
          yield { type: 'tool-call', payload: { toolName: 'read_file', args: {} } };
          yield {
            type: 'tool-result',
            payload: { toolName: 'read_file', result: { file: { content: 'hi' } } },
          };
          yield { type: 'text-delta', payload: { text: 'Read the file.' } };
        })(),
      }));
      mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
        if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
        if (isHonestyGuardCall({ messages })) {
          throw new Error('honesty guard must not run on a tool turn');
        }
        return { text: '[]' };
      });

      const cookies = await registerUser('stream-honesty-tool@example.com');
      const app = createApp();
      const response = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'read the file' });

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('event: honesty');
      const persisted = await Message.findOne({ role: 'assistant' });
      expect(persisted?.honesty).toBeUndefined();
    });

    it('injects the corrective note into the next turn when the previous assistant message is flagged', async () => {
      mockAgentStream.mockImplementation(async () => ({
        fullStream: fullStreamFrom(['Read it: 87 lines.']),
      }));
      mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
        if (isClassifierCall({ messages })) return structured(CLASSIFIER_REPLY);
        if (isHonestyGuardCall({ messages })) {
          return {
            text: '{"claimsToolUse": true, "reason": "fabricated read"}',
            object: { claimsToolUse: true, reason: 'fabricated read' },
            finishReason: 'stop',
          };
        }
        return { text: '[]' };
      });
      const cookies = await registerUser('stream-honesty-note@example.com');
      const app = createApp();
      const first = await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'read the file' });
      const sessionId = JSON.parse(
        first.text
          .split('\n\n')
          .find((part) => part.includes('event: meta'))!
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
      ).sessionId as string;

      // The guard resolves before the stream closes; the flag is persisted.
      const flagged = await Message.findOne({ role: 'assistant', 'honesty.flagged': true }).lean();
      expect(flagged).not.toBeNull();

      await request(app)
        .post('/api/chat/stream')
        .set('Cookie', cookies)
        .send({ content: 'can you read that file', sessionId });

      const secondTurnCall = mockAgentStream.mock.calls[
        mockAgentStream.mock.calls.length - 1
      ] as unknown as [{ role: string; content: string }[]];
      const userTurn = secondTurnCall[0].filter((m) => m.role === 'user').at(-1);
      expect(userTurn?.content).toContain('never executed');
    });
  });

  describe('per-user system prompt (issue #35)', () => {
    // Leading system message(s) fold into the `instructions` override.
    // @see #198
    const streamSystemContent = (): string => {
      const call = mockAgentStream.mock.calls[mockAgentStream.mock.calls.length - 1] as unknown as [
        unknown,
        { instructions?: string } | undefined,
      ];
      const instructions = call[1]?.instructions;
      if (typeof instructions !== 'string') {
        throw new Error('no system message found in stream call');
      }
      const [, ...callerParts] = instructions.split('\n\n');
      return callerParts.join('\n\n');
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

// The mocked Agent bypasses Mastra's parsing; aux mocks carry the object.
// @see #368
const structured = (text: string) => ({ text, object: JSON.parse(text) });

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

describe('Chat streaming prompt metrics', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockAgentStream.mockReset();
    mockRacingState.routing = MOCK_ROUTING;
    mockRacingState.error = undefined;
  });

  it('attaches metrics to streamed turns and classifies the user message', async () => {
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['Hi.']),
    }));
    mockGenerate.mockImplementation(async (messages?: { role: string; content: string }[]) => {
      if (isClassifierCall({ messages })) {
        return structured(CLASSIFIER_REPLY);
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

    // Re-fetch after the flush to avoid stale pre-classification documents.
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
    // Any classifier call would fail the mock; the skip must avoid it.
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
    // Deterministic metrics are still attached to the trivial skip.
    expect(userMessage?.metrics?.sessionMessageIndex).toBe(0);
  });
});

/* Streaming failover: endpoint failures re-route; rate limits fail loudly. */
// @see #168
describe('Chat streaming route — #168 endpoint failures', () => {
  const errorStreamFrom = (message: string) =>
    mockAgentStream.mockImplementation(async () => ({
      fullStream: (async function* () {
        yield { type: 'error', payload: { error: { message } } };
      })(),
    }));

  beforeEach(() => {
    mockAgentStream.mockReset();
    mockGenerate.mockReset().mockResolvedValue({ text: 'plain' });
    mockRacingState.routing = MOCK_ROUTING;
    mockRacingState.error = undefined;
  });

  it('a rate-limit stream failure surfaces the retry hint', async () => {
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
  });

  it('a generic stream failure surfaces the generic error message', async () => {
    errorStreamFrom('upstream exploded');

    const cookies = await registerUser('stream-generic-fail@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const errorEvent = response.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Error streaming from model');
  });

  it('surfaces a total race failure as an SSE error event (#387)', async () => {
    // Every backend failing surfaces the error on the opened stream.
    // @see #387
    mockRacingState.error = new Error('All chat backends failed');

    const cookies = await registerUser('stream-pool-empty@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(200);
    const errorEvent = response.text.split('\n\n').find((part) => part.includes('event: error'));
    expect(errorEvent).toContain('Error streaming from model');
  });
});

describe('reconcileToolEvent (#196)', () => {
  const call = (name: string, query?: string): PersistedToolEvent => ({
    phase: 'call',
    name,
    label: name,
    ...(query ? { query } : {}),
  });
  const result = (name: string): PersistedToolEvent => ({
    phase: 'result',
    name,
    label: name,
    status: 'ok',
    resultCount: 1,
  });

  it('merges a result into the most recent open call of the same name', () => {
    const list = [call('web_search', 'groq pricing')];
    reconcileToolEvent(list, result('web_search'));
    expect(list).toEqual([
      {
        phase: 'result',
        name: 'web_search',
        label: 'web_search',
        status: 'ok',
        resultCount: 1,
        query: 'groq pricing',
      },
    ]);
  });

  it('appends a result with no matching open call', () => {
    const list: PersistedToolEvent[] = [];
    reconcileToolEvent(list, result('web_search'));
    expect(list).toEqual([
      { phase: 'result', name: 'web_search', label: 'web_search', status: 'ok', resultCount: 1 },
    ]);
  });

  it('appends a second result of the same name as a standalone entry', () => {
    const list = [call('web_search')];
    reconcileToolEvent(list, result('web_search'));
    reconcileToolEvent(list, result('web_search'));
    expect(list).toHaveLength(2);
    expect(list.every((e) => e.phase === 'result')).toBe(true);
  });
});

describe('history window + tool provenance (#360)', () => {
  const doc = (content: string) => ({ content });

  describe('windowedHistory', () => {
    it('keeps everything under both caps', () => {
      const docs = [doc('a'), doc('b'), doc('c')];
      expect(windowedHistory(docs)).toEqual(docs);
    });

    it('drops oldest-first beyond the char budget (docs arrive newest-first)', () => {
      const half = doc('x'.repeat(HISTORY_MAX_CHARS / 2));
      const docs = [half, { content: 'y'.repeat(HISTORY_MAX_CHARS / 2) }, doc('z')];
      const kept = windowedHistory(docs);
      expect(kept).toEqual([docs[0], docs[1]]);
    });

    it('caps the message count', () => {
      const docs = Array.from({ length: HISTORY_MAX_MESSAGES + 10 }, (_, i) => doc(`m${i}`));
      expect(windowedHistory(docs)).toHaveLength(HISTORY_MAX_MESSAGES);
    });

    it('treats missing content as empty, not a stop', () => {
      const docs = [{ content: null }, doc('kept')];
      expect(windowedHistory(docs as { content?: string | null }[])).toHaveLength(2);
    });

    // The current turn must never vanish: it alone may bust the budget.
    // @see #391
    it('always retains the newest turn, truncated when it alone busts the budget', () => {
      const huge = doc('x'.repeat(HISTORY_MAX_CHARS + 10));
      const kept = windowedHistory([huge, doc('older')]);
      expect(kept).toHaveLength(1);
      expect((kept[0] as { content: string }).content).toHaveLength(HISTORY_MAX_CHARS);
    });
  });

  describe('toolProvenanceLine', () => {
    it('empty for turns without reconciled tool results', () => {
      expect(toolProvenanceLine(undefined)).toBe('');
      expect(toolProvenanceLine([])).toBe('');
      expect(toolProvenanceLine([{ phase: 'call', name: 'list_files' }])).toBe('');
    });

    it('renders names with repeat counts', () => {
      const line = toolProvenanceLine([
        { phase: 'result', name: 'list_files' },
        { phase: 'result', name: 'read_file' },
        { phase: 'result', name: 'read_file' },
      ]);
      expect(line).toBe('\n\n[tools used: list_files, read_file ×2]');
    });

    it('ignores malformed entries rather than failing the turn', () => {
      expect(toolProvenanceLine([{ phase: 'result' }, null as never])).toBe('');
    });
  });

  describe('stripProvenanceLines (#360 imitation guard)', () => {
    it('removes a marker line wherever it appears, leaving the rest intact', () => {
      expect(stripProvenanceLines('Done.\n\n[tools used: list_files]')).toBe('Done.');
      expect(stripProvenanceLines('first\n[tools used: read_file ×2]\nsecond')).toBe(
        'first\nsecond',
      );
    });

    it('tolerates indentation around an imitated marker', () => {
      expect(stripProvenanceLines('  [tools used: web_search]  ')).toBe('');
    });

    it('keeps bracketed prose that is not a provenance line', () => {
      const text = 'See [tools used: list_files] below\nand [1] references.';
      expect(stripProvenanceLines(text)).toBe(text);
    });
  });

  describe('messagesFromPersistedHistory', () => {
    it('appends the provenance line to assistant turns with tool chips', () => {
      const out = messagesFromPersistedHistory(
        [
          {
            role: 'assistant',
            content: 'Here is what you have.',
            tools: [{ phase: 'result', name: 'list_files' }],
          },
          { role: 'user', content: 'thanks' },
        ],
        null,
      );
      expect(out[1].content).toBe('Here is what you have.\n\n[tools used: list_files]');
      expect(out[0].content).toBe('thanks');
    });

    it('appends the honesty corrective note to the current user turn when the newest assistant message is flagged (#371)', () => {
      const out = messagesFromPersistedHistory(
        [
          { role: 'user', content: 'and now?' },
          {
            role: 'assistant',
            content: 'Read it — 87 lines.',
            honesty: { flagged: true },
          },
          { role: 'user', content: 'can you read that file' },
        ],
        null,
      );
      expect(out[0].content).toBe('can you read that file');
      expect(out[1].content).toBe('Read it — 87 lines.');
      expect(out[2].content).toContain('never executed');
      expect(String(out[2].content).startsWith('and now?')).toBe(true);
    });

    it('ignores an unflagged newest assistant message and older flags', () => {
      const out = messagesFromPersistedHistory(
        [
          { role: 'user', content: 'e' },
          { role: 'assistant', content: 'd', honesty: { flagged: false } },
          { role: 'user', content: 'c' },
          { role: 'assistant', content: 'b', honesty: { flagged: true } },
          { role: 'user', content: 'a' },
        ],
        null,
      );
      expect(out.every((m) => !String(m.content).includes('never executed'))).toBe(true);
    });
  });
});
