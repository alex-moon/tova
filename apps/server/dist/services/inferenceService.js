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
exports.inferenceService = void 0;
const mastraService_1 = require("./mastraService");
const modelErrorTally_1 = require("./modelErrorTally");
const connectors = {
    groq: mastraService_1.groqConnector,
    deepinfra: mastraService_1.deepinfraConnector,
    fireworks: mastraService_1.fireworksConnector,
    // typesafe connector lands with #151's openai-compatible wiring.
};
/*
 * Providers are typed on `CompletionOptions`, but model refs sourced from
 * MongoDB (`modelConfigService`) are untyped at the boundary — a corrupted
 * or unsupported provider string must not surface as a bare
 * `TypeError: undefined is not a function` mid-request.
 */
const connectorFor = (provider) => {
    const connector = connectors[provider !== null && provider !== void 0 ? provider : 'groq'];
    if (!connector)
        throw new Error(`Unknown LLM provider: ${String(provider)}`);
    return connector;
};
// Issue #175: record every completion failure against its provider route
// before rethrowing — inferenceService is the single choke point for all
// LLM calls, so nothing else needs instrumenting.
const withTally = (options, run) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const provider = (_a = options.provider) !== null && _a !== void 0 ? _a : 'groq';
    try {
        return yield run(connectorFor(provider));
    }
    catch (err) {
        (0, modelErrorTally_1.recordModelError)(provider, options.model, err);
        throw err;
    }
});
exports.inferenceService = {
    createCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () { return withTally(options, (connector) => connector.createCompletion(options)); }),
    createStreamingCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () { return withTally(options, (connector) => connector.createStreamingCompletion(options)); }),
    createToolFreeCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () { return withTally(options, (connector) => connector.createToolFreeCompletion(options)); }),
};
