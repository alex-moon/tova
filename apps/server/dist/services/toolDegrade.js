"use strict";
/*
 * Per-completion tool degradation (#82). Tool `execute` wrappers receive
 * Mastra's request context as their second argument (a fresh `RequestContext`
 * per completion call, pinned by mastraRequestContext.test.ts), which is the
 * natural per-completion scope: a tool that fails once is marked failed there
 * and short-circuits to a degraded result on every retry inside the same
 * completion, without another handshake or network round trip.
 *
 * Both entry points tolerate a null/undefined or contextless call-site by
 * no-oping / returning false, so legacy callers passing nothing do not break.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.degradedToolError = exports.reasonFrom = exports.toolDegradeReason = exports.toolIsFailed = exports.markToolFailed = void 0;
const TOOL_FAILURES_KEY = 'toolFailures';
const failureMapOn = (ctx) => {
    const requestContext = ctx === null || ctx === void 0 ? void 0 : ctx.requestContext;
    if (typeof (requestContext === null || requestContext === void 0 ? void 0 : requestContext.get) !== 'function' || typeof (requestContext === null || requestContext === void 0 ? void 0 : requestContext.set) !== 'function')
        return undefined;
    const existing = requestContext.get(TOOL_FAILURES_KEY);
    if (existing instanceof Map)
        return existing;
    const fresh = new Map();
    requestContext.set(TOOL_FAILURES_KEY, fresh);
    return fresh;
};
// Mark a tool failed for this completion. The optional reason is remembered
// so a short-circuited retry reports the original failure, not a placeholder.
const markToolFailed = (ctx, toolId, reason) => {
    const map = failureMapOn(ctx);
    if (!map)
        return;
    // Re-marking keeps the recorded reason: the first failure is the honest one.
    if (!map.has(toolId))
        map.set(toolId, reason || 'reason unknown');
};
exports.markToolFailed = markToolFailed;
const toolIsFailed = (ctx, toolId) => { var _a, _b; return (_b = (_a = failureMapOn(ctx)) === null || _a === void 0 ? void 0 : _a.has(toolId)) !== null && _b !== void 0 ? _b : false; };
exports.toolIsFailed = toolIsFailed;
const toolDegradeReason = (ctx, toolId) => { var _a; return ((_a = failureMapOn(ctx)) === null || _a === void 0 ? void 0 : _a.get(toolId)) || 'reason unknown'; };
exports.toolDegradeReason = toolDegradeReason;
// Bound any error to a short, single-line, human-readable reason. Errors
// can carry long multi-line payloads (HTTP dumps, stack fragments); the
// collapse keeps the tool result compact and model-friendly.
const REASON_MAX_CHARS = 255;
const reasonFrom = (error) => {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    if (!raw)
        return 'reason unknown';
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (!collapsed)
        return 'reason unknown';
    return collapsed.length > REASON_MAX_CHARS
        ? `${collapsed.slice(0, REASON_MAX_CHARS - 3)}...`
        : collapsed;
};
exports.reasonFrom = reasonFrom;
// The model-facing degraded result text (#82): the only channel we own for
// "the model surfaces that it tried to use the tool but it failed" is the
// tool result itself, so the instruction rides in the text.
const degradedToolError = (toolId, reason) => `Tool ${toolId} failed to run${reason ? `: ${reason}` : ' (reason unknown)'}. It is unavailable for the rest of this completion — tell the user you tried to use it but it could not be used.`;
exports.degradedToolError = degradedToolError;
