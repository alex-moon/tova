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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const langsmithTracesService_1 = require("../services/langsmithTracesService");
const TraceStatsCache_1 = require("../models/TraceStatsCache");
const traceStatsCacheService_1 = require("../services/traceStatsCacheService");
const traceStatsCost_1 = require("../services/traceStatsCost");
const sessionCostService_1 = require("../services/sessionCostService");
const router = express_1.default.Router();
// Same guard as the other admin surfaces: cookie sessions for the browser
// flow, PAT bearer for the agent/CLI path (#184).
const adminGuard = [auth_1.authenticateBearerOrSession, (0, auth_1.requireRole)('admin')];
// LangSmith trace ids are uuid-shaped; the regex keeps filter injection out
// of the query string (the id is interpolated into a filter expression).
const TRACE_ID_PATTERN = /^[A-Za-z0-9-]+$/;
// Unconfigured tracing and upstream failures read differently in the tab:
// 503 = this deployment never exports traces, 502 = LangSmith itself
// refused/failed. Everything else is a bad request.
router.get('/langsmith/traces', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const errorsOnly = req.query.errorsOnly === 'true';
    const model = typeof req.query.model === 'string' && req.query.model ? req.query.model : undefined;
    const limit = Number(req.query.limit);
    try {
        const payload = yield (0, langsmithTracesService_1.listTraces)(Object.assign(Object.assign({ errorsOnly }, (model ? { model } : {})), (Number.isInteger(limit) ? { limit } : {})));
        if (!payload)
            return res.status(503).json({ message: 'LangSmith tracing is not configured' });
        res.json(payload);
    }
    catch (_err) {
        res.status(502).json({ message: 'Error reading LangSmith traces' });
    }
}));
router.get('/langsmith/traces/:traceId', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const traceId = String(req.params.traceId);
    if (!TRACE_ID_PATTERN.test(traceId)) {
        return res.status(400).json({ message: 'Invalid trace id' });
    }
    try {
        const detail = yield (0, langsmithTracesService_1.getTrace)(traceId);
        if (!detail)
            return res.status(503).json({ message: 'LangSmith tracing is not configured' });
        if (detail.runs.length === 0)
            return res.status(404).json({ message: 'Trace not found' });
        res.json(detail);
    }
    catch (err) {
        if (err instanceof langsmithTracesService_1.LangsmithError)
            return res.status(502).json({ message: err.message });
        res.status(502).json({ message: 'Error reading LangSmith trace' });
    }
}));
router.get('/langsmith/stats', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const rawDays = Number(req.query.days);
    const days = Number.isInteger(rawDays) ? Math.min(30, Math.max(1, rawDays)) : 7;
    // #224: only the poller's default window is cached; any other window is a
    // live sweep (the summary is the expensive part, so keep the cached path the
    // common one). The route can therefore serve the cache with no LangSmith
    // round trip on a warm window.
    if (days === traceStatsCacheService_1.TRACE_STATS_WINDOW_DAYS) {
        try {
            const cached = yield TraceStatsCache_1.TraceStatsCache.findOne({ windowKey: (0, TraceStatsCache_1.windowKeyFor)(days) }).lean();
            const fresh = cached && Date.now() - new Date(cached.computedAt).getTime() <= traceStatsCacheService_1.TRACE_STATS_STALE_MS;
            if (cached && fresh) {
                const payload = yield (0, traceStatsCost_1.applyCostToStats)({
                    since: cached.since,
                    models: cached.models.map((m) => (Object.assign(Object.assign({}, m), { estimatedCostUsd: null }))),
                    totals: Object.assign(Object.assign({}, cached.totals), { estimatedCostUsd: null }),
                    computedAt: new Date(cached.computedAt).toISOString(),
                    stale: false,
                });
                return res.json(payload);
            }
        }
        catch (_err) {
            // A cache read failure is not fatal: fall through to the live sweep.
        }
    }
    try {
        const live = yield (0, langsmithTracesService_1.traceStats)(days);
        if (!live)
            return res.status(503).json({ message: 'LangSmith tracing is not configured' });
        const payload = yield (0, traceStatsCost_1.applyCostToStats)(Object.assign(Object.assign({}, live), { stale: true }));
        res.json(payload);
    }
    catch (_err) {
        res.status(502).json({ message: 'Error reading LangSmith stats' });
    }
}));
// #224: per-session cost breakdown from our own Message rows. Unlike /stats
// this never touches LangSmith — the data is in Mongo — so it needs no cache
// and no poller. `days` (clamped 1–30) bounds the message window.
router.get('/langsmith/sessions', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const rawDays = Number(req.query.days);
    const days = Number.isInteger(rawDays) ? Math.min(30, Math.max(1, rawDays)) : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
        res.json(yield (0, sessionCostService_1.sessionCostBreakdown)({ since }));
    }
    catch (_err) {
        res.status(500).json({ message: 'Error reading session costs' });
    }
}));
exports.default = router;
