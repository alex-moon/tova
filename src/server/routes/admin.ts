import express from 'express';
import mongoose from 'mongoose';
import { User, UserDocument } from '../models/User';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { AdminUser } from '../../shared/contracts';
import { ProviderRouting } from '../models/ProviderRouting';
import { ModelMetricStat } from '../models/ModelMetricStat';
import { getLogs, LogLevel } from '../services/logService';
import {
  MAX_COMPARE_MODELS,
  runModelComparison,
  type CompareModelRef,
} from '../services/modelCompare';
import { Entity, LOW_CONFIDENCE } from '../models/Entity';
import { EntityEdge } from '../models/EntityEdge';
import type {
  AdminGraphEdge,
  AdminGraphEntity,
  AdminGraphEntityDetail,
  AdminGraphEntitiesPayload,
  AdminGraphSourceRef,
} from '../../shared/contracts';

const router = express.Router();

const adminGuard = [authenticate, requireRole('admin')];

const KNOWN_PERMISSIONS = ['routing'] as const;

// Owner-protected account: cannot be demoted at all (issue #15, owner
// decision 2026-09-11). Module-level constant so a future env/config
// move is a one-line change.
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

/*
 * Model inventory with CRUD (issue #104). Each row is one `providerroutings`
 * document (a provider/model pair can repeat across tiers); `stats` carries
 * the feedback tallies captured in ModelMetricStat for the model name.
 * Read errors degrade to empty lists; the view shows a 'no data' state.
 */
const PROVIDER_SET = ['groq', 'deepinfra'] as const;
const TIER_SET = ['small', 'large', 'guard'] as const;

type ProviderRow = {
  provider: string;
  model: string;
  tier: string;
  eligible: boolean;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
  _id: mongoose.Types.ObjectId;
};

interface ModelMutation {
  model?: string;
  tier?: string;
  provider?: string;
  eligible?: boolean;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number | null;
}

const isProvided = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && v !== false;

/*
 * Validates a create/update payload against the ProviderRouting schema and
 * returns just the whitelisted fields, or a 400 message. `forUpdate` only
 * rejects fields in the payload; omitted fields mean "leave unchanged".
 */
