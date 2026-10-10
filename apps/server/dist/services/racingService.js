"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveProviders = exports.routeAndComplete = exports.routeAndStream = exports.pickRosterRoute = exports.raceRosterCompletion = exports.raceRoster = exports.rosterRacingEnabled = exports.MAX_RACE_ATTEMPTS = void 0;
const inferenceService_1 = require("./inferenceService");
const modelFailover_1 = require("./modelFailover");
const providerErrors_1 = require("./providerErrors");
const rosterConfig_1 = require("./rosterConfig");
Object.defineProperty(exports, "liveProviders", { enumerable: true, get: function () { return rosterConfig_1.liveProviders; } });
const modelConfigService_1 = require("./modelConfigService");
/*
 * Hard cap on roster attempts (mirrors MAX_ATTEMPTS in `modelFailover`): the
 * roster is 3 models / up to 6 provider calls, so this is generous but bounded.
 */
exports.MAX_RACE_ATTEMPTS = 6;
/*
 * Feature gate for the #232 racing path. The roster runtime coexists with the
 * tier router (#233 deletes the latter); this flag lets the swap be staged.
 * Default ON everywhere except the test environment, where the chat-route
 * suites still stub the tier primitives. `ROSTER_RACING_ENABLED=0` forces it
 * off, `=1` forces it on.
 */
const rosterRacingEnabled = () => {
    const raw = process.env.ROSTER_RACING_ENABLED;
    if (raw === '0')
        return false;
    if (raw === '1')
        return true;
    return process.env.NODE_ENV !== 'test';
};
exports.rosterRacingEnabled = rosterRacingEnabled;
const nowFromDeps = (deps) => { var _a; return (_a = deps.now) !== null && _a !== void 0 ? _a : (() => Date.now()); };
/*
 * Resolve the roster: an injected roster for tests, else the live read. Kept
 * behind a helper so the dynamic import (which avoids a load-time cycle with
 * `rosterConfig`) is written once.
 */
const readRoster = (deps) => __awaiter(void 0, void 0, void 0, function* () { var _a; return (_a = deps.roster) !== null && _a !== void 0 ? _a : (yield Promise.resolve().then(() => __importStar(require('./rosterConfig')))).listRoster(); });
/*
 * Combine two abort signals into one that aborts when either does. Node 20.3+
 * ships `AbortSignal.any`; the manual fallback keeps older runtimes working.
 */
const combineSignals = (a, b) => {
    const anyFn = AbortSignal.any;
    if (typeof anyFn === 'function')
        return anyFn([a, b]);
    const merged = new AbortController();
    const onAbort = () => merged.abort();
    if (a.aborted || b.aborted)
        merged.abort();
    else {
        a.addEventListener('abort', onAbort, { once: true });
        b.addEventListener('abort', onAbort, { once: true });
    }
    return merged.signal;
};
/*
 * #237: tag a raced provider call's trace so racing is debuggable in the
 * LangSmith UI (`race: 'roster'`, `provider:<name>`). Identifiers only — same
 * redaction rule as the rest of the trace context. The caller's own
 * tags/metadata are preserved.
 *
 * The winner is not tagged here: the span is created when the call starts, so
 * neither racer knows its fate yet. The loser is identifiable by its
 * abort/cancel error (filtered from the stats rollup), which is honest — the
 * span *was* cancelled, we just cannot know it would be the loser up front.
 */
const raceTrace = (base, provider) => {
    var _a, _b;
    return (Object.assign(Object.assign({}, ((base === null || base === void 0 ? void 0 : base.sessionId) ? { sessionId: base.sessionId } : {})), { tags: [...((_a = base === null || base === void 0 ? void 0 : base.tags) !== null && _a !== void 0 ? _a : []), 'race:roster', `provider:${provider}`], metadata: Object.assign(Object.assign({}, ((_b = base === null || base === void 0 ? void 0 : base.metadata) !== null && _b !== void 0 ? _b : {})), { race: 'roster', provider }) }));
};
/*
 * Wrap an already-advanced iterator (its first chunk consumed) into a stream
 * that yields the buffered first chunk, then continues from the SAME iterator.
 * Re-iterating the original stream object would restart an async generator, so
 * the iterator is carried explicitly rather than replaced.
 */
