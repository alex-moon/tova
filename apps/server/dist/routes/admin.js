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
exports.PROTECTED_OWNER_EMAIL = void 0;
const express_1 = __importDefault(require("express"));
const mongoose_1 = __importDefault(require("mongoose"));
const User_1 = require("../models/User");
const auth_1 = require("../middleware/auth");
const ModelRoster_1 = require("../models/ModelRoster");
const ModelRouteError_1 = require("../models/ModelRouteError");
const lokiLogs_1 = require("../services/lokiLogs");
const modelCompare_1 = require("../services/modelCompare");
const Entity_1 = require("../models/Entity");
const EntityEdge_1 = require("../models/EntityEdge");
const providerModelLookup_1 = require("../services/providerModelLookup");
const router = express_1.default.Router();
// Bearer PATs (#184) and cookie sessions both pass through the first leg.
const adminGuard = [auth_1.authenticateBearerOrSession, (0, auth_1.requireRole)('admin')];
const KNOWN_PERMISSIONS = ['routing'];
// Owner-protected account: cannot be demoted at all (issue #15, owner
// decision 2026-09-11). Module-level constant so a future env/config
// move is a one-line change.
exports.PROTECTED_OWNER_EMAIL = 'formsatz@gmail.com';
const toPublicUser = (user) => ({
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    hasGoogle: user.googleId != null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
});
const findUserOr404 = (id, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (!mongoose_1.default.isValidObjectId(id)) {
        res.status(404).json({ message: 'User not found' });
        return null;
    }
    const user = yield User_1.User.findById(id);
    if (!user) {
        res.status(404).json({ message: 'User not found' });
        return null;
    }
    return user;
});
router.get('/users', ...adminGuard, (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const users = yield User_1.User.find({});
        res.json(users.map(toPublicUser));
    }
    catch (_err) {
        res.status(500).json({ message: 'Error listing users' });
    }
}));
/*
 * Model inventory with CRUD (issue #104, reworked onto the roster in #234).
 * Each row is ONE `modelrosters` document: a model registered once with a
 * paired `providers[]` list (two serverless backends). Read errors degrade to
 * empty lists; the view shows a 'no data' state.
 */
// #232: the racing path only talks to the two roster providers. `typesafe`
// rides along in compare (#151) but is not a roster provider.
const ROSTER_PROVIDER_SET = ['deepinfra', 'fireworks'];
// Compare still accepts the legacy provider set so historic rows remain
// runnable (#151 keeps `typesafe` reachable ahead of its connector).
const PROVIDER_SET = ['groq', 'deepinfra', 'fireworks', 'typesafe'];
const isProvided = (v) => v !== undefined && v !== null && v !== '' && v !== false;
const isRosterProvider = (value) => typeof value === 'string' && ROSTER_PROVIDER_SET.includes(value);
/*
 * Validate a provider entry (`{provider, modelId, enabled?}`). Returns the
 * whitelisted entry or an error string. `enabled` is optional (defaults true
 * on create); it is a boolean when present.
 */
const validateProviderEntry = (value) => {
    if (!value || typeof value !== 'object')
        return { error: 'Invalid provider entry' };
    const p = value;
    if (!isRosterProvider(p.provider)) {
        return { error: `provider must be one of: ${ROSTER_PROVIDER_SET.join(', ')}` };
    }
    if (typeof p.modelId !== 'string' || !p.modelId.trim()) {
        return { error: 'providers[].modelId is required' };
    }
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
        return { error: 'providers[].enabled must be a boolean' };
    }
    return Object.assign({ provider: p.provider, modelId: p.modelId.trim() }, (p.enabled !== undefined ? { enabled: p.enabled } : {}));
};
/*
 * Validates a create/update payload against the ModelRoster schema and
 * returns just the whitelisted fields, or a 400 message. `forUpdate` only
 * rejects fields in the payload; omitted fields mean "leave unchanged".
 */
