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
exports.isAssetJobPollerRunning = exports.stopAssetJobPoller = exports.startAssetJobPoller = exports.requeueStaleAssetJobs = exports.STALE_PROCESSING_MS = exports.runAssetJobTick = exports.claimNextAssetJob = exports.enqueueAssetJob = exports.MAX_JOB_ATTEMPTS = void 0;
const Asset_1 = require("../models/Asset");
const AssetJob_1 = require("../models/AssetJob");
// Mongo-backed conversion queue (issue #67): enqueue is idempotent per
// "live" job, the poller claims one pending job atomically per tick, and
// failures retry up to MAX_JOB_ATTEMPTS before terminal-failing the job and
// the asset's markdown status. The processor is injectable so tests (and a
// later iteration's conversion service) can supply the real converter.
exports.MAX_JOB_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 5000;
const MAX_STORED_ERROR_CHARS = 500;
const clampError = (err) => {
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, MAX_STORED_ERROR_CHARS);
};
// Idempotent enqueue: a pending/processing/done job for the asset is reused
// (enqueue only matters while the asset's markdownStatus is 'pending');
// a previously failed chain gets a fresh job.
const enqueueAssetJob = (assetId) => __awaiter(void 0, void 0, void 0, function* () {
    const existing = yield AssetJob_1.AssetJob.findOne({
        assetId,
        status: { $in: ['pending', 'processing', 'done'] },
    });
    if (existing)
        return existing;
    return AssetJob_1.AssetJob.create({ assetId });
});
exports.enqueueAssetJob = enqueueAssetJob;
// Atomic claim: status + attempts bump in one findOneAndUpdate, sorted
// oldest-pending-first. Single consumer in-process; multiple server
// processes would still not double-claim the same row.
const claimNextAssetJob = () => __awaiter(void 0, void 0, void 0, function* () {
    return AssetJob_1.AssetJob.findOneAndUpdate({ status: 'pending' }, { $set: { status: 'processing' }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
});
exports.claimNextAssetJob = claimNextAssetJob;
// One poll tick: claim a job, run the processor, and settle the outcome.
// Processor failures retry until MAX_JOB_ATTEMPTS attempts have been made,
// at which point the job terminal-fails and whichever asset lifecycles are
// still pending flip to 'failed' (the asset itself stays 'ready' — the
// original binary is fine). A job may cover conversion, thumbnail, or both.
const runAssetJobTick = (processor) => __awaiter(void 0, void 0, void 0, function* () {
    const job = yield (0, exports.claimNextAssetJob)();
    if (!job)
        return;
    try {
        yield processor(job);
        job.status = 'done';
        yield job.save();
    }
    catch (err) {
        const message = clampError(err);
        const exhausted = job.attempts >= exports.MAX_JOB_ATTEMPTS;
        yield AssetJob_1.AssetJob.updateOne({ _id: job._id }, {
            $set: {
                status: exhausted ? 'failed' : 'pending',
                lastError: message,
            },
        });
        if (exhausted) {
            // Fail only the lifecycles the processor did not finish; a job that was
            // conversion-only must not clobber a ready thumbnail status, and vice
            // versa.
            yield Asset_1.Asset.updateOne({ _id: job.assetId, markdownStatus: 'pending' }, { $set: { markdownStatus: 'failed', markdownFailureReason: message } });
            yield Asset_1.Asset.updateOne({ _id: job.assetId, thumbnailStatus: 'pending' }, { $set: { thumbnailStatus: 'failed' } });
        }
    }
});
exports.runAssetJobTick = runAssetJobTick;
let timer = null;
let busy = false;
// A server crash mid-job leaves a `processing` row stranded forever, which
// also blocks enqueueAssetJob (a live-status job is reused). At poller start
// such jobs older than STALE_PROCESSING_MS are requeued as `pending` so a
// restart self-heals; updatedAt (bumped by the claim and by timestamps) is
// the staleness clock. Attempts are not incremented — the sweep does not
// count against the retry cap because the processor never observed the loss.
exports.STALE_PROCESSING_MS = 5 * 60 * 1000;
const requeueStaleAssetJobs = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (maxAgeMs = exports.STALE_PROCESSING_MS) {
    var _a;
    const result = yield AssetJob_1.AssetJob.updateMany({ status: 'processing', updatedAt: { $lt: new Date(Date.now() - maxAgeMs) } }, { $set: { status: 'pending' } });
    return (_a = result.modifiedCount) !== null && _a !== void 0 ? _a : 0;
});
exports.requeueStaleAssetJobs = requeueStaleAssetJobs;
const startAssetJobPoller = (processor, intervalMs = POLL_INTERVAL_MS) => {
    var _a;
    if (timer)
        return timer;
    void (0, exports.requeueStaleAssetJobs)().catch(() => undefined);
    timer = setInterval(() => {
        // One job per tick; skip ticks while the previous processor run is still
        // in flight so slow conversions don't stack up queries.
        if (busy)
            return;
        busy = true;
        void (0, exports.runAssetJobTick)(processor).finally(() => {
            busy = false;
        });
    }, intervalMs);
    (_a = timer.unref) === null || _a === void 0 ? void 0 : _a.call(timer);
    return timer;
};
exports.startAssetJobPoller = startAssetJobPoller;
const stopAssetJobPoller = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};
exports.stopAssetJobPoller = stopAssetJobPoller;
const isAssetJobPollerRunning = () => timer !== null;
exports.isAssetJobPollerRunning = isAssetJobPollerRunning;
