import { purgeUserTraces } from './tracePurge';

// Unit coverage for the best-effort trace purge (issue #143). The service
// talks to the LangSmith REST API over global fetch (pattern: the raw REST
// calls of traceRedaction.ts' exporter); each suite mocks global.fetch and
// the langsmith env so the real network is never touched.

type FetchInit = { body?: string };

const mockFetch = (impl: (url: string, init?: FetchInit) => Promise<Response>) => {
  const spy = jest.spyOn(global, 'fetch').mockImplementation(impl as never);
  return spy;
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('purgeUserTraces', () => {
  const env = { key: process.env.LANGSMITH_API_KEY, project: process.env.LANGSMITH_PROJECT };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LANGSMITH_API_KEY = 'ls-key';
    process.env.LANGSMITH_PROJECT = 'tova-dev';
    fetchSpy = mockFetch(() => Promise.resolve(jsonResponse(200, [])));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.LANGSMITH_API_KEY = env.key;
    process.env.LANGSMITH_PROJECT = env.project;
  });

  it('is a silent no-op without an API key (dev/stub parity with the exporter)', async () => {
    process.env.LANGSMITH_API_KEY = '';
    await expect(purgeUserTraces(['s1'])).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a no-op with no session ids', async () => {
    await expect(purgeUserTraces([])).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the project id by name, queries runs by session metadata and batch-deletes the trace ids', async () => {
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (typeof url === 'string' && url.includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (typeof url === 'string' && url.includes('/api/v1/runs/query')) {
        return Promise.resolve(
          jsonResponse(200, [
            { trace_id: 'trace-1' },
            { trace_id: 'trace-2' },
            // no trace_id: tolerated
            {},
          ]),
        );
      }
      expect(String(url)).toContain('/api/v1/runs/delete');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({
        session_id: 'proj-1',
        trace_ids: ['trace-1', 'trace-2'],
      });
      return Promise.resolve(jsonResponse(202, {}));
    });

    await expect(purgeUserTraces(['sess-abc'])).resolves.toBeUndefined();

    const queryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/runs/query'));
    expect(queryCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'x-api-key': 'ls-key' },
    });
    expect(JSON.parse((queryCall?.[1] as FetchInit).body as string)).toMatchObject({
      session: ['proj-1'],
      filter: 'and(in(metadata_key, ["session_id"]), eq(metadata_value, "sess-abc"))',
      limit: 100,
      offset: 0,
    });
  });

  it('refuses to guess the project when the name lookup does not match (no wrong-project deletes)', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        // The name filter returned an unrelated project (API drift scenario).
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-other', name: 'not-tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, []));
    });

    await purgeUserTraces(['sess-1']);

    // No run query or delete may fire for an unverifiable project id.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/'))).toHaveLength(0);
  });

  it('paginates run queries until a short page, batching Deletes at 100', async () => {
    const fullPages = Array.from({ length: 100 }, (_, i) => ({ trace_id: `t-${i}` }));
    const deleteBodies: unknown[] = [];
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (String(url).includes('/api/v1/runs/query')) {
        const offset = JSON.parse(init?.body ?? '{}').offset as number;
        return Promise.resolve(jsonResponse(200, offset === 0 ? fullPages : []));
      }
      deleteBodies.push(JSON.parse(init?.body ?? '{}'));
      return Promise.resolve(jsonResponse(202, {}));
    });

    await purgeUserTraces(['sess-1']);

    // First page full (offset 0), second page empty → stop after two queries.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/query')).length).toBe(2);
    // 100 trace ids in exactly one delete batch of 100.
    expect(deleteBodies).toEqual([{ session_id: 'proj-1', trace_ids: expect.anything() }]);
    expect((deleteBodies[0] as { trace_ids: string[] }).trace_ids).toHaveLength(100);
  });

  it('degrades every API failure to a log, never a throw', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(403, { detail: 'no' })));
    await expect(purgeUserTraces(['sess-1'])).resolves.toBeUndefined();
  });

  it('continues to the remaining sessions when one session fails mid-loop', async () => {
    // Queries are sequential (one per session, in list order): call #2 is
    // bravo's. Bravo's query fails with a rate-limit while the others would
    // have worked — the later session must still be attempted.
    let queryCalls = 0;
    const deleteCalls: unknown[] = [];
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (String(url).includes('/api/v1/runs/query')) {
        queryCalls += 1;
        return queryCalls === 2
          ? Promise.resolve(jsonResponse(429, { detail: 'rate limited' }))
          : Promise.resolve(jsonResponse(200, [{ trace_id: `t-${queryCalls}` }]));
      }
      deleteCalls.push(JSON.parse(init?.body ?? '{}'));
      return Promise.resolve(jsonResponse(202, {}));
    });

    await expect(
      purgeUserTraces(['sess-alpha', 'sess-bravo', 'sess-charlie']),
    ).resolves.toBeUndefined();

    expect(queryCalls).toBe(3);
    // Alpha's and charlie's traces were deleted despite bravo failing.
    expect(deleteCalls.map((b) => (b as { trace_ids: string[] }).trace_ids[0])).toEqual([
      't-1',
      't-3',
    ]);
  });

  it('never throws when fetch itself rejects (network down)', async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error('offline')));
    await expect(purgeUserTraces(['sess-1'])).resolves.toBeUndefined();
  });
});
