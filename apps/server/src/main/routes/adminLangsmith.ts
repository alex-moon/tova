import express from 'express';
import { authenticateBearerOrSession, requireRole } from '../middleware/auth';
import {
  getTrace,
  listTraces,
  traceStats,
  LangsmithError,
} from '../services/langsmithTracesService';
import { TraceStatsCache, windowKeyFor } from '../models/TraceStatsCache';
import { TRACE_STATS_STALE_MS, TRACE_STATS_WINDOW_DAYS } from '../services/traceStatsCacheService';
import { applyCostToStats } from '../services/traceStatsCost';
import { sessionCostBreakdown } from '../services/sessionCostService';

const router = express.Router();

// Cookie sessions for the browser flow, PAT bearer for the agent/CLI path.
// @see #184
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

// Trace ids are uuid-shaped; the regex keeps filter injection out of the query string.
const TRACE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

// 503 = tracing unconfigured, 502 = LangSmith upstream refused/failed.
router.get('/langsmith/traces', ...adminGuard, async (req, res) => {
  const errorsOnly = req.query.errorsOnly === 'true';
  const model =
    typeof req.query.model === 'string' && req.query.model ? req.query.model : undefined;
  const limit = Number(req.query.limit);

  try {
    const payload = await listTraces({
      errorsOnly,
      ...(model ? { model } : {}),
      ...(Number.isInteger(limit) ? { limit } : {}),
    });
    if (!payload) return res.status(503).json({ message: 'LangSmith tracing is not configured' });
    res.json(payload);
  } catch (_err) {
    res.status(502).json({ message: 'Error reading LangSmith traces' });
  }
});

router.get('/langsmith/traces/:traceId', ...adminGuard, async (req, res) => {
  const traceId = String(req.params.traceId);
  if (!TRACE_ID_PATTERN.test(traceId)) {
    return res.status(400).json({ message: 'Invalid trace id' });
  }

  try {
    const detail = await getTrace(traceId);
    if (!detail) return res.status(503).json({ message: 'LangSmith tracing is not configured' });
    if (detail.runs.length === 0) return res.status(404).json({ message: 'Trace not found' });
    res.json(detail);
  } catch (err) {
    if (err instanceof LangsmithError) return res.status(502).json({ message: err.message });
    res.status(502).json({ message: 'Error reading LangSmith trace' });
  }
});

router.get('/langsmith/stats', ...adminGuard, async (req, res) => {
  const rawDays = Number(req.query.days);
  const days = Number.isInteger(rawDays) ? Math.min(30, Math.max(1, rawDays)) : 7;

  // Only the poller's default window is cached; other windows are a live sweep.
  // @see #224
  if (days === TRACE_STATS_WINDOW_DAYS) {
    try {
      const cached = await TraceStatsCache.findOne({ windowKey: windowKeyFor(days) }).lean<{
        since: string;
        computedAt: Date;
        models: {
          model: string;
          provider: string | null;
          calls: number;
          errors: number;
          avgDurationMs: number | null;
          avgTtftMs: number | null;
          totalTokens: number;
          inputTokens: number;
          outputTokens: number;
        }[];
        totals: {
          calls: number;
          errors: number;
          totalTokens: number;
          inputTokens: number;
          outputTokens: number;
        };
      } | null>();
      const fresh =
        cached && Date.now() - new Date(cached.computedAt).getTime() <= TRACE_STATS_STALE_MS;
      if (cached && fresh) {
        const payload = await applyCostToStats({
          since: cached.since,
          models: cached.models.map((m) => ({ ...m, estimatedCostUsd: null })),
          totals: { ...cached.totals, estimatedCostUsd: null },
          computedAt: new Date(cached.computedAt).toISOString(),
          stale: false,
        });
        return res.json(payload);
      }
    } catch (_err) {
      // A cache read failure is not fatal: fall through to the live sweep.
    }
  }

  try {
    const live = await traceStats(days);
    if (!live) return res.status(503).json({ message: 'LangSmith tracing is not configured' });
    const payload = await applyCostToStats({ ...live, stale: true });
    res.json(payload);
  } catch (_err) {
    res.status(502).json({ message: 'Error reading LangSmith stats' });
  }
});

// Per-session cost breakdown from our own Message rows; no LangSmith, no cache needed.
// @see #224
router.get('/langsmith/sessions', ...adminGuard, async (req, res) => {
  const rawDays = Number(req.query.days);
  const days = Number.isInteger(rawDays) ? Math.min(30, Math.max(1, rawDays)) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    res.json(await sessionCostBreakdown({ since }));
  } catch (_err) {
    res.status(500).json({ message: 'Error reading session costs' });
  }
});

export default router;
