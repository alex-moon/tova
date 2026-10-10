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
exports.lookupProviderModel = void 0;
const config_1 = require("../config");
const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/v1/openai/models';
/*
 * #232/#234: Fireworks' model list. The serverless catalog lives under the
 * shared `fireworks` account, so the account id is a constant, not config —
 * user deployments under other accounts are out of scope for a roster model.
 */
const FIREWORKS_ACCOUNT = 'fireworks';
const FIREWORKS_MODELS_URL = `https://api.fireworks.ai/v1/accounts/${FIREWORKS_ACCOUNT}/models`;
const LOOKUP_TIMEOUT_MS = 12000;
const asFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/*
 * A catalog entry is treated as a chat-completion model only when it reports a
 * token context window and token pricing. Non-chat entries (tts, image, etc.)
 * carry character/second pricing and a null context length; resolving one as a
 * routing row would write a useless row, so they read as "not found".
 */
const toDetails = (entry, model) => {
    var _a, _b, _c, _d, _e, _f, _g;
    const contextLength = asFiniteNumber((_a = entry.metadata) === null || _a === void 0 ? void 0 : _a.context_length);
    const inputPrice = asFiniteNumber((_c = (_b = entry.metadata) === null || _b === void 0 ? void 0 : _b.pricing) === null || _c === void 0 ? void 0 : _c.input_tokens);
    const outputPrice = asFiniteNumber((_e = (_d = entry.metadata) === null || _d === void 0 ? void 0 : _d.pricing) === null || _e === void 0 ? void 0 : _e.output_tokens);
    if (contextLength === undefined || inputPrice === undefined || outputPrice === undefined) {
        return null;
    }
    const tags = Array.isArray((_f = entry.metadata) === null || _f === void 0 ? void 0 : _f.tags) ? entry.metadata.tags : [];
    const vision = tags.some((tag) => tag === 'vision' || tag === 'vlm');
    const description = typeof ((_g = entry.metadata) === null || _g === void 0 ? void 0 : _g.description) === 'string' ? entry.metadata.description : undefined;
    return Object.assign(Object.assign({ provider: 'deepinfra', model,
        contextLength,
        inputPrice,
        outputPrice }, (vision ? { vision: true } : {})), (description ? { description } : {}));
};
const lookupDeepInfra = (model) => __awaiter(void 0, void 0, void 0, function* () {
    const apiKey = config_1.config.providers.deepinfraApiKey;
    if (!apiKey) {
        throw new Error('DEEPINFRA_API_KEY is not configured — cannot look up model details');
    }
    const url = `${DEEPINFRA_MODELS_URL}?sort_by=openclaw&filter=with_meta`;
    const response = yield fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`DeepInfra catalog request failed: ${message}`);
    });
    if (!response.ok) {
        throw new Error(`DeepInfra catalog returned HTTP ${response.status}`);
    }
    const body = (yield response.json().catch(() => null));
    const entries = Array.isArray(body === null || body === void 0 ? void 0 : body.data) ? body.data : [];
    const entry = entries.find((candidate) => candidate.id === model);
    return entry ? toDetails(entry, model) : null;
});
/*
 * Fireworks reports capabilities only. Unlike DeepInfra there is no pricing, so
 * the returned details omit prices entirely (they stay "unknown", neutral in
 * the score). A non-chat entry that reports no context window reads as "not
 * found" — resolving one as a roster model would write a useless row.
 */
const toFireworksDetails = (entry, model) => {
    const contextLength = asFiniteNumber(entry.contextLength);
    if (contextLength === undefined)
        return null;
    const description = typeof entry.description === 'string' ? entry.description : undefined;
    return Object.assign(Object.assign({ provider: 'fireworks', model,
        contextLength }, (entry.supportsImageInput === true ? { vision: true } : {})), (description ? { description } : {}));
};
const lookupFireworks = (model) => __awaiter(void 0, void 0, void 0, function* () {
    const apiKey = config_1.config.providers.fireworksApiKey;
    if (!apiKey) {
        throw new Error('FIREWORKS_API_KEY is not configured — cannot look up model details');
    }
    const response = yield fetch(FIREWORKS_MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Fireworks catalog request failed: ${message}`);
    });
    if (!response.ok) {
        throw new Error(`Fireworks catalog returned HTTP ${response.status}`);
    }
    const body = (yield response.json().catch(() => null));
    const entries = Array.isArray(body === null || body === void 0 ? void 0 : body.models) ? body.models : [];
    // Match on the full id (`accounts/fireworks/models/...`), which is what the
    // roster stores and sends; a bare short name is accepted too for operator
    // convenience.
    const entry = entries.find((candidate) => candidate.name === model || candidate.name === `accounts/fireworks/models/${model}`);
    return entry ? toFireworksDetails(entry, model) : null;
});
/*
 * Resolve a model's provider-owned details. Returns `null` when the provider
 * hosts no such (chat) model; throws on transport/auth failures.
 */
const lookupProviderModel = (provider, model) => __awaiter(void 0, void 0, void 0, function* () {
    switch (provider) {
        case 'deepinfra':
            return lookupDeepInfra(model);
        case 'fireworks':
            return lookupFireworks(model);
        default: {
            // Exhaustiveness guard: a new LookupProvider must be wired here.
            const _exhaustive = provider;
            throw new Error(`Unsupported lookup provider: ${String(_exhaustive)}`);
        }
    }
});
exports.lookupProviderModel = lookupProviderModel;
