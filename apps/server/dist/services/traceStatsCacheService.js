"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTraceStatsPollerRunning = exports.stopTraceStatsPoller = exports.startTraceStatsPoller = exports.runTraceStatsTick = exports.TRACE_STATS_STALE_MS = exports.TRACE_STATS_WINDOW_DAYS = exports.DEFAULT_TRACE_STATS_INTERVAL_MS = void 0;
const langsmithTracesService_1 = require("./langsmithTracesService");
const logRedaction_1 = require("./logRedaction");
const TraceStatsCache_1 = require("../models/TraceStatsCache");
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
exports.DEFAULT_TRACE_STATS_INTERVAL_MS = 120000;
// The window the poller pre-computes. The route still accepts a `days` param,
// but only this default window is cached; other windows fall back to live
// (decision 6).
exports.TRACE_STATS_WINDOW_DAYS = 7;
// A cache older than two intervals reads as stale; the route then falls back
// to a live sweep so the tab never shows a frozen summary.
exports.TRACE_STATS_STALE_MS = exports.DEFAULT_TRACE_STATS_INTERVAL_MS * 2;
// Compute the rollup and upsert it for the window. Returns the written
// document, or null when tracing is unconfigured (nothing to cache — the route
// still answers 503 in that case, unchanged).
const runTraceStatsTick = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (days = exports.TRACE_STATS_WINDOW_DAYS) {
    const payload = yield (0, langsmithTracesService_1.traceStats)(days);
    if (!payload)
        return null;
    return TraceStatsCache_1.TraceStatsCache.findOneAndUpdate({ windowKey: (0, TraceStatsCache_1.windowKeyFor)(days) }, {
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
    }, { upsert: true, new: true });
});
exports.runTraceStatsTick = runTraceStatsTick;
let timer = null;
let busy = false;
const startTraceStatsPoller = (intervalMs = exports.DEFAULT_TRACE_STATS_INTERVAL_MS) => {
    var _a;
    if (timer)
        return timer;
    timer = setInterval(() => {
        if (busy)
            return;
        busy = true;
        // A failed sweep must not kill the poller *or* the process; the next tick
        // retries, and the route's stale fallback covers the gap. The `.catch` is
        // load-bearing: a bare `.finally` re-throws the original rejection, and an
        // unhandled rejection from this voided promise terminates the process.
        void (0, exports.runTraceStatsTick)()
            .catch((err) => {
            console.error('Trace stats poll failed:', (0, logRedaction_1.redactForLog)(err));
        })
            .finally(() => {
            busy = false;
        });
    }, intervalMs);
    (_a = timer.unref) === null || _a === void 0 ? void 0 : _a.call(timer);
    return timer;
};
exports.startTraceStatsPoller = startTraceStatsPoller;
const stopTraceStatsPoller = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
exports.stopTraceStatsPoller = stopTraceStatsPoller;
const isTraceStatsPollerRunning = () => timer !== null;
exports.isTraceStatsPollerRunning = isTraceStatsPollerRunning;
