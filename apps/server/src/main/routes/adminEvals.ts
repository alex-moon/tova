import express from 'express';
import { authenticateBearerOrSession, requireRole } from '../middleware/auth';
import { getEvalRun, listEvalRuns } from '../services/evalRunsAdminService';
import {
  beginEvalRun,
  EvalConfigError,
  EvalRunBusyError,
  executeEvalRun,
  langsmithClientFromEnv,
  resolveScheduledModels,
} from '../services/evalRunService';
import { config } from '../config';

const router = express.Router();

// Cookie sessions for the browser flow, PAT bearer for the agent/CLI path.
// @see #184
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

// ObjectId hex validated pre-query: garbage id is 400/404, not a crash.
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const evalModels = () =>
  resolveScheduledModels({
    models: config.evals.models,
    model: config.evals.model,
    provider: config.evals.provider,
  });

// Recent runs, newest first. `limit` is clamped server-side.
router.get('/evals/runs', ...adminGuard, async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const runs = await listEvalRuns(Number.isInteger(rawLimit) ? rawLimit : undefined);
  res.json({ runs });
});

// One run's per-case breakdown.
router.get('/evals/runs/:id', ...adminGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!OBJECT_ID_PATTERN.test(id)) return res.status(400).json({ message: 'Invalid run id' });
  const run = await getEvalRun(id);
  if (!run) return res.status(404).json({ message: 'Run not found' });
  res.json(run);
});

// Manual "Run now": writes the lease, runs in background; busy is 409 and a
// bad provider config is a 400, not a 500. @see #394
router.post('/evals/run', ...adminGuard, async (_req, res) => {
  try {
    const options = { models: evalModels(), trigger: 'manual' as const };
    // Best-effort LangSmith export; a keyless deploy still records.
    const langsmithClient = await langsmithClientFromEnv(config.langsmith.apiKey);
    const id = await beginEvalRun(options);
    void executeEvalRun(id, options, { langsmithClient }).catch(() => {
      // The run settles its own `error` row; nothing to surface post-202.
    });
    return res.status(202).json({ id });
  } catch (error) {
    if (error instanceof EvalRunBusyError) {
      return res.status(409).json({ message: error.message });
    }
    if (error instanceof EvalConfigError) {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Failed to start eval run' });
  }
});

export default router;
