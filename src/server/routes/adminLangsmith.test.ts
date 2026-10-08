import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { TraceStatsCache } from '../models/TraceStatsCache';
import { ModelRoster } from '../models/ModelRoster';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { listTraces, RETRY_WAIT_MS } from '../services/langsmithTracesService';

/*
 * #186 route coverage: admin-guard wiring (cookie + PAT bearer), the
 * unconfigured 503, upstream 502s, and the fetch-level happy paths for
 * list / detail / stats against mocked LangSmith responses (the raw-REST
 * service is exercised through the routes, same approach as
 * tracePurge.test.ts).
 */

const cookieOf = (res: request.Response) => {
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie : [cookie];
};

const registerAdmin = async (app: ReturnType<typeof createApp>, email: string) => {
  await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  await User.updateOne({ email }, { role: 'admin' });
  const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  return cookieOf(res);
};

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return cookieOf(res);
};

type FetchInit = { body?: string };
type FetchMock = (url: string, init?: FetchInit) => Promise<Response>;

const mockFetch = (impl: FetchMock) =>
  jest.spyOn(global, 'fetch').mockImplementation(impl as never);

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sessionsOk: FetchMock = (url: string) =>
  typeof url === 'string' && url.includes('/api/v1/sessions')
    ? Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]))
    : Promise.reject(new Error(`unexpected url: ${String(url)}`));

const rootRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  trace_id: 'trace-1',
  name: "agent run: 'tova-groq'",
  run_type: 'chain',
  status: 'success',
  error: null,
  start_time: '2026-09-27T10:00:00.000000',
  end_time: '2026-09-27T10:00:02.000000',
  total_tokens: 0,
  app_path: '/o/org/projects/p/proj-1/r/run-1',
  ...over,
});

const env = {
  langsmiKey: process.env.LANGSMITH_API_KEY,
  langchainKey: process.env.LANGCHAIN_API_KEY,
  langsmiProject: process.env.LANGSMITH_PROJECT,
  langchainProject: process.env.LANGCHAIN_PROJECT,
};