const resumeStream = (first, iterator) => {
    return (function () {
        return __asyncGenerator(this, arguments, function* () {
            yield yield __await(first);
            for (;;) {
                const next = yield __await(iterator.next());
                if (next.done)
                    return yield __await(void 0);
                yield yield __await(next.value);
            }
        });
    })();
};
/*
 * Race one model's providers. Starts every provider's stream concurrently,
 * resolves with the first to yield a chunk (returning a resumed stream), and
 * aborts the rest. If every provider fails (or yields an empty stream),
 * rejects with the last non-abort error.
 *
 * The caller's `abortSignal` (client disconnect) is preserved on every call;
 * racing adds a per-provider controller so the loser is aborted independently.
 */
const raceProviders = (model, options, deps) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const start = (_a = deps.startStream) !== null && _a !== void 0 ? _a : ((o) => inferenceService_1.inferenceService.createStreamingCompletion(o));
    const clock = nowFromDeps(deps);
    const controller = new AbortController();
    const started = clock();
    /*
     * The caller's abort signal (client disconnect) must still cancel every
     * provider call; the race controller cancels the losers. Each call gets a
     * combined signal so either source aborts it.
     */
    const clientSignal = options.abortSignal;
    const attempts = model.providers.map((providerRef) => __awaiter(void 0, void 0, void 0, function* () {
        const perCall = new AbortController();
        const abortChild = () => perCall.abort();
        controller.signal.addEventListener('abort', abortChild, { once: true });
        try {
            const signal = clientSignal ? combineSignals(clientSignal, perCall.signal) : perCall.signal;
            const provider = providerRef.provider;
            const stream = yield start(Object.assign(Object.assign({}, options), { provider, model: providerRef.modelId, abortSignal: signal, trace: raceTrace(options.trace, provider) }));
            const iterator = stream[Symbol.asyncIterator]();
            const next = yield iterator.next();
            if (next.done)
                throw new Error('Empty stream from provider');
            return {
                kind: 'won',
                provider: providerRef,
                iterator,
                first: next.value,
                ttftMs: Math.max(0, clock() - started),
            };
        }
        catch (error) {
            return { kind: 'failed', provider: providerRef, error };
        }
        finally {
            controller.signal.removeEventListener('abort', abortChild);
        }
    }));
    const winner = yield firstWin(attempts);
    if (winner) {
        // Abort every loser (per-provider controllers).
        controller.abort();
        return {
            provider: winner.provider,
            stream: resumeStream(winner.first, winner.iterator),
            ttftMs: winner.ttftMs,
        };
    }
    // No provider won: every attempt settled as `failed`. Surface a non-abort
    // error if any, else the first (an all-abort result means the client hung
    // up and the caller's abort classification handles it).
    const settled = yield Promise.all(attempts);
    const errors = settled
        .filter((r) => r.kind === 'failed')
        .map((r) => r.error);
    const failed = (_b = errors.find((e) => !(0, modelFailover_1.isClientAbort)(e))) !== null && _b !== void 0 ? _b : errors[0];
    throw failed !== null && failed !== void 0 ? failed : new Error('All providers failed');
});
/*
 * Resolve with the first provider that WINS, or null when ALL attempts fail.
 * Each attempt's result is routed through `settle`: a win resolves the
 * deferred immediately, a failure is recorded. When the last attempt settles
 * without a win, the deferred resolves null. This never hangs and never
 * resolves a failure as a win.
 */
const firstWin = (attempts) => {
    return new Promise((resolve, reject) => {
        let remaining = attempts.length;
        let won = false;
        if (remaining === 0) {
            reject(new Error('No providers to race'));
            return;
        }
        for (const attempt of attempts) {
            attempt.then((r) => {
                if (r.kind === 'won') {
                    if (!won) {
                        won = true;
                        resolve(r);
                    }
                    return;
                }
                remaining -= 1;
                if (remaining === 0 && !won)
                    resolve(null);
            }, () => {
                // `attempt` itself never rejects (it catches), but guard anyway.
                remaining -= 1;
                if (remaining === 0 && !won)
                    resolve(null);
            });
        }
    });
};
/*
 * Run one turn through the roster: pick the weighted primary, race its
 * providers, and on total failure cool off that model's providers and fall
 * through to the next roster model. Returns the winning stream and the model /
 * provider metadata.
 */
