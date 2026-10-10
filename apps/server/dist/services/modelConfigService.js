"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepModels = exports.overloadCoolOffMinutes = exports.AllModelsDisabledError = exports.ALL_MODELS_DISABLED_MESSAGE = void 0;
const rosterConfig_1 = require("./rosterConfig");
/*
 * #168: thrown when every model that could serve a request is cooling off. The
 * racing runtime surfaces an all-models-unavailable turn with this message so
 * the end-user text stays actionable.
 */
exports.ALL_MODELS_DISABLED_MESSAGE = 'All models are temporarily unavailable after failures — they cool off for a few hours and are retried automatically. Please try again later.';
class AllModelsDisabledError extends Error {
    constructor() {
        super(exports.ALL_MODELS_DISABLED_MESSAGE);
        this.name = 'AllModelsDisabledError';
    }
}
exports.AllModelsDisabledError = AllModelsDisabledError;
/*
 * #213: endpoint overload ("Model busy, retry later" / `engine_overloaded`) is a
 * per-endpoint saturation that clears in seconds-to-minutes, unlike the 6h
 * cool-off for a genuinely broken endpoint. Overload uses its own short TTL
 * (env-tunable, default 5 minutes) so a healthy backend returns to the pool
 * quickly. Same fallback discipline as the other env knobs.
 */
const overloadCoolOffMinutes = () => {
    const raw = process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
};
exports.overloadCoolOffMinutes = overloadCoolOffMinutes;
const sweepModels = (providers) => {
    const allow = providers && new Set(providers);
    const seen = new Set();
    const models = [];
    for (const model of rosterConfig_1.ROSTER_SEED) {
        for (const providerRef of model.providers) {
            if (allow && !allow.has(providerRef.provider))
                continue;
            const key = `${providerRef.provider}:${providerRef.modelId}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            models.push({ provider: providerRef.provider, model: providerRef.modelId });
        }
    }
    return models;
};
exports.sweepModels = sweepModels;
