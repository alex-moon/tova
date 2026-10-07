import express from 'express';
import { authenticateBearerOrSession, requireRole } from '../middleware/auth';
import { getEvalRun, listEvalRuns } from '../services/evalRunsAdminService';
import {
  beginEvalRun,
  EvalRunBusyError,
  executeEvalRun,
  resolveScheduledModels,
} from '../services/evalRunService';
import { config } from '../config';

const router = express.Router();

// Same guard as the other admin surfaces: cookie sessions for the browser
// flow, PAT bearer for the agent/CLI path (#184).
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

// Mongo ObjectId hex; validated before any query so a garbage id is a 400/404,
// never a driver error.
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

const evalModels = () =>
  resolveScheduledModels({
    models: config.evals.models,
    model: process.env.TOVA_EVAL_MODEL,
    provider: process.env.TOVA_EVAL_PROVIDER,
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

/*
 * Manual "Run now" (Decision 7): writes the `running` lease, then runs the
 * suite in the background so the request returns immediately (the suite drives
 * live providers and can take minutes). The busy guard rejects a second run
 * with 409 (Decision 6); a crash is recorded on the rollup, not here.
 */
router.post('/evals/run', ...adminGuard, async (_req, res) => {
  const options = { models: evalModels(), trigger: 'manual' as const };
  try {
    const id = await beginEvalRun(options);
    void executeEvalRun(id, options).catch(() => {
      // The run settles its own `error` row; nothing to surface post-202.
    });
    return res.status(202).json({ id });
  } catch (error) {
    if (error instanceof EvalRunBusyError) {
      return res.status(409).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Failed to start eval run' });
  }
});

export default router;