const raceRoster = (options_1, hasImage_1, ...args_1) => __awaiter(void 0, [options_1, hasImage_1, ...args_1], void 0, function* (options, hasImage, deps = {}) {
    var _a;
    const roster = yield readRoster(deps);
    const candidates = (0, rosterConfig_1.rosterModelsForTurn)(roster, hasImage);
    let lastError;
    let attempts = 0;
    // Track models already tried so fallback walks the roster without repeating.
    const tried = new Set();
    while (attempts < exports.MAX_RACE_ATTEMPTS) {
        const remaining = candidates.filter((m) => !tried.has(m.modelId));
        const primary = (0, rosterConfig_1.pickPrimary)(remaining);
        if (!primary)
            break;
        attempts += 1;
        tried.add(primary.modelId);
        try {
            const raced = yield raceProviders(primary, options, deps);
            const ttftMs = raced.ttftMs;
            // Fire-and-forget: a metrics write must never fail the turn.
            void (0, rosterConfig_1.recordTtft)(primary.modelId, raced.provider.provider, ttftMs);
            return {
                result: { model: primary, provider: raced.provider, stream: raced.stream, ttftMs },
                attempts,
            };
        }
        catch (err) {
            lastError = err;
            if ((0, modelFailover_1.isClientAbort)(err))
                throw err;
            if ((0, modelFailover_1.isPromptSizeError)(err))
                throw err;
            if ((0, modelFailover_1.isRateLimitError)(err) && !(0, providerErrors_1.isOverloadError)(err))
                throw err;
            // Transient/hard failure of the whole model: cool off each provider for
            // the appropriate TTL and fall through to the next model.
            const ttl = (0, providerErrors_1.isOverloadError)(err) ? (0, modelConfigService_1.overloadCoolOffMinutes)() * 60 * 1000 : undefined;
            const disable = (_a = deps.disable) !== null && _a !== void 0 ? _a : rosterConfig_1.disableRosterProvider;
            yield Promise.all(primary.providers.map((p) => disable(primary.modelId, p.provider, ttl)));
        }
    }
    throw lastError !== null && lastError !== void 0 ? lastError : new Error('No roster models available');
});
exports.raceRoster = raceRoster;
const raceRosterCompletion = (options_1, hasImage_1, ...args_1) => __awaiter(void 0, [options_1, hasImage_1, ...args_1], void 0, function* (options, hasImage, deps = {}) {
    var _a, _b, _c;
    const roster = yield readRoster(deps);
    const candidates = (0, rosterConfig_1.rosterModelsForTurn)(roster, hasImage);
    const start = (_a = deps.startCompletion) !== null && _a !== void 0 ? _a : ((o) => inferenceService_1.inferenceService.createCompletion(o));
    let lastError;
    const tried = new Set();
    for (let attempt = 0; attempt < exports.MAX_RACE_ATTEMPTS; attempt += 1) {
        const remaining = candidates.filter((m) => !tried.has(m.modelId));
        const primary = (0, rosterConfig_1.pickPrimary)(remaining);
        if (!primary)
            break;
        tried.add(primary.modelId);
        const clock = nowFromDeps(deps);
        const started = clock();
        /*
         * Without a stream there is no first-token signal, so the race resolves
         * with the first provider whose completion RESOLVES. Unlike
         * `Promise.allSettled` (which waits for every provider before choosing),
         * this returns as soon as one provider is done and lets the slower ones
         * settle in the background — the whole point of racing is not to wait for
         * the loser. `createCompletion` cannot cancel the in-flight HTTP call
         * today, so the loser is not aborted, only ignored.
         */
        const attempts = primary.providers.map((p) => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const provider = p.provider;
                const completion = yield start(Object.assign(Object.assign({}, options), { provider, model: p.modelId, trace: raceTrace(options.trace, provider) }));
                return { model: primary, provider: p, completion };
            }
            catch (error) {
                return { failed: error };
            }
        }));
        const won = yield firstCompletionWin(attempts);
        if (won) {
            const latency = Math.max(0, clock() - started);
            void (0, rosterConfig_1.recordTtft)(primary.modelId, won.provider.provider, latency);
            return { result: won, attempts: attempt + 1 };
        }
        const settled = yield Promise.all(attempts);
        const reason = (_b = settled.find((r) => 'failed' in r)) === null || _b === void 0 ? void 0 : _b.failed;
        lastError = reason;
        if ((0, modelFailover_1.isClientAbort)(reason))
            throw reason;
        if ((0, modelFailover_1.isPromptSizeError)(reason))
            throw reason;
        if ((0, modelFailover_1.isRateLimitError)(reason) && !(0, providerErrors_1.isOverloadError)(reason))
            throw reason;
        const ttl = (0, providerErrors_1.isOverloadError)(reason) ? (0, modelConfigService_1.overloadCoolOffMinutes)() * 60 * 1000 : undefined;
        const disable = (_c = deps.disable) !== null && _c !== void 0 ? _c : rosterConfig_1.disableRosterProvider;
        yield Promise.all(primary.providers.map((p) => disable(primary.modelId, p.provider, ttl)));
    }
    throw lastError !== null && lastError !== void 0 ? lastError : new Error('No roster models available');
});
exports.raceRosterCompletion = raceRosterCompletion;
/*
 * Resolve with the first provider completion to SUCCEED, or null when every
 * provider failed. Mirrors `firstWin` for the streaming path: a success
 * resolves immediately (the losers keep settling, unawaited), and only when the
 * last attempt fails without a success does the deferred resolve null.
 */
