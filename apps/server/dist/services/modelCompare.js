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
exports.runModelComparison = exports.MAX_COMPARE_MODELS = void 0;
const mastraService_1 = require("./mastraService");
const promptAssembly_1 = require("./promptAssembly");
const outputTokenCap_1 = require("./outputTokenCap");
exports.MAX_COMPARE_MODELS = 6;
/*
 * #151: the typesafe connector does not exist yet (openai-compatible wiring
 * is pending), so the entry resolves to `undefined` and compare runs against
 * it surface the "Unknown provider" error row instead of crashing the run.
 * #232/#234: fireworks is a first-class roster provider and is wired here so
 * the admin Compare tab can race each roster model's two backends.
 */
const PROVIDERS = {
    groq: mastraService_1.groqConnector,
    deepinfra: mastraService_1.deepinfraConnector,
    fireworks: mastraService_1.fireworksConnector,
    typesafe: undefined,
};
/**
 * Runs the prompt through each model sequentially. Serialised on purpose:
 * tool-warming, rate limits and a noisy parallel fan-out make side-by-side
 * comparisons misleadingly flaky, and N here is small.
 */
const runModelComparison = (prompt, models) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const system = (0, promptAssembly_1.buildSystemContent)(null);
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
    ];
    const results = [];
    for (const ref of models) {
        const started = Date.now();
        const connector = PROVIDERS[ref.provider];
        if (!connector) {
            results.push({
                provider: ref.provider,
                model: ref.model,
                answer: null,
                latencyMs: 0,
                error: `Unknown provider: ${ref.provider}`,
            });
            continue;
        }
        try {
            const options = {
                provider: ref.provider,
                model: ref.model,
                messages,
                max_tokens: (0, outputTokenCap_1.outputTokensFor)(ref.contextLength === undefined ? undefined : ref.contextLength, (0, outputTokenCap_1.promptCharsFrom)(messages)),
            };
            const completion = yield connector.createCompletion(options);
            results.push({
                provider: ref.provider,
                model: ref.model,
                answer: (_c = (_b = (_a = completion.choices[0]) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.content) !== null && _c !== void 0 ? _c : null,
                latencyMs: Date.now() - started,
            });
        }
        catch (err) {
            results.push({
                provider: ref.provider,
                model: ref.model,
                answer: null,
                latencyMs: Date.now() - started,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { prompt, results };
});
exports.runModelComparison = runModelComparison;
