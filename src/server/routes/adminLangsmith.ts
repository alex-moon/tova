import express from 'express';
import { authenticateBearerOrSession, requireRole } from '../middleware/auth';
import {
  getTrace,
  listTraces,
  traceStats,
  LangsmithError,
} from '../services/langsmithTracesService';

const router = express.Router();

// Same guard as the other admin surfaces: cookie sessions for the browser
// flow, PAT bearer for the agent/CLI path (#184).
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

// LangSmith trace ids are uuid-shaped; the regex keeps filter injection out
// of the query string (the id is interpolated into a filter expression).
const TRACE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

// Unconfigured tracing and upstream failures read differently in the tab:
// 503 = this deployment never exports traces, 502 = LangSmith itself
// refused/failed. Everything else is a bad request.
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

  try {
    const payload = await traceStats(days);
    if (!payload) return res.status(503).json({ message: 'LangSmith tracing is not configured' });
    res.json(payload);
  } catch (_err) {
    res.status(502).json({ message: 'Error reading LangSmith stats' });
  }
});

export default router;
