import request from 'supertest';
import { createApp } from '../index';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { paragraphBreakFor, reconcileToolEvent, type PersistedToolEvent } from './chat';

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
  reason: 'roster-pick',
};

// #233: routing runs through the fixed-roster racing path. Drive it with
// `mockRacingState`; the mock delegates the provider call back through the real
// `inferenceService` so the mocked Mastra Agent stream stays observable.
const mockRacingState: {
  routing: typeof MOCK_ROUTING | null;
  error?: unknown;
} = { routing: MOCK_ROUTING };

jest.mock('../services/racingService', () => {
  const { inferenceService } = jest.requireActual('../services/inferenceService');
  const failIfSet = () => {
    if (mockRacingState.error) throw mockRacingState.error;
  };
  return {
    pickRosterRoute: async () => {
      failIfSet();
      return mockRacingState.routing;
    },
    routeAndComplete: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const completion = await inferenceService.createCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, outcome: { result: { completion } } };
    },
    routeAndStream: async (opts: Record<string, unknown>) => {
      failIfSet();
      const routing = mockRacingState.routing;
      const stream = await inferenceService.createStreamingCompletion({
        ...opts,
        model: routing?.model,
        provider: routing?.provider,
      });
      return { routing, outcome: { result: { stream } } };
    },
  };
});

