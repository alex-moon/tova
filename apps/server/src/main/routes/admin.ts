import express from 'express';
import mongoose from 'mongoose';
import { User, UserDocument } from '../models/User';
import { adminGuard, AuthRequest } from '../middleware/auth';
import { AdminFixedModel, AdminModelError, AdminUser } from '@tova/shared';
import { ModelRouteError } from '../models/ModelRouteError';
import { CHAT_MODEL, TASK_MODEL, contextLengthFor } from '../services/model/modelDefaults';
import { wiredProviders } from '../services/inferenceService';
import { LogLevel } from '../services/logService';
import { queryRetainedLogs } from '../services/lokiLogs';
import {
  MAX_COMPARE_MODELS,
  runModelComparison,
  type CompareModelRef,
} from '../services/model/modelCompare';

const router = express.Router();

// Bearer PATs and cookie sessions both pass through the first leg.
// @see #184

const KNOWN_PERMISSIONS = ['routing'] as const;

// Owner-protected account: cannot be demoted; module-level singleton.
// @see #15
export const PROTECTED_OWNER_EMAIL = 'formsatz@gmail.com';

const toPublicUser = (user: UserDocument): AdminUser => ({
  id: user._id.toString(),
  email: user.email,
  role: user.role,
  permissions: user.permissions,
  hasGoogle: user.googleId != null,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const findUserOr404 = async (id: string, res: express.Response) => {
  if (!mongoose.isValidObjectId(id)) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  const user = await User.findById(id);
  if (!user) {
    res.status(404).json({ message: 'User not found' });
    return null;
  }
  return user;
};

router.get('/users', ...adminGuard, async (_req, res) => {
  try {
    const users = await User.find({});
    res.json(users.map(toPublicUser));
  } catch (_err) {
    res.status(500).json({ message: 'Error listing users' });
  }
});

/* Fixed serving models: read-only rows for the admin view. */
// @see #387
const fixedModel = (model: string): AdminFixedModel => ({
  model,
  provider: 'deepinfra',
  ...(contextLengthFor(model) !== undefined ? { contextLength: contextLengthFor(model) } : {}),
});
const FIXED_MODELS: AdminFixedModel[] = [fixedModel(CHAT_MODEL), fixedModel(TASK_MODEL)];

/* Compare still accepts the wired providers; one registry. */
// @see #151 #387 #398
const PROVIDER_SET = wiredProviders;
type CompareProvider = (typeof PROVIDER_SET)[number];

const toModelError = (row: Record<string, unknown>): AdminModelError => ({
  provider: String(row.provider),
  model: String(row.model),
  status: (row.status as number | null | undefined) ?? null,
  category: String(row.category),
  count: Number(row.count ?? 0),
  lastMessage: String(row.lastMessage ?? ''),
  lastSeenAt: new Date(row.lastSeenAt as Date).toISOString(),
});

router.get('/models', ...adminGuard, async (_req, res) => {
  try {
    // The fixed models plus the error tally; every completion path records
    // through inferenceService, compare and evals included. @see #398
    // @see #387 #168 #175
    const routeErrors = await ModelRouteError.find({}).sort({ lastSeenAt: -1 }).lean();
    res.json({
      models: FIXED_MODELS,
      errors: ((routeErrors ?? []) as unknown as Record<string, unknown>[]).map(toModelError),
    });
  } catch (_err) {
    res.status(500).json({ message: 'Error listing models' });
  }
});

// Direct model comparison: one prompt through the existing agent.
// @see #129
router.post('/model-compare', ...adminGuard, async (req, res) => {
  const b = req.body as { prompt?: unknown; models?: unknown };
  if (typeof b?.prompt !== 'string' || !b.prompt.trim()) {
    return res.status(400).json({ message: 'prompt is required' });
  }
  if (!Array.isArray(b.models) || b.models.length === 0 || b.models.length > MAX_COMPARE_MODELS) {
    return res.status(400).json({ message: `models must be 1–${MAX_COMPARE_MODELS} rows` });
  }
  const models: CompareModelRef[] = [];
  for (const entry of b.models) {
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ message: 'Invalid model row' });
    }
    const m = entry as { provider?: unknown; model?: unknown; contextLength?: unknown };
    if (typeof m.provider !== 'string' || !PROVIDER_SET.includes(m.provider as CompareProvider)) {
      return res.status(400).json({ message: 'Invalid provider' });
    }
    if (typeof m.model !== 'string' || !m.model.trim()) {
      return res.status(400).json({ message: 'Invalid model' });
    }
    if (m.contextLength !== undefined) {
      const n = Number(m.contextLength);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ message: 'Invalid contextLength' });
      }
    }
    models.push({
      provider: m.provider as CompareProvider,
      model: m.model.trim(),
      ...(m.contextLength !== undefined ? { contextLength: Number(m.contextLength) } : {}),
    });
  }
  try {
    const run = await runModelComparison(b.prompt.trim(), models);
    res.json(run);
  } catch (_err) {
    res.status(500).json({ message: 'Error running model comparison' });
  }
});

// Retained logs from Grafana Loki; one window page, newest first.
// @see #179
router.get('/logs', ...adminGuard, async (req, res) => {
  const level = req.query.level as LogLevel | undefined;
  if (level !== undefined && !['info', 'warn', 'error'].includes(level)) {
    return res.status(400).json({ message: "level must be 'info', 'warn' or 'error'" });
  }
  const rawHours = Number(req.query.hours);
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : undefined;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const { logs, configured, error } = await queryRetainedLogs({ level, q, hours, limit });
  res.json({ logs, configured, ...(error ? { error } : {}) });
});

router.put('/users/:id/permissions', ...adminGuard, async (req, res) => {
  const permissions = req.body?.permissions;
  if (
    !Array.isArray(permissions) ||
    permissions.some((p) => typeof p !== 'string' || !KNOWN_PERMISSIONS.includes(p as 'routing'))
  ) {
    return res.status(400).json({ message: 'permissions must be an array of known permissions' });
  }

  try {
    const user = await findUserOr404(String(req.params.id), res);
    if (!user) return;

    user.permissions = permissions;
    await user.save();
    res.json(toPublicUser(user));
  } catch (_err) {
    res.status(500).json({ message: 'Error updating permissions' });
  }
});

router.put('/users/:id/role', ...adminGuard, async (req: AuthRequest, res) => {
  const role = req.body?.role;
  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ message: "role must be 'user' or 'admin'" });
  }

  try {
    const user = await findUserOr404(String(req.params.id), res);
    if (!user) return;

    if (user.role === 'admin' && role === 'user' && user.email === PROTECTED_OWNER_EMAIL) {
      return res.status(400).json({ message: 'This account cannot be demoted' });
    }

    user.role = role;
    await user.save();
    res.json(toPublicUser(user));
  } catch (_err) {
    res.status(500).json({ message: 'Error updating role' });
  }
});

export default router;