const validateModelMutation = (
  body: unknown,
  forUpdate: boolean,
): ModelMutation | { error: string } => {
  if (!body || typeof body !== 'object') {
    return { error: 'Body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const out: ModelMutation = {};
  if (b.provider !== undefined) {
    if (typeof b.provider !== 'string' || !PROVIDER_SET.includes(b.provider as 'groq')) {
      return { error: 'Invalid provider' };
    }
    out.provider = b.provider;
  } else if (!forUpdate) {
    return { error: 'provider is required' };
  }
  if (b.model !== undefined) {
    if (typeof b.model !== 'string' || !b.model.trim()) return { error: 'Invalid model' };
    out.model = b.model.trim();
  } else if (!forUpdate) {
    return { error: 'model is required' };
  }
  if (b.tier !== undefined) {
    if (typeof b.tier !== 'string' || !TIER_SET.includes(b.tier as 'small')) {
      return { error: 'Invalid tier' };
    }
    out.tier = b.tier;
  } else if (!forUpdate) {
    return { error: 'tier is required' };
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
    // `null` (not `undefined`) so mongoose passes the clear through: update
    // casting silently drops undefined keys.
    out.contextLength = null;
  }
  if (forUpdate) {
    const allowed = new Set([
      'provider',
      'model',
      'tier',
      'eligible',
      'tools',
      'vision',
      'contextLength',
    ]);
    if (Object.keys(b).some((k) => !allowed.has(k))) {
      return { error: 'Unknown field' };
    }
  }
  return out;
};

const duplicateModelError = (err: unknown): boolean =>
  err instanceof mongoose.mongo.MongoServerError && err.code === 11000;

router.get('/models', ...adminGuard, async (_req, res) => {
  try {
    const [routes, stats] = await Promise.all([
      ProviderRouting.find({}).lean(),
      ModelMetricStat.find({}).lean(),
    ]);
    const statMap = new Map<string, { band: string; up: number; down: number }[]>();
    for (const stat of stats as { band: string; modelName: string; up: number; down: number }[]) {
      const list = statMap.get(stat.modelName) ?? [];
      list.push({ band: stat.band, up: stat.up ?? 0, down: stat.down ?? 0 });
      statMap.set(stat.modelName, list);
    }
    res.json(
      ((routes ?? []) as unknown as ProviderRow[]).map((route) => ({
        id: String(route._id),
        provider: route.provider,
        model: route.model,
        tier: route.tier,
        eligible: route.eligible,
        tools: route.tools !== false,
        vision: route.vision === true,
        contextLength: route.contextLength,
        stats: [...(statMap.get(route.model) ?? [])],
      })),
    );
  } catch (_err) {
    res.status(500).json({ message: 'Error listing models' });
  }
});

router.post('/models', ...adminGuard, async (req, res) => {
  const payload = validateModelMutation(req.body, false);
  if ('error' in payload) {
    return res.status(400).json({ message: payload.error });
  }
  try {
    const doc = await ProviderRouting.create({
      provider: payload.provider,
      model: payload.model,
      tier: payload.tier,
      ...(payload.eligible !== undefined ? { eligible: payload.eligible } : {}),
      ...(payload.tools !== undefined ? { tools: payload.tools } : {}),
      ...(payload.vision !== undefined ? { vision: payload.vision } : {}),
      ...(payload.contextLength !== undefined ? { contextLength: payload.contextLength } : {}),
    });
    res.status(201).json({ id: doc.id });
  } catch (err) {
    if (duplicateModelError(err)) {
      return res.status(409).json({ message: 'A routing row already exists for this model' });
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
    const doc = await ProviderRouting.findByIdAndUpdate(id, payload, { new: true });
    if (!doc) return res.status(404).json({ message: 'Model not found' });
    res.json({ id: doc.id });
  } catch (err) {
    if (duplicateModelError(err)) {
      return res.status(409).json({ message: 'A routing row already exists for this model' });
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
    const doc = await ProviderRouting.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: 'Model not found' });
    res.status(204).end();
  } catch (_err) {
    res.status(500).json({ message: 'Error deleting model' });
  }
});

// Issue #129: direct model comparison — one prompt through the existing
// agent on chosen routing rows. Shares `runModelComparison` with the
// one-off CLI (`scripts/eval-model-compare.ts`) so both lanes exercise the
// identical agent path; see services/modelCompare.ts.
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
    if (typeof m.provider !== 'string' || !PROVIDER_SET.includes(m.provider as 'groq')) {
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
      provider: m.provider as 'groq',
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

/*
 * Per-user entity graph read view (issue #138, plan task 5): list a user's
 * nodes with pagination, and fetch one node's detail with the edges touching
 * it (either direction) and the other endpoint's name resolved. Every list
 * item/detail carries `sourceRefs` back into the originating session/message
 * so each inferred fact is auditable. Read-only; writes come from the
 * extraction service, never from this tab.
 */
const toGraphSourceRefs = (refs: mongoose.AnyObject[]): AdminGraphSourceRef[] =>
  refs.map((r) => ({
    sessionId: String(r.sessionId),
    ...(r.messageId ? { messageId: String(r.messageId) } : {}),
  }));

const toGraphEntity = (e: mongoose.AnyObject): AdminGraphEntity => ({
  id: String(e._id),
  userId: String(e.userId),
  name: e.name,
  kind: e.kind,
  ...(e.summary ? { summary: e.summary } : {}),
  mentionCount: e.mentionCount ?? 1,
  confidence: e.confidence ?? LOW_CONFIDENCE,
  salience: e.salience === 'high' ? 'high' : 'low',
  lastMentionedAt: new Date(e.lastMentionedAt).toISOString(),
  sourceRefs: toGraphSourceRefs(e.sourceRefs ?? []),
});

router.get(
  '/graph/entities',
  ...adminGuard,
  async (req: express.Request, res: express.Response) => {
    const userId = req.query.userId as string | undefined;
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'userId is required' });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    try {
      const filter = { userId: new mongoose.Types.ObjectId(userId) };
      const [docs, total] = await Promise.all([
        Entity.find(filter)
          // mentionCount tiebreak: same-millisecond mentions must paginate
          // deterministically (an unordered tie would flake between pages).
          .sort({ lastMentionedAt: -1, mentionCount: -1, normalizedName: 1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Entity.countDocuments(filter),
      ]);
      const payload: AdminGraphEntitiesPayload = {
        entities: docs.map((d) => toGraphEntity(d.toObject())),
        page,
        limit,
        total,
      };
      res.json(payload);
    } catch (_err) {
      res.status(500).json({ message: 'Error listing graph entities' });
    }
  },
);

router.get(
  '/graph/entities/:id',
  ...adminGuard,
  async (req: express.Request, res: express.Response) => {
    const id = String(req.params.id);
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ message: 'Entity not found' });
    }
    try {
      const entity = await Entity.findById(id);
      if (!entity) return res.status(404).json({ message: 'Entity not found' });
      const userId = entity.userId;
      const edges = await EntityEdge.find({
        userId,
        $or: [{ fromEntityId: id }, { toEntityId: id }],
      });
      const neighbours = await Entity.find({
        _id: {
          $in: [...new Set(edges.flatMap((e) => [e.fromEntityId, e.toEntityId]).map(String))],
        },
      })
        .select('name')
        .lean();
      const names = new Map<string, string>(
        neighbours.map((n: mongoose.AnyObject) => [String(n._id), n.name]),
      );
      const edgeList: AdminGraphEdge[] = edges.map((e) => ({
        id: e.id,
        kind: e.kind,
        ...(e.summary ? { summary: e.summary } : {}),
        fromEntityId: String(e.fromEntityId),
        toEntityId: String(e.toEntityId),
        fromName: names.get(String(e.fromEntityId)) ?? String(e.fromEntityId),
        toName: names.get(String(e.toEntityId)) ?? String(e.toEntityId),
        sourceRefs: toGraphSourceRefs(e.sourceRefs as mongoose.AnyObject[]),
      }));
      const payload: AdminGraphEntityDetail = {
        entity: toGraphEntity(entity.toObject()),
        edges: edgeList,
      };
      res.json(payload);
    } catch (_err) {
      res.status(500).json({ message: 'Error reading graph entity' });
    }
  },
);

// Issue #76: read-only tail of the in-memory log buffer for the admin
// logs view / API consumers. Supports incremental polling via cursor.
router.get('/logs', ...adminGuard, (req, res) => {
  const level = req.query.level as LogLevel | undefined;
  if (level !== undefined && !['info', 'warn', 'error'].includes(level)) {
    return res.status(400).json({ message: "level must be 'info', 'warn' or 'error'" });
  }
  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 1000 ? rawLimit : undefined;
  const rawCursor = Number(req.query.cursor);
  const cursor = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const { logs, nextCursor } = getLogs({ level, q, cursor, limit });
  res.json({ logs, nextCursor });
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
