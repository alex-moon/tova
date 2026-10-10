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
exports.applyCostToStats = exports.estimateCostUsd = exports.loadPriceIndex = exports.priceFor = exports.buildPriceIndex = exports.pickPriceRow = void 0;
const rosterConfig_1 = require("./rosterConfig");
// Deterministic best-row pick from the rows sharing one model string.
const pickPriceRow = (rows) => {
    const bothKnown = rows.filter((r) => Number.isFinite(r.inputPrice) && Number.isFinite(r.outputPrice));
    const candidates = bothKnown.length > 0 ? bothKnown : rows;
    if (candidates.length === 0)
        return null;
    return candidates[0];
};
exports.pickPriceRow = pickPriceRow;
const priceOf = (ref) => ref.inputPrice !== undefined || ref.outputPrice !== undefined
    ? { inputPrice: ref.inputPrice, outputPrice: ref.outputPrice }
    : null;
const buildPriceIndex = (roster) => {
    const byProvider = new Map();
    const fallback = new Map();
    for (const model of roster) {
        const providers = new Map();
        const candidates = [];
        const modelDefault = priceOf(model);
        if (modelDefault)
            candidates.push(modelDefault);
        // Sort provider entries by name so the model-only fallback is deterministic
        // regardless of roster/seed order (matches the pre-#235 tie-break).
        for (const p of model.providers.slice().sort((a, b) => a.provider.localeCompare(b.provider))) {
            const price = priceOf(p);
            if (!price)
                continue;
            providers.set(p.provider, price);
            candidates.push(price);
        }
        if (providers.size > 0)
            byProvider.set(model.modelId, providers);
        if (candidates.length > 0)
            fallback.set(model.modelId, candidates);
    }
    return { byProvider, fallback };
};
exports.buildPriceIndex = buildPriceIndex;
/*
 * Price for one `(model, provider)` pair. A known provider uses that provider's
 * entry when priced; otherwise (unknown provider, or a provider entry with no
 * price) it falls back to the deterministic model-only pick. Returns `null`
 * when the model has no known price at all.
 */
const priceFor = (index, modelId, provider) => {
    var _a, _b;
    if (provider) {
        const hit = (_a = index.byProvider.get(modelId)) === null || _a === void 0 ? void 0 : _a.get(provider);
        if (hit)
            return hit;
    }
    return (0, exports.pickPriceRow)((_b = index.fallback.get(modelId)) !== null && _b !== void 0 ? _b : []);
};
exports.priceFor = priceFor;
// Load the roster price index once. Mirrors `listRoster`'s empty-collection
// recovery and DB-failure fallback (a broken config read prices nothing rather
// than taking the admin surface down).
const loadPriceIndex = () => __awaiter(void 0, void 0, void 0, function* () { return (0, exports.buildPriceIndex)(yield (0, rosterConfig_1.listRoster)()); });
exports.loadPriceIndex = loadPriceIndex;
/*
 * Price one model's token split. Returns `null` when either side's price is
 * missing or non-finite — a partially-known model is rendered `—`, never a
 * half figure. Zero tokens price to `0` when the price is known.
 */
const estimateCostUsd = (inputTokens, outputTokens, price) => {
    if (!price)
        return null;
    const { inputPrice, outputPrice } = price;
    if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice))
        return null;
    return ((inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice);
};
exports.estimateCostUsd = estimateCostUsd;
// Load the roster price index, then stamp each row and the totals with the
// estimate. #237: the rollup now carries the provider per row, so a raced
// model prices from the winning provider's entry; the model-only fallback in
// `priceFor` still covers a legacy no-provider row.
const applyCostToStats = (payload, index) => __awaiter(void 0, void 0, void 0, function* () {
    if (payload.models.length === 0) {
        return Object.assign(Object.assign({}, payload), { totals: Object.assign(Object.assign({}, payload.totals), { estimatedCostUsd: null }) });
    }
    const priceIndex = index !== null && index !== void 0 ? index : (yield (0, exports.loadPriceIndex)());
    let anyKnown = false;
    let costSum = 0;
    const models = payload.models.map((m) => {
        var _a;
        const cost = (0, exports.estimateCostUsd)(m.inputTokens, m.outputTokens, (0, exports.priceFor)(priceIndex, m.model, (_a = m.provider) !== null && _a !== void 0 ? _a : undefined));
        if (cost !== null) {
            anyKnown = true;
            costSum += cost;
        }
        return Object.assign(Object.assign({}, m), { estimatedCostUsd: cost });
    });
    return Object.assign(Object.assign({}, payload), { models, totals: Object.assign(Object.assign({}, payload.totals), { estimatedCostUsd: anyKnown ? costSum : null }) });
});
exports.applyCostToStats = applyCostToStats;
