import express from 'express';
import mongoose from 'mongoose';
import { User, UserDocument } from '../models/User';
import { authenticateBearerOrSession, requireRole, AuthRequest } from '../middleware/auth';
import { AdminUser } from '@tova/shared';
import { ModelRoster } from '../models/ModelRoster';
import { ModelRouteError } from '../models/ModelRouteError';
import { LogLevel } from '../services/logService';
import { queryRetainedLogs } from '../services/lokiLogs';
import {
  MAX_COMPARE_MODELS,
  runModelComparison,
  type CompareModelRef,
} from '../services/modelCompare';
import { lookupProviderModel, type LookupProvider } from '../services/providerModelLookup';
import type { AdminModelLookup } from '@tova/shared';

const router = express.Router();

// Bearer PATs and cookie sessions both pass through the first leg.
// @see #184
const adminGuard = [authenticateBearerOrSession, requireRole('admin')];

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

/* Model inventory CRUD: one modelrosters doc per row, providers[] list. */
// @see #104 #234
// The racing path only talks to the roster providers; compare-only extras.
// @see #232 #151
const ROSTER_PROVIDER_SET = ['deepinfra', 'fireworks'] as const;
// Compare still accepts the legacy provider set for historic rows.
// @see #151
const PROVIDER_SET = ['groq', 'deepinfra', 'fireworks', 'typesafe'] as const;
type CompareProvider = (typeof PROVIDER_SET)[number];

type ProviderEntry = {
  provider: string;
  modelId: string;
  enabled?: boolean;
  ttftMs?: number;
  ttftSamples?: number;
  ttftUpdatedAt?: Date;
  disabledUntil?: Date | null;
};

type RosterRow = {
  modelId: string;
  label: string;
  eligible: boolean;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  providers?: ProviderEntry[];
  _id: mongoose.Types.ObjectId;
};

interface ProviderMutation {
  provider: string;
  modelId: string;
  enabled?: boolean;
}

interface ModelMutation {
  modelId?: string;
  label?: string;
  eligible?: boolean;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  providers?: ProviderMutation[];
}

const isProvided = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && v !== false;

const isRosterProvider = (value: unknown): value is (typeof ROSTER_PROVIDER_SET)[number] =>
  typeof value === 'string' && (ROSTER_PROVIDER_SET as readonly string[]).includes(value);

/* Validate a provider entry ({provider, modelId, enabled?}); whitelist. */
const validateProviderEntry = (value: unknown): ProviderMutation | { error: string } => {
  if (!value || typeof value !== 'object') return { error: 'Invalid provider entry' };
  const p = value as Record<string, unknown>;
  if (!isRosterProvider(p.provider)) {
    return { error: `provider must be one of: ${ROSTER_PROVIDER_SET.join(', ')}` };
  }
  if (typeof p.modelId !== 'string' || !p.modelId.trim()) {
    return { error: 'providers[].modelId is required' };
  }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    return { error: 'providers[].enabled must be a boolean' };
  }
  return {
    provider: p.provider,
    modelId: p.modelId.trim(),
    ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
  };
};

