import { TraceStatsCache, windowKeyFor } from '../../main/models/TraceStatsCache';

describe('TraceStatsCache model (#224)', () => {
  const payload = {
    model: 'openai/gpt-oss-20b',
    calls: 2,
    errors: 1,
    avgDurationMs: 2500,
    totalTokens: 110,
    inputTokens: 78,
    outputTokens: 32,
  };

  it('builds a stable window key', () => {
    expect(windowKeyFor(7)).toBe('days=7');
    expect(windowKeyFor(30)).toBe('days=30');
  });

  it('stores a rollup and reads it back', async () => {
    await TraceStatsCache.create({
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      computedAt: new Date(),
      models: [payload],
      totals: { calls: 2, errors: 1, totalTokens: 110, inputTokens: 78, outputTokens: 32 },
    });

    const doc = await TraceStatsCache.findOne({ windowKey: 'days=7' });
    expect(doc?.models?.[0]).toMatchObject(payload);
    expect(doc?.totals?.inputTokens).toBe(78);
  });

  it('rejects a second document for the same window', async () => {
    const base = {
      windowKey: 'days=7',
      days: 7,
      since: '2026-09-20T00:00:00.000Z',
      computedAt: new Date(),
      models: [],
      totals: { calls: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    };
    await TraceStatsCache.create(base);
    await expect(TraceStatsCache.create(base)).rejects.toThrow();
  });
});
