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
exports.isEvalSchedulerRunning = exports.stopEvalScheduler = exports.startEvalScheduler = exports.runEvalSchedulerTick = exports.reclaimStaleEvalRuns = exports.hasRunForUtcDay = exports.utcDayStart = exports.STALE_EVAL_RUNNING_MS = void 0;
/*
 * #225 scheduled eval runs. Modelled on `assetJobService`'s in-process
 * poller (no cron dependency is present, and one daily job does not justify
 * adding one). A tick is a no-op unless the current UTC day still has no run
 * and the configured start hour has passed, so restarts do not double-run;
 * a catch-up check closes the "redeploy around midnight" gap (OQ1 fallback).
 * The run function is injectable so tests drive it with fake timers.
 *
 * Eval failures never crash the server: every tick is wrapped, the run
 * function records its own `error` row, and a stale `running` lease older
 * than the sweep window is reclaimed at start (OQ7 fallback, mirroring
 * `requeueStaleAssetJobs`).
 */
const EvalRunRecord_1 = require("../models/EvalRunRecord");
const DEFAULT_TICK_MS = 15 * 60 * 1000;
// A stranded `running` row (server died mid-run) blocks all future runs
// under the serialisation lease, so the scheduler reclaims one older than
// this at start. 2× a generous suite duration.
exports.STALE_EVAL_RUNNING_MS = 2 * 60 * 60 * 1000;
let timer = null;
let busy = false;
/** UTC midnight for the day containing `date`. */
const utcDayStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
exports.utcDayStart = utcDayStart;
/**
 * True when a run already exists for the current UTC day. Used both by the
 * tick (idempotency) and the boot catch-up check.
 */
const hasRunForUtcDay = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (now = new Date()) {
    const start = (0, exports.utcDayStart)(now);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const existing = yield EvalRunRecord_1.EvalRunRecord.findOne({
        startedAt: { $gte: start, $lt: end },
        // Any status counts: a failed run still occupied the window; re-running
        // is the manual "Run now" path, not the scheduler's job.
        status: { $in: ['running', 'done', 'error'] },
    })
        .select({ _id: 1 })
        .lean()
        .exec();
    return existing !== null;
});
exports.hasRunForUtcDay = hasRunForUtcDay;
/**
 * Reclaims a stranded `running` lease older than `maxAgeMs`. Mirrors
 * `requeueStaleAssetJobs`: the lease is settled to `error` (the run never
 * finished) so the next tick can proceed.
 */
const reclaimStaleEvalRuns = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (maxAgeMs = exports.STALE_EVAL_RUNNING_MS) {
    var _a;
    const result = yield EvalRunRecord_1.EvalRunRecord.updateMany({ status: 'running', startedAt: { $lt: new Date(Date.now() - maxAgeMs) } }, { $set: { status: 'error', finishedAt: new Date(), error: 'stale lease reclaimed' } });
    return (_a = result.modifiedCount) !== null && _a !== void 0 ? _a : 0;
});
exports.reclaimStaleEvalRuns = reclaimStaleEvalRuns;
const dueNow = (opts, now) => {
    const hour = Number.isInteger(opts.hourUtc) ? Math.min(23, Math.max(0, opts.hourUtc)) : 0;
    return now.getUTCHours() >= hour;
};
/** One scheduler tick: catch-up-aware, idempotent per UTC day, never stacking. */
const runEvalSchedulerTick = (run_1, opts_1, ...args_1) => __awaiter(void 0, [run_1, opts_1, ...args_1], void 0, function* (run, opts, now = new Date()) {
    var _a;
    if (!opts.enabled)
        return;
    if (!dueNow(opts, now))
        return;
    if (yield ((_a = opts.hasRun) !== null && _a !== void 0 ? _a : exports.hasRunForUtcDay)(now))
        return;
    yield run();
});
exports.runEvalSchedulerTick = runEvalSchedulerTick;
const startEvalScheduler = (run, opts) => {
    var _a, _b, _c;
    if (!opts.enabled)
        return null;
    if (timer)
        return timer;
    // Self-heal a stranded lease before the first tick (OQ7).
    void ((_a = opts.reclaimStaleRuns) !== null && _a !== void 0 ? _a : exports.reclaimStaleEvalRuns)().catch(() => undefined);
    timer = setInterval(() => {
        // A long run must not stack ticks; skip while one is in flight.
        if (busy)
            return;
        busy = true;
        void (0, exports.runEvalSchedulerTick)(run, opts)
            .catch(() => undefined)
            .finally(() => {
            busy = false;
        });
    }, (_b = opts.tickMs) !== null && _b !== void 0 ? _b : DEFAULT_TICK_MS);
    (_c = timer.unref) === null || _c === void 0 ? void 0 : _c.call(timer);
    return timer;
};
exports.startEvalScheduler = startEvalScheduler;
const stopEvalScheduler = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
exports.stopEvalScheduler = stopEvalScheduler;
const isEvalSchedulerRunning = () => timer !== null;
exports.isEvalSchedulerRunning = isEvalSchedulerRunning;
