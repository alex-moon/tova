import { traceStats } from './langsmithTracesService';
import {
  TraceStatsCache,
  windowKeyFor,
  type TraceStatsCacheDocument,
} from '../models/TraceStatsCache';

/*
 * Background poller for the admin Traces summary cache (#224). The overview
 * is the useful part of the tab and was recomputed on every load from a paged
 * live sweep; this job recomputes it every ~120s and upserts one document per
 * window, so the route serves the summary from Mongo.
 *
 * Shape mirrors `assetJobService`: module-level `busy` guard to skip ticks
 * while the previous sweep is still in flight (a sweep can take seconds against
 * a rate-limited upstream), an `unref`ed interval so it never holds the process
 * open, idempotent start, `stop`/`isRunning` accessors, and it is started from
 * `index.ts` only outside tests.
 *
 * The job stores tokens only; cost is joined at read time so a price correction
 * is reflected immediately (decision 4).
 */

export const DEFAULT_TRACE_STATS_INTERVAL_MS = 120_000;

// The window the poller pre-computes. The route still accepts a `days` param,
// but only this default window is cached; other windows fall back to live
// (decision 6).
export const TRACE_STATS_WINDOW_DAYS = 7;

// A cache older than two intervals reads as stale; the route then falls back
// to a live sweep so the tab never shows a frozen summary.
export const TRACE_STATS_STALE_MS = DEFAULT_TRACE_STATS_INTERVAL_MS * 2;

// Compute the rollup and upsert it for the window. Returns the written
// document, or null when tracing is unconfigured (nothing to cache — the route
// still answers 503 in that case, unchanged).
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
    // A failed sweep must not kill the poller; the next tick retries, and the
    // route's stale fallback covers the gap.
    void runTraceStatsTick().finally(() => {
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