describe('langsmithTracesService rate-limit handling (#186)', () => {
  let fetchSpy: jest.SpyInstance;
  let queryStatuses: number[];

  beforeEach(() => {
    process.env.LANGSMITH_API_KEY = 'ls-key';
    process.env.LANGSMITH_PROJECT = 'tova-dev';
    queryStatuses = [];
    jest.useFakeTimers();
    fetchSpy = mockFetch((url: string) => {
      if (typeof url === 'string' && url.includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      const status =
        queryStatuses.length > 1 ? (queryStatuses.shift() ?? 200) : (queryStatuses[0] ?? 200);
      return Promise.resolve(jsonResponse(status, { runs: [] }));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
    process.env.LANGSMITH_API_KEY = env.langsmiKey;
    process.env.LANGCHAIN_API_KEY = env.langchainKey;
    process.env.LANGSMITH_PROJECT = env.langsmiProject;
    process.env.LANGCHAIN_PROJECT = env.langchainProject;
  });

  it('retries 429s with backoff and succeeds when the API recovers', async () => {
    queryStatuses = [429, 429, 200];

    const result = listTraces();
    await jest.advanceTimersByTimeAsync(1000); // first retry fires
    await jest.advanceTimersByTimeAsync(2000); // second retry fires
    await expect(result).resolves.toEqual({
      project: { id: 'proj-1', name: 'tova-dev' },
      traces: [],
    });
    // 1 sessions call + 1 initial attempt + 2 retries.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('retries a transient 5xx exactly once before giving up on 4xx', async () => {
    queryStatuses = [503, 200];

    const result = listTraces();
    await jest.advanceTimersByTimeAsync(RETRY_WAIT_MS);
    await expect(result).resolves.toEqual({
      project: { id: 'proj-1', name: 'tova-dev' },
      traces: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('gives up after the 429 backoff budget and surfaces the failure', async () => {
    queryStatuses = [429, 429, 429, 429];

    const result = listTraces();
    // Attach the rejection handler up front: the promise rejects while the
    // fake-timer advances are still flushing, and an unhandled rejection at
    // that checkpoint would fail the suite before the assertion below.
    const expectation = expect(result).rejects.toThrow('HTTP 429');
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);
    await expectation;
    // 1 sessions call + 1 initial attempt + 3 retries.
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

describe('admin langsmith (#186)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LANGSMITH_API_KEY = 'ls-key';
    process.env.LANGSMITH_PROJECT = 'tova-dev';
    fetchSpy = mockFetch(sessionsOk);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.LANGSMITH_API_KEY = env.langsmiKey;
    process.env.LANGCHAIN_API_KEY = env.langchainKey;
    process.env.LANGSMITH_PROJECT = env.langsmiProject;
    process.env.LANGCHAIN_PROJECT = env.langchainProject;
  });

  it('guards the endpoints like the rest of admin', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'plain-ls@example.com');

    const unauth = await request(app).get('/api/admin/langsmith/traces');
    expect(unauth.status).toBe(401);

    const forbidden = await request(app).get('/api/admin/langsmith/traces').set('Cookie', cookie);
    expect(forbidden.status).toBe(403);

    const badBearer = await request(app)
      .get('/api/admin/langsmith/traces')
      .set('Authorization', 'Bearer nope');
    expect(badBearer.status).toBe(401);
  });

  it('answers 503 when tracing is not configured (dev/stub parity)', async () => {
    process.env.LANGSMITH_API_KEY = '';
    process.env.LANGCHAIN_API_KEY = '';
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-unconfigured@example.com');

    for (const path of ['/langsmith/traces', '/langsmith/traces/abc-1', '/langsmith/stats']) {
      const res = await request(app).get(`/api/admin${path}`).set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.body.message).toBe('LangSmith tracing is not configured');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists recent traces with model and summed llm tokens joined from child runs', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-lister@example.com');

    fetchSpy.mockImplementation((url: string, init?: FetchInit) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      const body = JSON.parse(init?.body ?? '{}');
      if (body.filter === 'eq(is_root, true)') {
        return Promise.resolve(
          jsonResponse(200, {
            runs: [
              rootRun(),
              rootRun({
                id: 'run-2',
                trace_id: 'trace-2',
                name: "agent run: 'tova-deepinfra'",
                status: 'error',
                error: 'model exploded',
                app_path: null,
              }),
            ],
          }),
        );
      }
      // The llm-children join for both traces.
      expect(String(body.filter)).toContain('in(trace_id, ["trace-1", "trace-2"])');
      expect(String(body.filter)).toContain('eq(run_type, "llm")');
      return Promise.resolve(
        jsonResponse(200, {
          runs: [
            { trace_id: 'trace-1', name: "llm: 'openai/gpt-oss-20b'", total_tokens: 120 },
            { trace_id: 'trace-1', name: "llm: 'openai/gpt-oss-20b'", total_tokens: 30 },
            { trace_id: 'trace-2', name: "llm: 'qwen/qwen3-14b'", total_tokens: 5 },
          ],
        }),
      );
    });

    const res = await request(app).get('/api/admin/langsmith/traces').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ id: 'proj-1', name: 'tova-dev' });
    expect(res.body.traces).toHaveLength(2);

    const [ok, failed] = res.body.traces;
    expect(ok).toMatchObject({
      id: 'run-1',
      traceId: 'trace-1',
      status: 'success',
      model: 'openai/gpt-oss-20b',
      durationMs: 2000,
      totalTokens: 150,
      error: null,
      appPath: '/o/org/projects/p/proj-1/r/run-1',
    });
    expect(failed).toMatchObject({
      id: 'run-2',
      status: 'error',
      model: 'qwen/qwen3-14b',
      totalTokens: 5,
      error: 'model exploded',
    });
    expect(failed.appPath).toBeUndefined();
  });

  it('applies errorsOnly server-side and the model filter post-merge', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-filter@example.com');

    const rootFilters: string[] = [];
    fetchSpy.mockImplementation((url: string, init?: FetchInit) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      const body = JSON.parse(init?.body ?? '{}');
      if (String(body.filter).includes('is_root')) {
        rootFilters.push(body.filter);
        return Promise.resolve(jsonResponse(200, { runs: [rootRun()] }));
      }
      return Promise.resolve(
        jsonResponse(200, {
          runs: [{ trace_id: 'trace-1', name: "llm: 'openai/gpt-oss-20b'", total_tokens: 1 }],
        }),
      );
    });

    const errorsOnly = await request(app)
      .get('/api/admin/langsmith/traces?errorsOnly=true&model=openai/gpt-oss-20b')
      .set('Cookie', cookie);
    expect(errorsOnly.status).toBe(200);

    expect(rootFilters).toEqual(['and(eq(is_root, true), eq(status, "error"))']);
    // The model filter cannot push into the root query (model lives on the
    // child run name); rows are filtered after the join, so the single
    // matching root survives it.
    expect(errorsOnly.body.traces).toHaveLength(1);
    expect(errorsOnly.body.traces[0].model).toBe('openai/gpt-oss-20b');

    const otherModel = await request(app)
      .get('/api/admin/langsmith/traces?model=some/other')
      .set('Cookie', cookie);
    expect(otherModel.body.traces).toHaveLength(0);
  });

  it('returns the run tree oldest-first with chunk runs dropped', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-detail@example.com');

    const runsBodies: object[] = [];
    fetchSpy.mockImplementation((url: string, init?: FetchInit) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      // The API rejects any per-query limit over 100 (live-verified 400) —
      // the service must page, never ask for the whole tree at once.
      const body = JSON.parse(init?.body ?? '{}');
      expect(body.limit).toBeLessThanOrEqual(100);
      runsBodies.push(body);
      return Promise.resolve(
        jsonResponse(200, {
          runs: [
            {
              id: 'chunk-1',
              trace_id: 'trace-1',
              parent_run_id: 'run-1',
              name: "chunk: 'text'",
              run_type: 'chain',
              status: 'success',
              start_time: '2026-09-27T10:00:01.500000',
              end_time: '2026-09-27T10:00:01.500000',
              total_tokens: 0,
              outputs: { text: 'a chunk' },
            },
            {
              id: 'llm-1',
              trace_id: 'trace-1',
              parent_run_id: 'run-1',
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              start_time: '2026-09-27T10:00:00.100000',
              end_time: '2026-09-27T10:00:01.000000',
              total_tokens: 585,
              inputs: { messages: ['redacted here'] },
              outputs: { text: 'hi' },
            },
            rootRun(),
          ],
        }),
      );
    });

    const res = await request(app).get('/api/admin/langsmith/traces/trace-1').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.traceId).toBe('trace-1');

    const names = res.body.runs.map((r: { name: string }) => r.name);
    expect(names).toEqual(["agent run: 'tova-groq'", "llm: 'openai/gpt-oss-20b'"]);
    expect(names.some((n: string) => n.startsWith('chunk:'))).toBe(false);

    const llm = res.body.runs[1];
    expect(llm).toMatchObject({
      id: 'llm-1',
      parentId: 'run-1',
      runType: 'llm',
      model: 'openai/gpt-oss-20b',
      durationMs: 900,
      totalTokens: 585,
      startedAt: '2026-09-27T10:00:00.100000',
      endedAt: '2026-09-27T10:00:01.000000',
    });
    expect(llm.inputs).toEqual({ messages: ['redacted here'] });
    expect(llm.outputs).toEqual({ text: 'hi' });
  });

  it('404s an unknown trace, 400s a malformed id, 502s an upstream refusal', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-errors@example.com');

    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, { runs: [] }));
    });
    const unknown = await request(app)
      .get('/api/admin/langsmith/traces/no-such-trace')
      .set('Cookie', cookie);
    expect(unknown.status).toBe(404);

    // 403 (not 429/5xx) skips the retry, so the route answers immediately.
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(403, { detail: 'no' })));
    const refused = await request(app)
      .get('/api/admin/langsmith/traces/trace-1')
      .set('Cookie', cookie);
    expect(refused.status).toBe(502);

    const malformed = await request(app)
      .get('/api/admin/langsmith/traces/not%20a%20valid%20id')
      .set('Cookie', cookie);
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toBe('Invalid trace id');
  });

  it('aggregates per-model stats from a windowed llm-run sweep', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-stats@example.com');

    const sweepQueries: object[] = [];
    fetchSpy.mockImplementation((url: string, init?: FetchInit) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      const body = JSON.parse(init?.body ?? '{}');
      sweepQueries.push(body);
      return Promise.resolve(
        jsonResponse(200, {
          runs: [
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              start_time: '2026-09-27T10:00:00.000000',
              end_time: '2026-09-27T10:00:02.000000',
              total_tokens: 100,
              prompt_tokens: 70,
              completion_tokens: 30,
            },
            {
              // Defensive: a non-llm-shaped name must not fabricate a row.
              name: "agent run: 'tova-groq'",
              run_type: 'llm',
              status: 'success',
              start_time: '2026-09-27T10:00:00.000000',
              end_time: '2026-09-27T10:00:02.000000',
              total_tokens: 999,
            },
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'error',
              start_time: '2026-09-27T10:00:01.000000',
              end_time: '2026-09-27T10:00:04.000000',
              total_tokens: 10,
              prompt_tokens: 8,
              completion_tokens: 2,
            },
            {
              name: "llm: 'qwen/qwen3-14b'",
              run_type: 'llm',
              status: 'success',
              start_time: '2026-09-27T10:00:00.000000',
              end_time: '2026-09-27T10:00:02.000000',
              total_tokens: 50,
              prompt_tokens: 40,
              completion_tokens: 10,
            },
          ],
        }),
      );
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=7').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // One sweep, windowed by start_time over llm runs only — no children
    // join, no root paging (the request-count lesson from the live smoke).
    expect(sweepQueries).toHaveLength(1);
    expect(sweepQueries[0]).toMatchObject({ limit: 100, offset: 0 });
    const filter = (sweepQueries[0] as { filter: string }).filter;
    expect(filter).toContain('eq(run_type, "llm")');
    expect(filter).toContain('gte(start_time,');
    // #224: the sweep must ask for the input/output split that prices a model.
    expect((sweepQueries[0] as { select: string[] }).select).toEqual(
      expect.arrayContaining(['prompt_tokens', 'completion_tokens']),
    );

    expect(res.body.models).toEqual([
      {
        model: 'openai/gpt-oss-20b',
        calls: 2,
        errors: 1,
        avgDurationMs: 2500,
        totalTokens: 110,
        inputTokens: 78,
        outputTokens: 32,
        estimatedCostUsd: null,
      },
      {
        model: 'qwen/qwen3-14b',
        calls: 1,
        errors: 0,
        avgDurationMs: 2000,
        totalTokens: 50,
        inputTokens: 40,
        outputTokens: 10,
        estimatedCostUsd: null,
      },
    ]);
    expect(res.body.totals).toEqual({
      calls: 3,
      errors: 1,
      totalTokens: 160,
      inputTokens: 118,
      outputTokens: 42,
      estimatedCostUsd: null,
    });
    // Cold cache: this sweep is the live fallback.
    expect(res.body.stale).toBe(true);
  });

  it('treats an absent or non-numeric token split as 0 without disturbing totals (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-split-edge@example.com');

    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(
        jsonResponse(200, {
          runs: [
            // A newer/older run shape with no split at all: total must still
            // count, the split contributes 0 (never NaN/undefined).
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              total_tokens: 500,
            },
            // Defensive: a zeroed-by-select split must not fabricate tokens.
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              total_tokens: 20,
              prompt_tokens: 0,
              completion_tokens: 0,
            },
            // Defensive: a null (not absent) split field must count as 0.
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              total_tokens: 10,
              prompt_tokens: null,
              completion_tokens: null,
            },
          ],
        }),
      );
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=7').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      {
        model: 'openai/gpt-oss-20b',
        calls: 3,
        errors: 0,
        avgDurationMs: null,
        totalTokens: 530,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: null,
      },
    ]);
    expect(res.body.totals).toEqual({
      calls: 3,
      errors: 0,
      totalTokens: 530,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
    });
  });

  it('authorizes over a PAT bearer like the other admin routes (#184)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-bearer@example.com');
    const created = await request(app)
      .post('/api/admin/pats')
      .set('Cookie', cookie)
      .send({ name: 'ls agent' });
    const token: string = created.body.pat.token;

    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, { runs: [] }));
    });

    const res = await request(app)
      .get('/api/admin/langsmith/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      calls: 0,
      errors: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
    });
    expect(res.body.models).toEqual([]);
  });

  it('serves a warm cache without touching LangSmith (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-cache-hit@example.com');
    await TraceStatsCache.create({
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      computedAt: new Date(),
      models: [
        {
          model: 'cached/model',
          calls: 4,
          errors: 0,
          avgDurationMs: 1000,
          totalTokens: 200,
          inputTokens: 150,
          outputTokens: 50,
        },
      ],
      totals: { calls: 4, errors: 0, totalTokens: 200, inputTokens: 150, outputTokens: 50 },
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=7').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(false);
    expect(typeof res.body.computedAt).toBe('string');
    expect(res.body.models[0].model).toBe('cached/model');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prices a cached model from the in-DB price (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-cache-cost@example.com');
    await ModelRoster.create({
      modelId: 'priced/cached',
      label: 'priced/cached',
      eligible: true,
      providers: [
        {
          provider: 'deepinfra',
          modelId: 'priced/cached',
          enabled: true,
          inputPrice: 2,
          outputPrice: 4,
        },
      ],
    });
    await TraceStatsCache.create({
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      computedAt: new Date(),
      models: [
        {
          model: 'priced/cached',
          calls: 1,
          errors: 0,
          avgDurationMs: null,
          totalTokens: 3_000_000,
          inputTokens: 1_000_000,
          outputTokens: 2_000_000,
        },
      ],
      totals: {
        calls: 1,
        errors: 0,
        totalTokens: 3_000_000,
        inputTokens: 1_000_000,
        outputTokens: 2_000_000,
      },
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=7').set('Cookie', cookie);
    expect(res.status).toBe(200);
    // 1M in @ $2 + 2M out @ $4 = $10.
    expect(res.body.models[0].estimatedCostUsd).toBe(10);
    expect(res.body.totals.estimatedCostUsd).toBe(10);
  });

  it('falls back live with stale:true when the cache is stale (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-cache-stale@example.com');
    await TraceStatsCache.create({
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      // Older than the staleness threshold (2 intervals).
      computedAt: new Date(Date.now() - 10 * 60 * 1000),
      models: [],
      totals: { calls: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    });

    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(
        jsonResponse(200, {
          runs: [
            {
              name: "llm: 'openai/gpt-oss-20b'",
              run_type: 'llm',
              status: 'success',
              total_tokens: 100,
              prompt_tokens: 70,
              completion_tokens: 30,
            },
          ],
        }),
      );
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=7').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.models[0].model).toBe('openai/gpt-oss-20b');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('does not use the cache for a non-default window (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-cache-window@example.com');
    await TraceStatsCache.create({
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      computedAt: new Date(),
      models: [
        {
          model: 'cached/model',
          calls: 1,
          errors: 0,
          avgDurationMs: null,
          totalTokens: 1,
          inputTokens: 1,
          outputTokens: 0,
        },
      ],
      totals: { calls: 1, errors: 0, totalTokens: 1, inputTokens: 1, outputTokens: 0 },
    });

    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, { runs: [] }));
    });

    const res = await request(app).get('/api/admin/langsmith/stats?days=30').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.stale).toBe(true);
    expect(res.body.models).toEqual([]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('guards the sessions endpoint like the rest of admin (#224)', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'ls-sessions-plain@example.com');

    expect((await request(app).get('/api/admin/langsmith/sessions')).status).toBe(401);
    expect(
      (await request(app).get('/api/admin/langsmith/sessions').set('Cookie', cookie)).status,
    ).toBe(403);
  });

  it('breaks cost down per session from Mongo messages, without hitting LangSmith (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-sessions@example.com');

    await ModelRoster.create({
      modelId: 'priced/session',
      label: 'priced/session',
      eligible: true,
      providers: [
        {
          provider: 'deepinfra',
          modelId: 'priced/session',
          enabled: true,
          inputPrice: 2,
          outputPrice: 4,
        },
      ],
    });

    const sessionA = await Session.create({ userId: (await User.findOne())._id, title: 'Chat A' });
    const sessionB = await Session.create({ userId: (await User.findOne())._id, title: 'Chat B' });

    await Message.create({
      sessionId: sessionA._id,
      role: 'user',
      content: 'hi',
      timestamp: new Date(),
    });
    // Priced assistant turn: 1M in @ $2 + 2M out @ $4 = $10.
    await Message.create({
      sessionId: sessionA._id,
      role: 'assistant',
      content: 'hello',
      modelName: 'priced/session',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 2_000_000, totalTokens: 3_000_000 },
    });
    // Unpriced assistant turn in session B.
    await Message.create({
      sessionId: sessionB._id,
      role: 'assistant',
      content: 'hey',
      modelName: 'unknown/model',
      timestamp: new Date(),
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    });

    const res = await request(app)
      .get('/api/admin/langsmith/sessions?days=7')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    const a = res.body.sessions.find(
      (s: { sessionId: string }) => s.sessionId === String(sessionA._id),
    );
    expect(a.title).toBe('Chat A');
    expect(a.messagesIn).toBe(1);
    expect(a.messagesOut).toBe(1);
    expect(a.inputTokens).toBe(1_000_000);
    expect(a.outputTokens).toBe(2_000_000);
    expect(a.estimatedCostUsd).toBe(10);

    const b = res.body.sessions.find(
      (s: { sessionId: string }) => s.sessionId === String(sessionB._id),
    );
    expect(b.messagesOut).toBe(1);
    expect(b.estimatedCostUsd).toBeNull();

    expect(res.body.totals.sessions).toBe(2);
    expect(res.body.totals.messagesIn).toBe(1);
    expect(res.body.totals.messagesOut).toBe(2);
    // Only the priced session contributes to the total cost.
    expect(res.body.totals.estimatedCostUsd).toBe(10);
  });

  it('prices each turn by its persisted provider on a dual-priced model (#235)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-sessions-dual@example.com');

    await ModelRoster.create({
      modelId: 'dual/session',
      label: 'dual/session',
      eligible: true,
      providers: [
        {
          provider: 'deepinfra',
          modelId: 'dual/session',
          enabled: true,
          inputPrice: 1,
          outputPrice: 1,
        },
        {
          provider: 'fireworks',
          modelId: 'dual/session',
          enabled: true,
          inputPrice: 10,
          outputPrice: 10,
        },
      ],
    });

    const session = await Session.create({ userId: (await User.findOne())._id, title: 'Dual' });
    // DeepInfra turn: 1M in @ $1 = $1.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'a',
      modelName: 'dual/session',
      provider: 'deepinfra',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    });
    // Fireworks turn on the SAME model: 1M in @ $10 = $10.
    await Message.create({
      sessionId: session._id,
      role: 'assistant',
      content: 'b',
      modelName: 'dual/session',
      provider: 'fireworks',
      timestamp: new Date(),
      usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    });

    const res = await request(app)
      .get('/api/admin/langsmith/sessions?days=7')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);

    const row = res.body.sessions.find(
      (s: { sessionId: string }) => s.sessionId === String(session._id),
    );
    // Provider-accurate: $1 (deepinfra) + $10 (fireworks), not 2 × the same rate.
    expect(row.estimatedCostUsd).toBe(11);
    expect(res.body.totals.estimatedCostUsd).toBe(11);
  });

  it('excludes messages older than the requested window (#224)', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'ls-sessions-window@example.com');

    const session = await Session.create({ userId: (await User.findOne())._id, title: 'Old' });
    await Message.create({
      sessionId: session._id,
      role: 'user',
      content: 'old turn',
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/api/admin/langsmith/sessions?days=7')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.totals.sessions).toBe(0);
    expect(res.body.totals.estimatedCostUsd).toBeNull();
  });
});
