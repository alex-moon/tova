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
exports.disableRosterProvider = exports.recordTtft = exports.rosterModelsForTurn = exports.liveProviders = exports.listRoster = exports.pickPrimary = exports.rosterScore = exports.pricePenaltyK = exports.defaultTtftMs = exports.routingPrice = exports.ROSTER_SEED = exports.ROSTER_PROVIDERS = void 0;
const ModelRoster_1 = require("../models/ModelRoster");
/** Every provider the racing path can talk to. */
exports.ROSTER_PROVIDERS = ['deepinfra', 'fireworks'];
/*
 * Seed definition (owner-locked roster, verified live 2026-10-08). Kept here
 * as the single source of truth for both the migration and empty-collection
 * recovery, mirroring the SEED_ENTRIES discipline of `modelConfigService`.
 *
 * Constraints recorded in #232: every model >120B total params, serverless on
 * BOTH providers. MiniMax M3 is text-only on Fireworks
 * (`supports_image_input: false`), so it is excluded from image turns.
 */
exports.ROSTER_SEED = [
    {
        modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
        label: 'DeepSeek V4.1 Flash',
        tools: true,
        vision: true,
        contextLength: 1048576,
        inputPrice: 0.2,
        outputPrice: 0.6,
        providers: [
            {
                provider: 'deepinfra',
                modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
                inputPrice: 0.2,
                outputPrice: 0.6,
            },
            {
                provider: 'fireworks',
                modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
                inputPrice: 0.3,
                outputPrice: 1.2,
            },
        ],
    },
    {
        modelId: 'zai-org/GLM-5.3-Flash',
        label: 'GLM 5.3 Flash',
        tools: true,
        vision: true,
        contextLength: 1048576,
        inputPrice: 0.15,
        outputPrice: 0.5,
        providers: [
            {
                provider: 'deepinfra',
                modelId: 'zai-org/GLM-5.3-Flash',
                inputPrice: 0.15,
                outputPrice: 0.5,
            },
            {
                provider: 'fireworks',
                modelId: 'accounts/fireworks/models/glm-5p3-flash',
                inputPrice: 0.15,
                outputPrice: 0.5,
            },
        ],
    },
    {
        modelId: 'MiniMaxAI/MiniMax-M3',
        label: 'MiniMax M3',
        tools: true,
        // Text-only: Fireworks reports supports_image_input false; the
        // conservative reading excludes it from image turns (owner decision).
        vision: false,
        contextLength: 524288,
        inputPrice: 0.28,
        outputPrice: 1.1,
        providers: [
            {
                provider: 'deepinfra',
                modelId: 'MiniMaxAI/MiniMax-M3',
                inputPrice: 0.28,
                outputPrice: 1.1,
            },
            {
                provider: 'fireworks',
                modelId: 'accounts/fireworks/models/minimax-m3',
                inputPrice: 0.3,
                outputPrice: 1.2,
            },
        ],
    },
];
/*
 * Summed routing price for a ref, or `undefined` when either component is
 * missing (#199). Unknown is deliberately distinct from 0: a half-priced model
 * is not treated as cheap. Moved here with the roster (#233); the tier-era
 * config service that used to own it is gone. Non-finite components also read
 * as unknown so a `NaN` can never slip past a comparison.
 */
const routingPrice = (ref) => {
    const { inputPrice, outputPrice } = ref;
    if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice))
        return undefined;
    return inputPrice + outputPrice;
};
exports.routingPrice = routingPrice;
/* ----------------------------------------------------------------------------
 * Weighted score (owner decision OQ3): score = f(TTFT) * price penalty.
 * Lower is better. Env-tunable so the relative influence can be measured
 * before it is fixed (TTFT and price are not reliably inverse — provider load
 * dominates TTFT far more than parameter count).
 * ------------------------------------------------------------------------- */
/*
 * Neutral TTFT used when a provider has no observation yet: the roster is
 * raced from the first turn, and an unpriced/unmeasured provider must be
 * neither starved nor favoured. Default 1000ms — roughly a mid-range
 * first-token latency for these frontier Flash models.
 */
const defaultTtftMs = () => {
    const raw = process.env.ROSTER_DEFAULT_TTFT_MS;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
};
exports.defaultTtftMs = defaultTtftMs;
/*
 * Price-penalty slope `k` in `penalty = 1 + k * price`. The summed (in+out)
 * price is in USD/1Mtok; with a small `k` (default 0.1) a price difference of
 * $1/mtok shifts the score by 10% of TTFT, so price breaks near-ties without
 * overwhelming a genuine latency gap. Env-tunable.
 */
const pricePenaltyK = () => {
    const raw = process.env.ROSTER_PRICE_PENALTY_K;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.1;
};
exports.pricePenaltyK = pricePenaltyK;
/*
 * Weighted score for one roster model: `f(TTFT) * (1 + k * price)`. Missing
 * TTFT uses the neutral default; missing/partial price uses a neutral price of
 * 0 (penalty 1), so an unmeasured model is scored purely on latency and is
 * neither penalised nor advantaged for unknown price (mirrors #199's
 * "unknown ≠ free" stance: it is simply not a differentiator).
 */
