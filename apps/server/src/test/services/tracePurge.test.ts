import { purgeUserTraces } from '../../main/services/tracePurge';

// Best-effort trace purge; fetch and env mocked, real network never touched.
// @see #143

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
    fetchSpy = mockFetch(() => Promise.resolve(jsonResponse(200, { runs: [] })));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.LANGSMITH_API_KEY = env.key;
    process.env.LANGSMITH_PROJECT = env.project;
  });

  it('is a silent no-op without an API key (dev/stub parity with the exporter)', async () => {
    process.env.LANGSMITH_API_KEY = '';
    await expect(purgeUserTraces(['111111111111111111111111'])).resolves.toBeUndefined();
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
          jsonResponse(200, {
            runs: [
              { trace_id: 'trace-1' },
              { trace_id: 'trace-2' },
              // no trace_id: tolerated
              {},
            ],
          }),
        );
      }
      expect(String(url)).toContain('/api/v1/runs/delete');
      expect(JSON.parse(init?.body ?? '{}')).toEqual({
        session_id: 'proj-1',
        trace_ids: ['trace-1', 'trace-2'],
      });
      return Promise.resolve(jsonResponse(202, {}));
    });

    await expect(purgeUserTraces(['abc123456789abcdef012345'])).resolves.toBeUndefined();

    const queryCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/runs/query'));
    expect(queryCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'x-api-key': 'ls-key' },
    });
    expect(JSON.parse((queryCall?.[1] as FetchInit).body as string)).toMatchObject({
      session: ['proj-1'],
      filter:
        'and(in(metadata_key, ["session_id"]), eq(metadata_value, "abc123456789abcdef012345"))',
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

    await purgeUserTraces(['222222222222222222222222']);

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
        return Promise.resolve(jsonResponse(200, { runs: offset === 0 ? fullPages : [] }));
      }
      deleteBodies.push(JSON.parse(init?.body ?? '{}'));
      return Promise.resolve(jsonResponse(202, {}));
    });

    await purgeUserTraces(['222222222222222222222222']);

    // First page full (offset 0), second page empty → stop after two queries.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/query')).length).toBe(2);
    // 100 trace ids in exactly one delete batch of 100.
    expect(deleteBodies).toEqual([{ session_id: 'proj-1', trace_ids: expect.anything() }]);
    expect((deleteBodies[0] as { trace_ids: string[] }).trace_ids).toHaveLength(100);
  });

  it('splits ids from multiple full pages into delete batches of at most 100', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({ trace_id: `p1-${i}` }));
    const pageTwo = Array.from({ length: 50 }, (_, i) => ({ trace_id: `p2-${i}` }));
    const deleteBodies: unknown[] = [];
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (String(url).includes('/api/v1/runs/query')) {
        const offset = JSON.parse(init?.body ?? '{}').offset as number;
        return Promise.resolve(
          jsonResponse(200, { runs: offset === 0 ? pageOne : offset === 100 ? pageTwo : [] }),
        );
      }
      deleteBodies.push(JSON.parse(init?.body ?? '{}'));
      return Promise.resolve(jsonResponse(202, {}));
    });

    await purgeUserTraces(['222222222222222222222222']);

    // 150 ids → one batch of 100, then a remainder batch of 50.
    expect(deleteBodies).toHaveLength(2);
    expect((deleteBodies[0] as { trace_ids: string[] }).trace_ids).toHaveLength(100);
    expect((deleteBodies[1] as { trace_ids: string[] }).trace_ids).toHaveLength(50);
    const all = deleteBodies.flatMap((b) => (b as { trace_ids: string[] }).trace_ids);
    expect(new Set(all).size).toBe(150);
  });

  it('treats a non-array `runs` as malformed: logs, deletes nothing, never throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, { runs: 'nope' }));
    });

    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/delete'))).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('treats an absent `runs` key as malformed (not an empty page): logs and deletes nothing', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, { cursors: [] }));
    });

    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/delete'))).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('rejects the legacy array-shaped body (the #187 regression): logs, deletes nothing', async () => {
    // An array body has no `runs` key and must be treated as malformed.
    // @see #187
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      return Promise.resolve(jsonResponse(200, [{ trace_id: 'trace-1' }]));
    });

    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/delete'))).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('advances pagination on an all-blank page without deleting', async () => {
    const blankPage = Array.from({ length: 100 }, () => ({}));
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (String(url).includes('/api/v1/runs/query')) {
        const offset = JSON.parse(init?.body ?? '{}').offset as number;
        return Promise.resolve(jsonResponse(200, { runs: offset === 0 ? blankPage : [] }));
      }
      expect(String(url)).toContain('/api/v1/runs/delete');
      return Promise.resolve(jsonResponse(202, {}));
    });

    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();

    // Full blank page → a second page is queried; no ids were ever collected.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/query')).length).toBe(2);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/delete'))).toHaveLength(0);
  });

  it('degrades every API failure to a log, never a throw', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(403, { detail: 'no' })));
    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();
  });

  it('continues to the remaining sessions when one session fails mid-loop', async () => {
    // One failing session must not stop the later sessions being attempted.
    // @see #143
    let queryCalls = 0;
    const deleteCalls: unknown[] = [];
    fetchSpy.mockImplementation((url: string, init?: { body?: string }) => {
      if (String(url).includes('/api/v1/sessions')) {
        return Promise.resolve(jsonResponse(200, [{ id: 'proj-1', name: 'tova-dev' }]));
      }
      if (String(url).includes('/api/v1/runs/query')) {
        queryCalls += 1;
        // 400: not retried by the shared fetch plumbing, so the session fails.
        return queryCalls === 2
          ? Promise.resolve(jsonResponse(400, { detail: 'bad request' }))
          : Promise.resolve(jsonResponse(200, { runs: [{ trace_id: `t-${queryCalls}` }] }));
      }
      deleteCalls.push(JSON.parse(init?.body ?? '{}'));
      return Promise.resolve(jsonResponse(202, {}));
    });

    await expect(
      purgeUserTraces([
        'aaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbb',
        'cccccccccccccccccccccccc',
      ]),
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
    await expect(purgeUserTraces(['222222222222222222222222'])).resolves.toBeUndefined();
  });

  it('skips session ids that are not ObjectId hex (filter injection hardening, #397)', async () => {
    await expect(purgeUserTraces(['x") eq(1,1) "'])).resolves.toBeUndefined();
    // Only the project lookup may have run; no query/delete for the hostile id.
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/runs/'))).toHaveLength(0);
  });
});