/* Validate a payload against the ModelRoster schema; omit = unchanged. */
const validateModelMutation = (
  body: unknown,
  forUpdate: boolean,
): ModelMutation | { error: string } => {
  if (!body || typeof body !== 'object') {
    return { error: 'Body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const out: ModelMutation = {};
  if (b.modelId !== undefined) {
    if (typeof b.modelId !== 'string' || !b.modelId.trim()) return { error: 'Invalid modelId' };
    out.modelId = b.modelId.trim();
  } else if (!forUpdate) {
    return { error: 'modelId is required' };
  }
  if (b.label !== undefined) {
    if (typeof b.label !== 'string' || !b.label.trim()) return { error: 'Invalid label' };
    out.label = b.label.trim();
  } else if (!forUpdate) {
    // Label defaults to the model id so hand-added seeds need no name.
    out.label = (b.modelId as string | undefined)?.trim() ?? '';
  }
  if (b.eligible !== undefined) {
    if (typeof b.eligible !== 'boolean') return { error: 'eligible must be a boolean' };
    out.eligible = b.eligible;
  }
  for (const flag of ['tools', 'vision'] as const) {
    if (b[flag] !== undefined) {
      if (typeof b[flag] !== 'boolean') return { error: `${flag} must be a boolean` };
      out[flag] = b[flag];
    }
  }
  if (b.contextLength !== undefined && isProvided(b.contextLength)) {
    const n = Number(b.contextLength);
    if (!Number.isInteger(n) || n <= 0) return { error: 'Invalid contextLength' };
    out.contextLength = n;
  } else if (forUpdate && (b.contextLength === '' || b.contextLength === null)) {
    // `null` (not `undefined`) so mongoose passes the clear through.
    out.contextLength = null;
  }
  /* Prices: USD/1M tokens, non-negative; ''/null clears to unknown. */
  // @see #199 #234
  for (const field of ['inputPrice', 'outputPrice'] as const) {
    if (b[field] !== undefined && isProvided(b[field])) {
      const n = Number(b[field]);
      if (typeof b[field] === 'boolean' || !Number.isFinite(n) || n < 0) {
        return { error: `Invalid ${field}` };
      }
      out[field] = n;
    } else if (forUpdate && (b[field] === '' || b[field] === null)) {
      out[field] = null;
    }
  }
  if (b.providers !== undefined) {
    if (!Array.isArray(b.providers) || b.providers.length === 0) {
      return { error: 'providers must be a non-empty array' };
    }
    const providers: ProviderMutation[] = [];
    const seen = new Set<string>();
    for (const entry of b.providers) {
      const parsed = validateProviderEntry(entry);
      if ('error' in parsed) return { error: parsed.error };
      // Duplicate providers would double-target the TTFT update.
      if (seen.has(parsed.provider)) {
        return { error: `Duplicate provider entry: ${parsed.provider}` };
      }
      seen.add(parsed.provider);
      providers.push(parsed);
    }
    out.providers = providers;
  } else if (!forUpdate) {
    return { error: 'providers is required' };
  }
  if (forUpdate) {
    const allowed = new Set([
      'modelId',
      'label',
      'eligible',
      'tools',
      'vision',
      'contextLength',
      'inputPrice',
      'outputPrice',
      'providers',
    ]);
    if (Object.keys(b).some((k) => !allowed.has(k))) {
      return { error: 'Unknown field' };
    }
  }
  return out;
};

const toAdminModel = (row: RosterRow) => ({
  id: String(row._id),
  modelId: row.modelId,
  label: row.label,
  eligible: row.eligible !== false,
  tools: row.tools !== false,
  vision: row.vision === true,
  contextLength: row.contextLength,
  // Pricing USD/1M; undefined on unpriced models hides the key.
  // @see #199
  inputPrice: row.inputPrice,
  outputPrice: row.outputPrice,
  providers: (row.providers ?? []).map((p) => ({
    provider: p.provider,
    modelId: p.modelId,
    enabled: p.enabled !== false,
    // Exactly the rolling figure the router scores on.
    // @see #232
    ttftMs: p.ttftMs,
    ttftSamples: p.ttftSamples,
    ttftUpdatedAt: p.ttftUpdatedAt ? new Date(p.ttftUpdatedAt).toISOString() : undefined,
    // System-owned per-provider cool-off; absent/null = not cooling off.
    // @see #168
    disabledUntil: p.disabledUntil ? new Date(p.disabledUntil).toISOString() : null,
  })),
});

const duplicateModelError = (err: unknown): boolean =>
  err instanceof mongoose.mongo.MongoServerError && err.code === 11000;

router.get('/models', ...adminGuard, async (_req, res) => {
  try {
    // The admin table reads the roster plus the error tally.
    // @see #234 #175
    const [roster, routeErrors] = await Promise.all([
      ModelRoster.find({}).lean(),
      // Completion failures are recorded by inferenceService alone.
      // @see #168 #175
      ModelRouteError.find({}).sort({ lastSeenAt: -1 }).lean(),
    ]);
    res.json({
      models: ((roster ?? []) as unknown as RosterRow[]).map(toAdminModel),
      // Diagnostics keyed provider+model.
      // @see #168
      errors: (
        (routeErrors ?? []) as unknown as {
          provider: string;
          model: string;
          status?: number | null;
          category: string;
          count: number;
          lastMessage?: string | null;
          lastSeenAt: Date;
        }[]
      ).map((row) => ({
        provider: row.provider,
        model: row.model,
        status: row.status ?? null,
        category: row.category,
        count: row.count ?? 0,
        lastMessage: row.lastMessage ?? '',
        lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      })),
    });
  } catch (_err) {
    res.status(500).json({ message: 'Error listing models' });
  }
});

/* Resolve provider details from the catalog; miss is 200, failure 502. */
// @see #217 #234
const LOOKUP_PROVIDERS = ['deepinfra', 'fireworks'] as const;

const isLookupProvider = (value: string): value is LookupProvider =>
  (LOOKUP_PROVIDERS as readonly string[]).includes(value);

router.get('/model-lookup', ...adminGuard, async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
  const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
  if (!isLookupProvider(provider)) {
    return res
      .status(400)
      .json({ message: `provider must be one of: ${LOOKUP_PROVIDERS.join(', ')}` });
  }
  if (!model) {
    return res.status(400).json({ message: 'model is required' });
  }
  try {
    const details = await lookupProviderModel(provider, model);
    const payload: AdminModelLookup = details ? { found: true, ...details } : { found: false };
    res.json(payload);
  } catch (err) {
    res.status(502).json({
      message: err instanceof Error ? err.message : 'Provider lookup failed',
    });
  }
});

router.post('/models', ...adminGuard, async (req, res) => {
  const payload = validateModelMutation(req.body, false);
  if ('error' in payload) {
    return res.status(400).json({ message: payload.error });
  }
  try {
    const doc = await ModelRoster.create({
      modelId: payload.modelId,
      label: payload.label,
      ...(payload.eligible !== undefined ? { eligible: payload.eligible } : {}),
      ...(payload.tools !== undefined ? { tools: payload.tools } : {}),
      ...(payload.vision !== undefined ? { vision: payload.vision } : {}),
      ...(payload.contextLength !== undefined ? { contextLength: payload.contextLength } : {}),
      ...(payload.inputPrice !== undefined && payload.inputPrice !== null
        ? { inputPrice: payload.inputPrice }
        : {}),
      ...(payload.outputPrice !== undefined && payload.outputPrice !== null
        ? { outputPrice: payload.outputPrice }
        : {}),
      providers: (payload.providers ?? []).map((p) => ({
        provider: p.provider,
        modelId: p.modelId,
        enabled: p.enabled ?? true,
        disabledUntil: null,
      })),
    });
    res.status(201).json({ id: doc.id });
  } catch (err) {
    if (duplicateModelError(err)) {
      return res.status(409).json({ message: 'A roster model already exists for this modelId' });
    }
    res.status(500).json({ message: 'Error creating model' });
  }
});

router.put('/models/:id', ...adminGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Model not found' });
  }
  const payload = validateModelMutation(req.body, true);
  if ('error' in payload) {
    return res.status(400).json({ message: payload.error });
  }
  try {
    /* Providers merge on the key: modelId/enabled replaced, TTFT kept. */
    const set: Record<string, unknown> = {};
    for (const field of [
      'modelId',
      'label',
      'eligible',
      'tools',
      'vision',
      'contextLength',
      'inputPrice',
      'outputPrice',
    ] as const) {
      if (payload[field] !== undefined) set[field] = payload[field];
    }
    const update: Record<string, unknown> = { $set: set };
    if (payload.providers) {
      const existing = (await ModelRoster.findById(id).lean()) as unknown as RosterRow | null;
      if (!existing) return res.status(404).json({ message: 'Model not found' });
      const byProvider = new Map((existing.providers ?? []).map((p) => [p.provider, p]));
      update.providers = payload.providers.map((p) => {
        const prior = byProvider.get(p.provider);
        return {
          provider: p.provider,
          modelId: p.modelId,
          enabled: p.enabled ?? prior?.enabled ?? true,
          ttftMs: prior?.ttftMs,
          ttftSamples: prior?.ttftSamples,
          ttftUpdatedAt: prior?.ttftUpdatedAt,
          disabledUntil: prior?.disabledUntil ?? null,
        };
      });
    }
    const doc = await ModelRoster.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ message: 'Model not found' });
    res.json({ id: doc.id });
  } catch (err) {
    if (duplicateModelError(err)) {
      return res.status(409).json({ message: 'A roster model already exists for this modelId' });
    }
    res.status(500).json({ message: 'Error updating model' });
  }
});

router.delete('/models/:id', ...adminGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ message: 'Model not found' });
  }
  try {
    const doc = await ModelRoster.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: 'Model not found' });
    res.status(204).end();
  } catch (_err) {
    res.status(500).json({ message: 'Error deleting model' });
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
