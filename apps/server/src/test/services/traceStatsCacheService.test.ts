import { traceStats } from '../../main/services/langsmithTracesService';
import { TraceStatsCache } from '../../main/models/TraceStatsCache';
import {
  isTraceStatsPollerRunning,
  runTraceStatsTick,
  startTraceStatsPoller,
  stopTraceStatsPoller,
} from '../../main/services/traceStatsCacheService';
import type { AdminLangsmithStatsPayload } from '@tova/shared';

jest.mock('../../main/services/langsmithTracesService', () => ({
  ...jest.requireActual('../../main/services/langsmithTracesService'),
  traceStats: jest.fn(),
}));

const traceStatsMock = traceStats as jest.MockedFunction<typeof traceStats>;

const payload = (): AdminLangsmithStatsPayload => ({
  since: '2026-09-20T00:00:00.000Z',
  models: [
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
  ],
  totals: { calls: 2, errors: 1, totalTokens: 110, inputTokens: 78, outputTokens: 32 },
});

describe('traceStatsCacheService (#224)', () => {
  beforeEach(() => {
    traceStatsMock.mockReset();
  });

  afterEach(() => {
    stopTraceStatsPoller();
  });

  it('upserts one document per window and is idempotent', async () => {
    traceStatsMock.mockResolvedValue(payload());

    await runTraceStatsTick();
    await runTraceStatsTick();

    const docs = await TraceStatsCache.find({});
    expect(docs).toHaveLength(1);
    expect(docs[0].windowKey).toBe('days=7');
    expect(docs[0].totals.inputTokens).toBe(78);
    expect(docs[0].computedAt).toBeInstanceOf(Date);
  });

  it('writes nothing when tracing is unconfigured', async () => {
    traceStatsMock.mockResolvedValue(null);
    await runTraceStatsTick();
    expect(await TraceStatsCache.countDocuments()).toBe(0);
  });

  it('starts once and stops cleanly', () => {
    startTraceStatsPoller(1_000_000);
    const first = isTraceStatsPollerRunning();
    startTraceStatsPoller(1_000_000);
    expect(first).toBe(true);
    expect(isTraceStatsPollerRunning()).toBe(true);

    stopTraceStatsPoller();
    expect(isTraceStatsPollerRunning()).toBe(false);
  });

  it('swallows a sweep failure so the poller survives', async () => {
    traceStatsMock.mockRejectedValue(new Error('boom'));
    await expect(runTraceStatsTick()).rejects.toThrow('boom');
    // The poller loop catches it; direct tick callers still see the rejection.
    expect(await TraceStatsCache.countDocuments()).toBe(0);
  });

  // A rejected sweep must not escape the interval callback as an unhandled rejection; the poller must absorb it (and log) while still clearing `busy`.
  // @see #248
  it('does not leak an unhandled rejection when a polled sweep fails', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      traceStatsMock.mockRejectedValue(new Error('boom'));
      startTraceStatsPoller(1_000);

      await jest.advanceTimersByTimeAsync(1_000);
      // Let any microtask-queued rejection surface to the handler.
      await Promise.resolve();

      expect(unhandled).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