const rosterScore = (input) => {
    var _a;
    const ttft = Number.isFinite(input.ttftMs) && input.ttftMs >= 0
        ? input.ttftMs
        : (0, exports.defaultTtftMs)();
    const price = (_a = (0, exports.routingPrice)(input)) !== null && _a !== void 0 ? _a : 0;
    return ttft * (1 + (0, exports.pricePenaltyK)() * price);
};
exports.rosterScore = rosterScore;
/*
 * The best TTFT observed across a model's enabled providers — the latency
 * signal that matters for the primary pick (the race will use the fastest
 * healthy backend anyway, so the model's effective latency is its best one).
 */
const bestTtft = (model) => {
    const values = model.providers
        .filter((p) => p.ttftMs !== undefined && Number.isFinite(p.ttftMs))
        .map((p) => p.ttftMs);
    return values.length ? Math.min(...values) : undefined;
};
/*
 * Pick the primary model by the weighted score over last-known TTFT and price
 * (owner decision). Ties keep roster order (stable) — the seed order is the
 * owner's preference ranking.
 */
const pickPrimary = (models) => {
    if (models.length === 0)
        return null;
    let best = models[0];
    let bestScore = (0, exports.rosterScore)({
        ttftMs: bestTtft(best),
        inputPrice: best.inputPrice,
        outputPrice: best.outputPrice,
    });
    for (const model of models.slice(1)) {
        const score = (0, exports.rosterScore)({
            ttftMs: bestTtft(model),
            inputPrice: model.inputPrice,
            outputPrice: model.outputPrice,
        });
        if (score < bestScore) {
            best = model;
            bestScore = score;
        }
    }
    return best;
};
exports.pickPrimary = pickPrimary;
/* ----------------------------------------------------------------------------
 * Reads / writes
 * ------------------------------------------------------------------------- */
const isCoolingOff = (entry, now) => entry.disabledUntil instanceof Date && entry.disabledUntil.getTime() > now.getTime();
const toRosterModel = (doc) => {
    var _a;
    return (Object.assign(Object.assign(Object.assign(Object.assign({ modelId: doc.modelId, label: doc.label, tools: doc.tools !== false, vision: doc.vision === true }, (doc.contextLength !== undefined ? { contextLength: doc.contextLength } : {})), (doc.inputPrice !== undefined ? { inputPrice: doc.inputPrice } : {})), (doc.outputPrice !== undefined ? { outputPrice: doc.outputPrice } : {})), { providers: ((_a = doc.providers) !== null && _a !== void 0 ? _a : []).map((p) => {
            var _a;
            return (Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ provider: p.provider, modelId: p.modelId }, (p.inputPrice !== undefined ? { inputPrice: p.inputPrice } : {})), (p.outputPrice !== undefined ? { outputPrice: p.outputPrice } : {})), (p.ttftMs !== undefined ? { ttftMs: p.ttftMs } : {})), (p.ttftSamples !== undefined ? { ttftSamples: p.ttftSamples } : {})), { disabledUntil: (_a = p.disabledUntil) !== null && _a !== void 0 ? _a : null }));
        }) }));
};
const ensureSeed = () => __awaiter(void 0, void 0, void 0, function* () {
    yield Promise.all(exports.ROSTER_SEED.map((model) => ModelRoster_1.ModelRoster.updateOne({ modelId: model.modelId }, {
        $setOnInsert: Object.assign(Object.assign(Object.assign(Object.assign({ modelId: model.modelId, label: model.label, tools: model.tools, vision: model.vision }, (model.contextLength !== undefined ? { contextLength: model.contextLength } : {})), (model.inputPrice !== undefined ? { inputPrice: model.inputPrice } : {})), (model.outputPrice !== undefined ? { outputPrice: model.outputPrice } : {})), { eligible: true, providers: model.providers.map((p) => (Object.assign(Object.assign(Object.assign({ provider: p.provider, modelId: p.modelId, enabled: true }, (p.inputPrice !== undefined ? { inputPrice: p.inputPrice } : {})), (p.outputPrice !== undefined ? { outputPrice: p.outputPrice } : {})), { disabledUntil: null }))) }),
    }, { upsert: true })));
});
/*
 * Read the eligible roster, ordered as seeded (the seed order is the owner's
 * preference ranking; ties in the weighted score keep it). A DB read failure
 * falls back to the seed definition so a broken config read never takes chat
 * down; an EMPTY collection is seeded first (empty-pool recovery, mirroring
 * `listByTier`).
 */