const validateModelMutation = (body, forUpdate) => {
    var _a, _b;
    if (!body || typeof body !== 'object') {
        return { error: 'Body must be an object' };
    }
    const b = body;
    const out = {};
    if (b.modelId !== undefined) {
        if (typeof b.modelId !== 'string' || !b.modelId.trim())
            return { error: 'Invalid modelId' };
        out.modelId = b.modelId.trim();
    }
    else if (!forUpdate) {
        return { error: 'modelId is required' };
    }
    if (b.label !== undefined) {
        if (typeof b.label !== 'string' || !b.label.trim())
            return { error: 'Invalid label' };
        out.label = b.label.trim();
    }
    else if (!forUpdate) {
        // A label is required by the schema; default it to the model id so an
        // operator adding the seed models by hand is not forced to name them.
        out.label = (_b = (_a = b.modelId) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : '';
    }
    if (b.eligible !== undefined) {
        if (typeof b.eligible !== 'boolean')
            return { error: 'eligible must be a boolean' };
        out.eligible = b.eligible;
    }
    for (const flag of ['tools', 'vision']) {
        if (b[flag] !== undefined) {
            if (typeof b[flag] !== 'boolean')
                return { error: `${flag} must be a boolean` };
            out[flag] = b[flag];
        }
    }
    if (b.contextLength !== undefined && isProvided(b.contextLength)) {
        const n = Number(b.contextLength);
        if (!Number.isInteger(n) || n <= 0)
            return { error: 'Invalid contextLength' };
        out.contextLength = n;
    }
    else if (forUpdate && (b.contextLength === '' || b.contextLength === null)) {
        // `null` (not `undefined`) so mongoose passes the clear through: update
        // casting silently drops undefined keys.
        out.contextLength = null;
    }
    /*
     * #199 prices: USD per 1M tokens, non-negative finite numbers (not
     * integers — sub-cent rates like $0.085 are legal). `''`/`null` clears the
     * field back to "unknown", mirroring the contextLength branch. Price is now
     * a soft weighted-score input (#234 OQ4), not a hard cap.
     */
    for (const field of ['inputPrice', 'outputPrice']) {
        if (b[field] !== undefined && isProvided(b[field])) {
            const n = Number(b[field]);
            if (typeof b[field] === 'boolean' || !Number.isFinite(n) || n < 0) {
                return { error: `Invalid ${field}` };
            }
            out[field] = n;
        }
        else if (forUpdate && (b[field] === '' || b[field] === null)) {
            out[field] = null;
        }
    }
    if (b.providers !== undefined) {
        if (!Array.isArray(b.providers) || b.providers.length === 0) {
            return { error: 'providers must be a non-empty array' };
        }
        const providers = [];
        const seen = new Set();
        for (const entry of b.providers) {
            const parsed = validateProviderEntry(entry);
            if ('error' in parsed)
                return { error: parsed.error };
            // A duplicate provider would make the per-provider TTFT update target two
            // entries; reject so the roster stays one entry per provider.
            if (seen.has(parsed.provider)) {
                return { error: `Duplicate provider entry: ${parsed.provider}` };
            }
            seen.add(parsed.provider);
            providers.push(parsed);
        }
        out.providers = providers;
    }
    else if (!forUpdate) {
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
const toAdminModel = (row) => {
    var _a;
    return ({
        id: String(row._id),
        modelId: row.modelId,
        label: row.label,
        eligible: row.eligible !== false,
        tools: row.tools !== false,
        vision: row.vision === true,
        contextLength: row.contextLength,
        // #199 pricing (USD per 1M tokens); undefined on unpriced models, which
        // JSON drops so the client only sees the key when a price is known.
        inputPrice: row.inputPrice,
        outputPrice: row.outputPrice,
        providers: ((_a = row.providers) !== null && _a !== void 0 ? _a : []).map((p) => ({
            provider: p.provider,
            modelId: p.modelId,
            enabled: p.enabled !== false,
            // OQ3: exactly the rolling figure the router scores on — no client-side
            // recomputation, so operators see what `pickPrimary` sees.
            ttftMs: p.ttftMs,
            ttftSamples: p.ttftSamples,
            ttftUpdatedAt: p.ttftUpdatedAt ? new Date(p.ttftUpdatedAt).toISOString() : undefined,
            // #168: system-owned per-provider cool-off; absent/null = not cooling off.
            disabledUntil: p.disabledUntil ? new Date(p.disabledUntil).toISOString() : null,
        })),
    });
};
const duplicateModelError = (err) => err instanceof mongoose_1.default.mongo.MongoServerError && err.code === 11000;
router.get('/models', ...adminGuard, (_req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // #234: the admin table reads the roster (one row per model) + the #175
        // error tally. The tier-era feedback tallies are gone with the router.
        const [roster, routeErrors] = yield Promise.all([
            ModelRoster_1.ModelRoster.find({}).lean(),
            // #168 diagnostics, consolidated onto the #175 tally (OQ-7, decision
            // 2026-09-26): inferenceService records every completion failure into
            // `modelrouteerrors`, so the admin table reads that single mechanism —
            // most recent shapes first.
            ModelRouteError_1.ModelRouteError.find({}).sort({ lastSeenAt: -1 }).lean(),
        ]);
        res.json({
            models: (roster !== null && roster !== void 0 ? roster : []).map(toAdminModel),
            // #168 diagnostics, keyed provider+model.
            errors: (routeErrors !== null && routeErrors !== void 0 ? routeErrors : []).map((row) => {
                var _a, _b, _c;
                return ({
                    provider: row.provider,
                    model: row.model,
                    status: (_a = row.status) !== null && _a !== void 0 ? _a : null,
                    category: row.category,
                    count: (_b = row.count) !== null && _b !== void 0 ? _b : 0,
                    lastMessage: (_c = row.lastMessage) !== null && _c !== void 0 ? _c : '',
                    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
                });
            }),
        });
    }
    catch (_err) {
        res.status(500).json({ message: 'Error listing models' });
    }
}));
/*
 * #217/#234: resolve a model's provider-owned details from the provider
 * catalog so the admin can add a model without hand-entering context/prices.
 * DeepInfra reports context/prices/vision; Fireworks reports context/vision
 * but no prices. `found: false` with HTTP 200 is a normal answer; a
 * provider/network failure is a 502 so the client can tell "not hosted" from
 * "could not check".
 */
const LOOKUP_PROVIDERS = ['deepinfra', 'fireworks'];
const isLookupProvider = (value) => LOOKUP_PROVIDERS.includes(value);
router.get('/model-lookup', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
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
        const details = yield (0, providerModelLookup_1.lookupProviderModel)(provider, model);
        const payload = details ? Object.assign({ found: true }, details) : { found: false };
        res.json(payload);
    }
    catch (err) {
        res.status(502).json({
            message: err instanceof Error ? err.message : 'Provider lookup failed',
        });
    }
}));
router.post('/models', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const payload = validateModelMutation(req.body, false);
    if ('error' in payload) {
        return res.status(400).json({ message: payload.error });
    }
    try {
        const doc = yield ModelRoster_1.ModelRoster.create(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ modelId: payload.modelId, label: payload.label }, (payload.eligible !== undefined ? { eligible: payload.eligible } : {})), (payload.tools !== undefined ? { tools: payload.tools } : {})), (payload.vision !== undefined ? { vision: payload.vision } : {})), (payload.contextLength !== undefined ? { contextLength: payload.contextLength } : {})), (payload.inputPrice !== undefined && payload.inputPrice !== null
            ? { inputPrice: payload.inputPrice }
            : {})), (payload.outputPrice !== undefined && payload.outputPrice !== null
            ? { outputPrice: payload.outputPrice }
            : {})), { providers: ((_a = payload.providers) !== null && _a !== void 0 ? _a : []).map((p) => {
                var _a;
                return ({
                    provider: p.provider,
                    modelId: p.modelId,
                    enabled: (_a = p.enabled) !== null && _a !== void 0 ? _a : true,
                    disabledUntil: null,
                });
            }) }));
        res.status(201).json({ id: doc.id });
    }
    catch (err) {
        if (duplicateModelError(err)) {
            return res.status(409).json({ message: 'A roster model already exists for this modelId' });
        }
        res.status(500).json({ message: 'Error creating model' });
    }
}));
router.put('/models/:id', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const id = String(req.params.id);
    if (!mongoose_1.default.isValidObjectId(id)) {
        return res.status(404).json({ message: 'Model not found' });
    }
    const payload = validateModelMutation(req.body, true);
    if ('error' in payload) {
        return res.status(400).json({ message: payload.error });
    }
    try {
        /*
         * Providers are edited by merging on the provider key: an incoming entry
         * replaces `modelId`/`enabled` for that backend but preserves its rolling
         * TTFT and cool-off (operator edits must not wipe system-owned metrics).
         * A provider not named in the payload is left untouched.
         */
        const set = {};
        for (const field of [
            'modelId',
            'label',
            'eligible',
            'tools',
            'vision',
            'contextLength',
            'inputPrice',
            'outputPrice',
        ]) {
            if (payload[field] !== undefined)
                set[field] = payload[field];
        }
        const update = { $set: set };
        if (payload.providers) {
            const existing = (yield ModelRoster_1.ModelRoster.findById(id).lean());
            if (!existing)
                return res.status(404).json({ message: 'Model not found' });
            const byProvider = new Map(((_a = existing.providers) !== null && _a !== void 0 ? _a : []).map((p) => [p.provider, p]));
            update.providers = payload.providers.map((p) => {
                var _a, _b, _c;
                const prior = byProvider.get(p.provider);
                return {
                    provider: p.provider,
                    modelId: p.modelId,
                    enabled: (_b = (_a = p.enabled) !== null && _a !== void 0 ? _a : prior === null || prior === void 0 ? void 0 : prior.enabled) !== null && _b !== void 0 ? _b : true,
                    ttftMs: prior === null || prior === void 0 ? void 0 : prior.ttftMs,
                    ttftSamples: prior === null || prior === void 0 ? void 0 : prior.ttftSamples,
                    ttftUpdatedAt: prior === null || prior === void 0 ? void 0 : prior.ttftUpdatedAt,
                    disabledUntil: (_c = prior === null || prior === void 0 ? void 0 : prior.disabledUntil) !== null && _c !== void 0 ? _c : null,
                };
            });
        }
        const doc = yield ModelRoster_1.ModelRoster.findByIdAndUpdate(id, update, { new: true });
        if (!doc)
            return res.status(404).json({ message: 'Model not found' });
        res.json({ id: doc.id });
    }
    catch (err) {
        if (duplicateModelError(err)) {
            return res.status(409).json({ message: 'A roster model already exists for this modelId' });
        }
        res.status(500).json({ message: 'Error updating model' });
    }
}));
router.delete('/models/:id', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const id = String(req.params.id);
    if (!mongoose_1.default.isValidObjectId(id)) {
        return res.status(404).json({ message: 'Model not found' });
    }
    try {
        const doc = yield ModelRoster_1.ModelRoster.findByIdAndDelete(id);
        if (!doc)
            return res.status(404).json({ message: 'Model not found' });
        res.status(204).end();
    }
    catch (_err) {
        res.status(500).json({ message: 'Error deleting model' });
    }
}));
// Issue #129: direct model comparison — one prompt through the existing
// agent on chosen routing rows. Shares `runModelComparison` with the
// one-off CLI (`scripts/eval-model-compare.ts`) so both lanes exercise the
// identical agent path; see services/modelCompare.ts.
router.post('/model-compare', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const b = req.body;
    if (typeof (b === null || b === void 0 ? void 0 : b.prompt) !== 'string' || !b.prompt.trim()) {
        return res.status(400).json({ message: 'prompt is required' });
    }
    if (!Array.isArray(b.models) || b.models.length === 0 || b.models.length > modelCompare_1.MAX_COMPARE_MODELS) {
        return res.status(400).json({ message: `models must be 1–${modelCompare_1.MAX_COMPARE_MODELS} rows` });
    }
    const models = [];
    for (const entry of b.models) {
        if (!entry || typeof entry !== 'object') {
            return res.status(400).json({ message: 'Invalid model row' });
        }
        const m = entry;
        if (typeof m.provider !== 'string' || !PROVIDER_SET.includes(m.provider)) {
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
        models.push(Object.assign({ provider: m.provider, model: m.model.trim() }, (m.contextLength !== undefined ? { contextLength: Number(m.contextLength) } : {})));
    }
    try {
        const run = yield (0, modelCompare_1.runModelComparison)(b.prompt.trim(), models);
        res.json(run);
    }
    catch (_err) {
        res.status(500).json({ message: 'Error running model comparison' });
    }
}));
/*
 * Per-user entity graph read view (issue #138, plan task 5): list a user's
 * nodes with pagination, and fetch one node's detail with the edges touching
 * it (either direction) and the other endpoint's name resolved. Every list
 * item/detail carries `sourceRefs` back into the originating session/message
 * so each inferred fact is auditable. Read-only; writes come from the
 * extraction service, never from this tab.
 */