const firstCompletionWin = (attempts) => {
    return new Promise((resolve) => {
        let remaining = attempts.length;
        let won = false;
        if (remaining === 0) {
            resolve(null);
            return;
        }
        for (const attempt of attempts) {
            attempt.then((r) => {
                if ('failed' in r) {
                    remaining -= 1;
                    if (remaining === 0 && !won)
                        resolve(null);
                    return;
                }
                if (!won) {
                    won = true;
                    resolve(r);
                }
            }, () => {
                remaining -= 1;
                if (remaining === 0 && !won)
                    resolve(null);
            });
        }
    });
};
/*
 * Metadata-only weighted primary pick for the chat routes: returns the model
 * the turn WILL be raced on, so the route can assemble the system prompt (and
 * send its `meta` event) before the stream starts. The actual racing happens
 * in `raceRoster` once the messages exist. `provider` here is the primary
 * provider's name for the pre-race `meta`; the winner is persisted from the
 * race outcome.
 */
const pickRosterRoute = (hasImage_1, ...args_1) => __awaiter(void 0, [hasImage_1, ...args_1], void 0, function* (hasImage, deps = {}) {
    const roster = yield readRoster(deps);
    const primary = (0, rosterConfig_1.pickPrimary)((0, rosterConfig_1.rosterModelsForTurn)(roster, hasImage));
    if (!primary)
        return null;
    const providerRef = primary.providers[0];
    return Object.assign({ model: primary.modelId, provider: providerRef.provider, reason: 'roster-pick' }, (primary.contextLength !== undefined ? { contextLength: primary.contextLength } : {}));
});
exports.pickRosterRoute = pickRosterRoute;
/*
 * Streaming entry point for the chat routes: race the roster, then return both
 * the winning stream and a `RosterRoutingResult` the route can persist and
 * send in its `meta` event. The `reason` names the racing path (`roster-race`)
 * for tracing; the winning provider is where the tokens actually came from.
 */
const routeAndStream = (options_1, hasImage_1, ...args_1) => __awaiter(void 0, [options_1, hasImage_1, ...args_1], void 0, function* (options, hasImage, deps = {}) {
    const outcome = yield (0, exports.raceRoster)(options, hasImage, deps);
    const { model, provider, ttftMs } = outcome.result;
    return {
        routing: Object.assign({ model: model.modelId, provider: provider.provider, reason: `roster-race;ttft:${Math.round(ttftMs)}` }, (model.contextLength !== undefined ? { contextLength: model.contextLength } : {})),
        outcome,
    };
});
exports.routeAndStream = routeAndStream;
/*
 * Non-streaming entry point for the chat routes: race the roster's completions,
 * then return both the winning completion and a `RosterRoutingResult` the route
 * can persist. `reason` names the racing path (`roster-race`) for tracing; the
 * winning provider is where the tokens actually came from. Parallel to
 * `routeAndStream` so the streaming and non-streaming routes shape persistence
 * identically.
 */
const routeAndComplete = (options_1, hasImage_1, ...args_1) => __awaiter(void 0, [options_1, hasImage_1, ...args_1], void 0, function* (options, hasImage, deps = {}) {
    const outcome = yield (0, exports.raceRosterCompletion)(options, hasImage, deps);
    const { model, provider } = outcome.result;
    return {
        routing: Object.assign({ model: model.modelId, provider: provider.provider, reason: 'roster-race' }, (model.contextLength !== undefined ? { contextLength: model.contextLength } : {})),
        outcome,
    };
});
exports.routeAndComplete = routeAndComplete;
