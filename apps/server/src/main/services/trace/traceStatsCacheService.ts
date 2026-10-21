import { traceStats } from '../langsmithTracesService';
import { redactForLog } from '../logRedaction';
import {
  TraceStatsCache,
  windowKeyFor,
  type TraceStatsCacheDocument,
} from '../../models/TraceStatsCache';

/* Poller for the admin Traces cache: recompute, upsert per window. */
// @see #224

export const DEFAULT_TRACE_STATS_INTERVAL_MS = 120_000;

// The window the poller pre-computes; other windows fall back to live.
export const TRACE_STATS_WINDOW_DAYS = 7;

// Older than two intervals reads stale; the route sweeps live.
export const TRACE_STATS_STALE_MS = DEFAULT_TRACE_STATS_INTERVAL_MS * 2;

// Compute the rollup and upsert it; null when tracing is unconfigured.
export const runTraceStatsTick = async (
  days: number = TRACE_STATS_WINDOW_DAYS,
): Promise<TraceStatsCacheDocument | null> => {
  const payload = await traceStats(days);
  if (!payload) return null;

  return TraceStatsCache.findOneAndUpdate(
    { windowKey: windowKeyFor(days) },
    {
      $set: {
        days,
        since: payload.since,
        computedAt: new Date(),
        models: payload.models.map((m) => ({
          model: m.model,
          provider: m.provider,
          calls: m.calls,
          errors: m.errors,
          avgDurationMs: m.avgDurationMs,
          avgTtftMs: m.avgTtftMs,
          totalTokens: m.totalTokens,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
        })),
        totals: {
          calls: payload.totals.calls,
          errors: payload.totals.errors,
          totalTokens: payload.totals.totalTokens,
          inputTokens: payload.totals.inputTokens,
          outputTokens: payload.totals.outputTokens,
        },
      },
    },
    { upsert: true, new: true },
  );
};

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

export const startTraceStatsPoller = (
  intervalMs = DEFAULT_TRACE_STATS_INTERVAL_MS,
): ReturnType<typeof setInterval> => {
  if (timer) return timer;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    // The .catch is load-bearing: a bare .finally would re-throw unhandled.
    void runTraceStatsTick()
      .catch((err) => {
        console.error('Trace stats poll failed:', redactForLog(err));
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref?.();
  return timer;
};

export const stopTraceStatsPoller = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

export const isTraceStatsPollerRunning = (): boolean => timer !== null;
