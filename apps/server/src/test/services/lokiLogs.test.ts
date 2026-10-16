import { queryRetainedLogs, classifyLevel, DEFAULT_LIMIT } from '../../main/services/lokiLogs';

describe('classifyLevel', () => {
  it('classifies error and warn tokens from the message', () => {
    expect(classifyLevel('Error: boom')).toBe('error');
    expect(classifyLevel('request failed for /api/x')).toBe('error');
    expect(classifyLevel('warning: disk nearly full')).toBe('warn');
    expect(classifyLevel('all good')).toBe('info');
  });

  it('treats stderr lines as errors when the text gives no hint', () => {
    expect(classifyLevel('plain line', 'stderr')).toBe('error');
    expect(classifyLevel('plain line', 'stdout')).toBe('info');
  });
});

describe('queryRetainedLogs', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.LOKI_URL = 'https://logs-prod-000.grafana.net/loki/api/v1/push';
    process.env.LOKI_USERNAME = '123456';
    process.env.LOKI_PASSWORD = 'secret';
  });
  afterEach(() => {
    process.env = { ...OLD };
    jest.restoreAllMocks();
  });

  const nsFor = (iso: string) => `${BigInt(new Date(iso).getTime()) * BigInt(1_000_000)}`;

  const mockLoki = (streams: unknown[], ok = true) =>
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ status: 'success', data: { result: streams } }),
    } as Response);

  it('returns not-configured without calling fetch when env is absent', async () => {
    delete process.env.LOKI_URL;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const res = await queryRetainedLogs();
    expect(res).toEqual({ logs: [], configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries the query_range endpoint derived from the push URL with basic auth', async () => {
    const fetchSpy = mockLoki([]);
    await queryRetainedLogs({ hours: 24 });
    const [url, init] = fetchSpy.mock.calls[0];
    const u = url as URL;
    expect(u.origin + u.pathname).toBe('https://logs-prod-000.grafana.net/loki/api/v1/query_range');
    expect(u.searchParams.get('direction')).toBe('backward');
    expect(u.searchParams.get('limit')).toBe(String(DEFAULT_LIMIT));
    const auth = (init as { headers: Record<string, string> }).headers;
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('123456:secret').toString('base64')}`);
  });

  it('normalizes streams to entries, newest first, with derived ts', async () => {
    mockLoki([
      {
        stream: { stream: 'stdout' },
        values: [
          [nsFor('2026-10-03T10:00:00.000Z'), 'later info'],
          [nsFor('2026-10-03T09:00:00.000Z'), 'Error: earlier'],
        ],
      },
    ]);
    const { logs, configured } = await queryRetainedLogs();
    expect(configured).toBe(true);
    expect(logs.map((l) => l.msg)).toEqual(['later info', 'Error: earlier']);
    expect(logs[0].ts).toBe('2026-10-03T10:00:00.000Z');
    expect(logs[1].level).toBe('error');
  });

  it('filters by level and text after fetch', async () => {
    mockLoki([
      {
        stream: { stream: 'stdout' },
        values: [
          [nsFor('2026-10-03T10:00:00.000Z'), 'needle warn here'],
          [nsFor('2026-10-03T09:00:00.000Z'), 'Error: needle boom'],
          [nsFor('2026-10-03T08:00:00.000Z'), 'unrelated'],
        ],
      },
    ]);
    const byLevel = await queryRetainedLogs({ level: 'error' });
    expect(byLevel.logs.map((l) => l.msg)).toEqual(['Error: needle boom']);
    const byText = await queryRetainedLogs({ q: 'NEEDLE' });
    expect(byText.logs.map((l) => l.msg)).toEqual(['needle warn here', 'Error: needle boom']);
  });

  it('degrades gracefully on a non-OK Loki response', async () => {
    mockLoki([], false);
    const res = await queryRetainedLogs();
    expect(res.logs).toEqual([]);
    expect(res.configured).toBe(true);
    expect(res.error).toMatch(/Loki query failed/);
  });

  it('degrades gracefully when fetch throws', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ENOTFOUND'));
    const res = await queryRetainedLogs();
    expect(res.logs).toEqual([]);
    expect(res.error).toMatch(/Loki unreachable/);
  });

  it('clamps hours and limit to their bounds', async () => {
    const fetchSpy = mockLoki([]);
    await queryRetainedLogs({ hours: 99999, limit: 99999 });
    const u = fetchSpy.mock.calls[0][0] as URL;
    expect(Number(u.searchParams.get('limit'))).toBe(500);
    // window is capped at 168h: start is at most 168h before end
    const span = Number(u.searchParams.get('end')) - Number(u.searchParams.get('start'));
    expect(span).toBeLessThanOrEqual(168 * 3600 * 1e9);
  });
});