const listRoster = () => __awaiter(void 0, void 0, void 0, function* () {
    try {
        let docs = (yield ModelRoster_1.ModelRoster.find({ eligible: true }).lean());
        if (docs.length === 0) {
            yield ensureSeed();
            docs = (yield ModelRoster_1.ModelRoster.find({ eligible: true }).lean());
            if (docs.length === 0)
                return exports.ROSTER_SEED;
        }
        // Preserve seed order: the collection is queried unordered, so sort by the
        // seed index. Unknown rows (admin-added) land after the known ones.
        const order = new Map(exports.ROSTER_SEED.map((m, i) => [m.modelId, i]));
        docs.sort((a, b) => { var _a, _b; return ((_a = order.get(a.modelId)) !== null && _a !== void 0 ? _a : 99) - ((_b = order.get(b.modelId)) !== null && _b !== void 0 ? _b : 99); });
        return docs.map(toRosterModel);
    }
    catch (err) {
        console.error('ModelRoster read/seed error:', err);
        return exports.ROSTER_SEED;
    }
});
exports.listRoster = listRoster;
/*
 * The enabled, non-cooling-off providers of a model — the set the runtime
 * actually races. `hasImage` restricts to vision-capable models upstream (see
 * `rosterModelsForTurn`), but a provider entry may still be cooling off.
 */
const liveProviders = (model, now = new Date()) => model.providers.filter((p) => !isCoolingOff(p, now));
exports.liveProviders = liveProviders;
/*
 * Roster candidates for a turn: eligible models that still have at least one
 * live provider. Image turns keep only `vision: true` models (MiniMax M3 is
 * text-only and is excluded). The weighted primary is picked from these.
 */
const rosterModelsForTurn = (roster, hasImage, now = new Date()) => roster
    .filter((model) => (hasImage ? model.vision : true))
    .map((model) => (Object.assign(Object.assign({}, model), { providers: (0, exports.liveProviders)(model, now) })))
    .filter((model) => model.providers.length > 0);
exports.rosterModelsForTurn = rosterModelsForTurn;
/*
 * Record a winning TTFT observation as a rolling mean. The Mongo pipeline
 * update keeps the mean in the database (no read-modify-write race between
 * concurrent turns): newMean = (oldMean*oldSamples + ttft) / (oldSamples + 1).
 * A provider entry with no prior samples treats the old mean as 0 and old
 * samples as 0, so the first observation is exact.
 */
const recordTtft = (modelId, provider, ttftMs) => __awaiter(void 0, void 0, void 0, function* () {
    if (!Number.isFinite(ttftMs) || ttftMs < 0)
        return;
    try {
        yield ModelRoster_1.ModelRoster.updateOne({ modelId, 'providers.provider': provider }, [
            {
                $set: {
                    providers: {
                        $map: {
                            input: '$providers',
                            as: 'p',
                            in: {
                                $cond: [
                                    { $eq: ['$$p.provider', provider] },
                                    {
                                        $mergeObjects: [
                                            '$$p',
                                            {
                                                ttftMs: {
                                                    $divide: [
                                                        {
                                                            $add: [
                                                                {
                                                                    $multiply: [
                                                                        { $ifNull: ['$$p.ttftMs', 0] },
                                                                        { $ifNull: ['$$p.ttftSamples', 0] },
                                                                    ],
                                                                },
                                                                ttftMs,
                                                            ],
                                                        },
                                                        { $add: [{ $ifNull: ['$$p.ttftSamples', 0] }, 1] },
                                                    ],
                                                },
                                                ttftSamples: { $add: [{ $ifNull: ['$$p.ttftSamples', 0] }, 1] },
                                                ttftUpdatedAt: '$$NOW',
                                                disabledUntil: null,
                                            },
                                        ],
                                    },
                                    '$$p',
                                ],
                            },
                        },
                    },
                },
            },
        ]);
    }
    catch (err) {
        // A metrics write must never fail the turn.
        console.error('ModelRoster TTFT write error:', err);
    }
});
exports.recordTtft = recordTtft;
/*
 * Per-provider cool-off, mirroring `disableModel` (#168/#213): `ttlMs`
 * overrides the default 6h for endpoint overload (#213 short TTL). Errors are
 * logged, not thrown — the cool-off rides alongside a real failure.
 */
const coolOffHours = () => {
    const raw = process.env.MODEL_COOL_OFF_HOURS;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
};
const disableRosterProvider = (modelId, provider, ttlMs) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const duration = ttlMs !== null && ttlMs !== void 0 ? ttlMs : coolOffHours() * 60 * 60 * 1000;
        yield ModelRoster_1.ModelRoster.updateOne({ modelId, 'providers.provider': provider }, {
            $set: {
                'providers.$[p].disabledUntil': new Date(Date.now() + duration),
            },
        }, { arrayFilters: [{ 'p.provider': provider }] });
        return true;
    }
    catch (err) {
        console.error('ModelRoster cool-off write error:', err);
        return false;
    }
});
exports.disableRosterProvider = disableRosterProvider;
