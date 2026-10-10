"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outputTokensFor = exports.promptCharsFrom = void 0;
/*
 * Default output-token budget for main-chat completions (#104). Without an
 * explicit `max_tokens` the DeepInfra provider defaults the output budget to
 * the model's whole context window (the #104 incident: a 40960-token request
 * on a 40960-token model leaves zero room for input), so chat always sends
 * one — sized against the routed model's `contextLength` when known.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const PROMPT_TOKEN_SLACK = 512;
const FLOOR = 1024;
const CHARS_PER_TOKEN = 4;
const promptCharsFrom = (messages) => messages.reduce((sum, m) => sum +
    (typeof m.content === 'string'
        ? m.content.length
        : m.content.reduce((inner, part) => { var _a, _b; return inner + (part.type === 'text' ? ((_b = (_a = part.text) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0) : 0); }, 0)), 0);
exports.promptCharsFrom = promptCharsFrom;
const outputTokensFor = (contextLength, promptChars) => {
    const envRaw = process.env.CHAT_MAX_OUTPUT_TOKENS;
    const env = envRaw !== undefined && Number.isFinite(Number(envRaw)) ? Number(envRaw) : undefined;
    const base = env && env > 0 ? env : DEFAULT_MAX_OUTPUT_TOKENS;
    // Unknown window (e.g. the env fallback model has no contextLength): send
    // the base budget untouched rather than guess.
    if (contextLength === undefined)
        return base;
    const budget = contextLength - Math.ceil(promptChars / CHARS_PER_TOKEN) - PROMPT_TOKEN_SLACK;
    const clamped = Math.max(Math.min(base, budget), Math.min(base, FLOOR));
    return clamped;
};
exports.outputTokensFor = outputTokensFor;