jest.mock('../services/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

// #238: the enrichment pass is a separate aux call; the route tests pin the
// main completion's arguments, so stub enrichment to a no-op block.
jest.mock('../services/enrichmentService', () => ({
  enrichmentVotes: jest.fn().mockResolvedValue({ files: false, workspace: false }),
  libraryIndexFor: jest.fn().mockResolvedValue(''),
  isEnrichmentEnabled: () => false,
}));

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

  // #261: persisted turns carry a `[timestamp]` header in the prompt so the
  // model can see when each turn happened and how long passed between them;
  // the redundant system-prompt date line is dropped on this path.
  it('stamps every persisted turn and drops the date line in the prompt (#261)', async () => {
    const cookies = await registerUser('stream-timestamps@example.com');
    await mockStream(['ok']);

    const userId = (await User.findOne({ email: 'stream-timestamps@example.com' }))!._id;
    const session = await Session.create({ userId, title: 'timestamps' });
    // Seeds are relative to now so the asserted relative gap ("2 days") does
    // not rot as the wall clock advances (#261 follow-up; the current turn is
    // stamped Date.now() by the route).
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
    // Seeded turns carry absolute stamps; the assistant reply 1 minute later
    // gets no relative line (sub-hour). The new turn rides the live clock, so
    // its absolute stamp is the current UTC minute and its gap to the seeded
    // turn is whatever unit that (ever-growing) gap rounds to. Assert the
    // shape, not a fixed value: the previous assertion hard-coded "2 days"
    // from the seeded date and rotted as wall time moved past it.
    const stamp = (d: Date) =>
      `[${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC]`;
    const userTurns = turns.filter((m) => m.role === 'user');
    expect(userTurns[0].content).toBe(`${stamp(firstTurnAt)}\nfirst turn`);
    const assistantTurn = turns.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toBe(`${stamp(firstReplyAt)}\nfirst reply`);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const currentStamp = `${now.toISOString().slice(0, 10)} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
    expect(userTurns[1].content).toMatch(
      new RegExp(
        `^\\[${currentStamp} UTC — \\d+ (hour|day|week|month|year)s? since the last message\\]\\nsecond turn$`,
      ),
    );
  });

  // #253: the workspace-memory block is injected only when the gate's
  // `workspace` vote fires and the feature flag is on; the route wires the
  // retrieved block into the system content on the persisted path.
  it('injects the workspace-memory block when the vote fires and the flag is on (#253)', async () => {
    const cookies = await registerUser('stream-workspace@example.com');
    await mockStream(['ok']);

    const { enrichmentVotes } = jest.requireMock('../services/enrichmentService') as {
      enrichmentVotes: jest.Mock;
    };
    enrichmentVotes.mockResolvedValueOnce({ files: false, workspace: true });
    const retrieve = jest
      .spyOn(
        jest.requireActual<typeof import('../services/workspaceRetrievalService')>(
          '../services/workspaceRetrievalService',
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
        { instructions: string },
      ];
      expect(options.instructions).toContain('<user:workspace>');
      expect(options.instructions).toContain('budget is twelve thousand');
    } finally {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
      retrieve.mockRestore();
    }
  });

  // #261: ZDR/incognito turns are untimestamped (the replay carries no clock),
  // so they keep the date line as their only clock.
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

  // #261 D6: the model communicates with the user, so with a stored zone the
  // prompt carries the user's local times — stamps, the zone context line, and
  // (on ZDR) the date line all render in it. Storage stays UTC throughout.
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
    // The stored UTC instant renders as the user's wall clock (BST = GMT+1),
    // and the context line names the IANA zone so the label is unambiguous.
    expect(turns.find((m) => m.role === 'user')?.content).toBe(
      '[2026-10-08 15:32 GMT+1]\nfirst turn',
    );
    expect(options.instructions).toMatch(
      /The user's timezone is Europe\/London \(currently GMT(?:[+-]\d+(?::\d+)?)?\)\./,
    );
    // The persisted path still drops the redundant date line (#261 D3).
    expect(options.instructions).not.toContain("Today's date is");
    // Storage is untouched: the persisted message keeps its raw content.
    const stored = await Message.findOne({ sessionId: session._id, role: 'user' });
    expect(stored?.content).toBe('first turn');
    expect(new Date(stored?.timestamp as Date).toISOString()).toBe('2026-10-08T14:32:00.000Z');
  });

  it('persists the turn token usage on the assistant message (#224)', async () => {
    const cookies = await registerUser('stream-usage@example.com');
    // The connector surfaces usage as a single trailing chunk (#224): the
    // agent result exposes `totalUsage`, which mastraService maps after the
    // real stream chunks.
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
    // #196: reconciled tool summaries are persisted on the assistant message.
    // The first call merges with the first result (query carried forward); the
    // second result has no open call left, so it stays a standalone result.
    // No entry remains phase 'call' (the stuck-throbber defect).
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

  // #262: a tool use between two text runs separates them as paragraphs. The
  // separator is persisted in the stored content (and rides the delta stream),
  // so the live view and a refresh agree.
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
    expect(response.text).toContain('"content":"\\n\\nHere is the answer."');
    const persisted = await Message.findOne({ role: 'assistant' });
    expect(persisted?.content).toBe('Let me look that up.\n\nHere is the answer.');
  });

  // A search-first turn (tool before any text) must not gain a leading break,
  // and a lone-newline tail is topped up to a single blank line, not stacked.
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
    // #196: the persisted array mirrors the reconciled events — every entry is
    // a resolved result (call+result pairs merged), and the count-less
    // read_file entry keeps no resultCount.
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
    // The Mastra-documented silent turn: the run ends on a tool call, so the
    // stream carries the generate_file call/result but no text-delta.
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

  it('delivers follow-up suggestions on done and persists them on the message', async () => {
    const cookies = await registerUser('stream-suggestions@example.com');
    mockAgentStream.mockImplementation(async () => ({
      fullStream: fullStreamFrom(['A thoughtful answer.']),
    }));
    // The follow-up generator is the next plain completion call (the chat
    // itself streams); classification also rides mockGenerate, so gate it.
    // #198: the tool-free connector folds the suggestion system prompt into
    // the per-call `instructions` override, so the follow-up call is
    // identified by its instructions rather than a leading system message.
    mockGenerate.mockImplementation(
      async (
        messages?: { role: string; content: string }[],
        options?: { instructions?: string },
      ) => {
        if (isClassifierCall({ messages })) return { text: CLASSIFIER_REPLY };
        if (String(options?.instructions ?? '').startsWith('Generate 2-3')) {
          return { text: '["What about pricing?","Show an example"]' };
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

  describe('per-user system prompt (issue #35)', () => {
    // #198: the connector strips the caller's leading system message(s) out of
    // the messages array and folds them into the per-call `instructions`
    // override, merged with the agent's tool instructions (which lead the
    // merged string, separated by exactly one blank line). Dropping only that
    // first separator leaves the caller's own system content — which may itself
    // contain blank lines — intact.
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

  it('returns 503 with the all-disabled message when the roster is empty before the stream opens (#168)', async () => {
    // No pickable roster model at turn start: the route surfaces the
    // all-disabled error pre-SSE — the user must see the friendly message,
    // not a generic client failure.
    mockRacingState.routing = null;

    const cookies = await registerUser('stream-pool-empty@example.com');
    const app = createApp();
    const response = await request(app)
      .post('/api/chat/stream')
      .set('Cookie', cookies)
      .send({ content: 'hello there' });

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/temporarily unavailable/);
    expect(response.body.detail).toMatch(/temporarily unavailable/);
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