const toGraphSourceRefs = (refs) => refs.map((r) => (Object.assign({ sessionId: String(r.sessionId) }, (r.messageId ? { messageId: String(r.messageId) } : {}))));
const toGraphEntity = (e) => {
    var _a, _b, _c;
    return (Object.assign(Object.assign({ id: String(e._id), userId: String(e.userId), name: e.name, kind: e.kind }, (e.summary ? { summary: e.summary } : {})), { mentionCount: (_a = e.mentionCount) !== null && _a !== void 0 ? _a : 1, confidence: (_b = e.confidence) !== null && _b !== void 0 ? _b : Entity_1.LOW_CONFIDENCE, salience: e.salience === 'high' ? 'high' : 'low', lastMentionedAt: new Date(e.lastMentionedAt).toISOString(), sourceRefs: toGraphSourceRefs((_c = e.sourceRefs) !== null && _c !== void 0 ? _c : []) }));
};
router.get('/graph/entities', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const userId = req.query.userId;
    if (!userId || !mongoose_1.default.isValidObjectId(userId)) {
        return res.status(400).json({ message: 'userId is required' });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    try {
        const filter = { userId: new mongoose_1.default.Types.ObjectId(userId) };
        const [docs, total] = yield Promise.all([
            Entity_1.Entity.find(filter)
                // mentionCount tiebreak: same-millisecond mentions must paginate
                // deterministically (an unordered tie would flake between pages).
                .sort({ lastMentionedAt: -1, mentionCount: -1, normalizedName: 1 })
                .skip((page - 1) * limit)
                .limit(limit),
            Entity_1.Entity.countDocuments(filter),
        ]);
        const payload = {
            entities: docs.map((d) => toGraphEntity(d.toObject())),
            page,
            limit,
            total,
        };
        res.json(payload);
    }
    catch (_err) {
        res.status(500).json({ message: 'Error listing graph entities' });
    }
}));
router.get('/graph/entities/:id', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const id = String(req.params.id);
    if (!mongoose_1.default.isValidObjectId(id)) {
        return res.status(404).json({ message: 'Entity not found' });
    }
    try {
        const entity = yield Entity_1.Entity.findById(id);
        if (!entity)
            return res.status(404).json({ message: 'Entity not found' });
        const userId = entity.userId;
        const edges = yield EntityEdge_1.EntityEdge.find({
            userId,
            $or: [{ fromEntityId: id }, { toEntityId: id }],
        });
        const neighbours = yield Entity_1.Entity.find({
            _id: {
                $in: [...new Set(edges.flatMap((e) => [e.fromEntityId, e.toEntityId]).map(String))],
            },
        })
            .select('name')
            .lean();
        const names = new Map(neighbours.map((n) => [String(n._id), n.name]));
        const edgeList = edges.map((e) => {
            var _a, _b;
            return (Object.assign(Object.assign({ id: e.id, kind: e.kind }, (e.summary ? { summary: e.summary } : {})), { fromEntityId: String(e.fromEntityId), toEntityId: String(e.toEntityId), fromName: (_a = names.get(String(e.fromEntityId))) !== null && _a !== void 0 ? _a : String(e.fromEntityId), toName: (_b = names.get(String(e.toEntityId))) !== null && _b !== void 0 ? _b : String(e.toEntityId), sourceRefs: toGraphSourceRefs(e.sourceRefs) }));
        });
        const payload = {
            entity: toGraphEntity(entity.toObject()),
            edges: edgeList,
        };
        res.json(payload);
    }
    catch (_err) {
        res.status(500).json({ message: 'Error reading graph entity' });
    }
}));
// #179: retained logs from Grafana Cloud (hosted Loki), replacing the old
// in-memory buffer tail. One time-window page, newest first; filters are
// applied server-side after fetch (see services/lokiLogs.ts).
router.get('/logs', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const level = req.query.level;
    if (level !== undefined && !['info', 'warn', 'error'].includes(level)) {
        return res.status(400).json({ message: "level must be 'info', 'warn' or 'error'" });
    }
    const rawHours = Number(req.query.hours);
    const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : undefined;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const { logs, configured, error } = yield (0, lokiLogs_1.queryRetainedLogs)({ level, q, hours, limit });
    res.json(Object.assign({ logs, configured }, (error ? { error } : {})));
}));
router.put('/users/:id/permissions', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const permissions = (_a = req.body) === null || _a === void 0 ? void 0 : _a.permissions;
    if (!Array.isArray(permissions) ||
        permissions.some((p) => typeof p !== 'string' || !KNOWN_PERMISSIONS.includes(p))) {
        return res.status(400).json({ message: 'permissions must be an array of known permissions' });
    }
    try {
        const user = yield findUserOr404(String(req.params.id), res);
        if (!user)
            return;
        user.permissions = permissions;
        yield user.save();
        res.json(toPublicUser(user));
    }
    catch (_err) {
        res.status(500).json({ message: 'Error updating permissions' });
    }
}));
router.put('/users/:id/role', ...adminGuard, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const role = (_a = req.body) === null || _a === void 0 ? void 0 : _a.role;
    if (role !== 'user' && role !== 'admin') {
        return res.status(400).json({ message: "role must be 'user' or 'admin'" });
    }
    try {
        const user = yield findUserOr404(String(req.params.id), res);
        if (!user)
            return;
        if (user.role === 'admin' && role === 'user' && user.email === exports.PROTECTED_OWNER_EMAIL) {
            return res.status(400).json({ message: 'This account cannot be demoted' });
        }
        user.role = role;
        yield user.save();
        res.json(toPublicUser(user));
    }
    catch (_err) {
        res.status(500).json({ message: 'Error updating role' });
    }
}));
exports.default = router;
