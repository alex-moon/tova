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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceStats = exports.getTrace = exports.listTraces = exports.isAbortedRun = exports.ttftMsOf = exports.providerFromRun = exports.modelFromRunName = exports.LangsmithError = exports.REQUEST_TIMEOUT_MS = exports.RETRY_WAIT_MS = void 0;
const config_1 = require("../config");
/*
 * Read-only LangSmith query service for the admin Traces tab (#186).
 *
 * Sits next to `tracePurge.ts` and shares its raw-REST stance: x-api-key
 * header, project id resolved by name (name-match only — never fall back to
 * "first session returned"), no SDK. Where the purge is failure-tolerant and
 * silent, this is an interactive read path: failures surface as thrown
 * errors, the route maps them to 502, and a missing key/project is a first-
 * class "not configured" answer (null) rather than an error.
 *
 * Verified against the live API (2026-09-27):
 *  - POST /api/v1/runs/query answers { runs, ... } (an object, not an
 *    array — see #187 for the purge's array-cast bug).
 *  - Filters used here: eq(is_root, true), eq(status, "error"),
 *    eq(trace_id, ...), gte(start_time, ...), in(trace_id, [...]),
 *    eq(run_type, "llm"). Default order is newest-first.
 *  - Model identity lives on the `llm: '<model>'` child run name (chat
 *    turns carry no session metadata today), so every page of root runs is
 *    joined with one llm-children query. Token totals come from the same
 *    children: root-level `total_tokens` aggregates appear reliable without
 *    `select` but were observed as 0 with it, while child tokens are
 *    consistent in both shapes.
 *  - The API intermittently answers 429/5xx transiently: one retry after
 *    500ms, then the error propagates.
 */
const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
// Single wait before the one retry a transient 5xx gets (429s get the
// backoff budget in RETRY_WAITS_MS).
exports.RETRY_WAIT_MS = 500;
// Per-attempt cap: a stalled LangSmith connection must never hang an
// admin request (the route holds the response open until this fires).
exports.REQUEST_TIMEOUT_MS = 20000;
// Stats window cap: enough depth for a dev project's weekly rollup while
// bounding the paged reads behind it.
const STATS_MAX_RUNS = 500;
// Trace detail cap: trees that exceeded this are truncated, not looped.
const DETAIL_MAX_RUNS = 200;
const ERROR_SNIPPET_CHARS = 300;
class LangsmithError extends Error {
    constructor(message, response) {
        super(message);
        this.response = response;
        this.name = 'LangsmithError';
    }
}
exports.LangsmithError = LangsmithError;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_WAITS_MS = [1000, 2000, 4000];
const fetchWithRetry = (url, init) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const attempt = () => __awaiter(void 0, void 0, void 0, function* () {
        const res = yield fetch(url, Object.assign(Object.assign({}, init), { 
            // Hard cap per attempt — a stalled upstream connection must never
            // hang the admin request indefinitely.
            signal: AbortSignal.timeout(exports.REQUEST_TIMEOUT_MS) }));
        if (!res.ok) {
            const status = res.status;
            throw new LangsmithError(`LangSmith request failed: HTTP ${status}`, res);
        }
        return res.json();
    });
    try {
        return yield attempt();
    }
    catch (err) {
        // The live API rate-limits (429) burstily and 5xxes transiently: retry
        // 429s with backoff (honoring a longer Retry-After), 5xx once after a
        // short wait. Real 4xx errors propagate immediately.
        if (!(err instanceof LangsmithError))
            throw err;
        const status = Number((_a = /HTTP (\d+)/.exec(err.message)) === null || _a === void 0 ? void 0 : _a[1]);
        const isRateLimit = status === 429;
        const isTransient = status >= 500;
        if (!isRateLimit && !isTransient)
            throw err;
        const retryAfterHeader = (_b = err.response) === null || _b === void 0 ? void 0 : _b.headers.get('retry-after');
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const waits = isRateLimit ? RETRY_WAITS_MS : [exports.RETRY_WAIT_MS];
        for (const wait of waits) {
            yield sleep(Number.isFinite(retryAfterSec) ? Math.max(wait, retryAfterSec * 1000) : wait);
            try {
                return yield attempt();
            }
            catch (retryErr) {
                if (!(retryErr instanceof LangsmithError))
                    throw retryErr;
                const retryStatus = Number((_c = /HTTP (\d+)/.exec(retryErr.message)) === null || _c === void 0 ? void 0 : _c[1]);
                if (retryStatus !== 429 && retryStatus < 500)
                    throw retryErr;
            }
        }
        throw new LangsmithError(err.message);
    }
});
const queryRuns = (headers, projectId, body) => fetchWithRetry(`${BASE_URL}/api/v1/runs/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(Object.assign({ session: [projectId] }, body)),
});
const resolveProject = (headers, project) => __awaiter(void 0, void 0, void 0, function* () {
    const res = (yield fetchWithRetry(`${BASE_URL}/api/v1/sessions?name=${encodeURIComponent(project)}&limit=1`, { headers }));
    // Name-match only (same rule as tracePurge): a fallback pick could read
    // runs from a project the config never named.
    if (!Array.isArray(res) || !res.some((s) => s.name === project && s.id)) {
        throw new LangsmithError(`project "${project}" not found`);
    }
    const match = res.find((s) => s.name === project);
    return { id: match.id, name: match.name };
});
// `llm: 'openai/gpt-oss-20b'` → `openai/gpt-oss-20b`; null for anything
// else so non-llm runs never report a model.
const modelFromRunName = (name) => {
    if (!name)
        return null;
    const match = /^llm: '(.+)'$/.exec(name);
    return match ? match[1] : null;
};
exports.modelFromRunName = modelFromRunName;
/*
 * #237: Mastra's router provider id for Fireworks is `fireworks-ai`
 * (MASTRA_PROVIDER_ID in mastraService.ts); the app-level neutral name is
 * `fireworks`. Map it back so a trace provider matches the roster's provider
 * string. Every other id is identical to its roster name.
 */
const MASTRA_PROVIDER_ALIASES = { 'fireworks-ai': 'fireworks' };
// Provider from the MODEL_GENERATION span metadata (`ls_provider`), mapped to
// the app-level provider name. Null when the run carries no provider (non-llm
// runs, or a trace exported before #237).
const providerFromRun = (run) => {
    var _a, _b, _c;
    const provider = (_b = (_a = run.extra) === null || _a === void 0 ? void 0 : _a.metadata) === null || _b === void 0 ? void 0 : _b.ls_provider;
    if (typeof provider !== 'string' || provider.length === 0)
        return null;
    return (_c = MASTRA_PROVIDER_ALIASES[provider]) !== null && _c !== void 0 ? _c : provider;
};
exports.providerFromRun = providerFromRun;
// #237: the run's time-to-first-token. LangSmith exposes it as a first-class
// `first_token_time`; absent on non-streaming runs (a generate call has no
// first-token instant), so it is null there rather than the whole-run duration.
const ttftMsOf = (run) => {
    if (!run.start_time || !run.first_token_time)
        return null;
    const ms = new Date(run.first_token_time).getTime() - new Date(run.start_time).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
exports.ttftMsOf = ttftMsOf;
/*
 * #237: is this llm run a race loser that was aborted rather than a real
 * failure? The aborted provider's stream is cancelled mid-flight, which the
 * exporter records as an errored run. Such a run never served the user, so it
 * must not count toward calls/errors/latency. Matched by name or message, same
 * shape `isClientAbort` uses in modelFailover.ts (kept local to avoid the
 * service importing the routing module).
 */
const isAbortedRun = (run) => {
    var _a;
    const error = (_a = run.error) !== null && _a !== void 0 ? _a : '';
    return /abort|cancel/i.test(error) || /AbortError|CanceledError/.test(error);
};
exports.isAbortedRun = isAbortedRun;
const durationMsOf = (run) => {
    if (!run.start_time || !run.end_time)
        return null;
    const ms = new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
const errorSnippet = (error) => error ? error.slice(0, ERROR_SNIPPET_CHARS) : null;
// Safety cap for the join below: a busy page of tool-heavy traces (up to
// maxSteps llm calls each) must not loop forever on a pathological project.
const JOIN_MAX_PAGES = 10;
// One paged llm-children sweep over a page of root runs: supplies each
// trace's model and its token total (summed across the trace's llm calls —
// multi-step tool turns have one llm child per step, all of the same
// model).
const joinLlmChildren = (headers, projectId, traceIds) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const modelOf = new Map();
    const providerOf = new Map();
    const tokensOf = new Map();
    if (traceIds.length === 0)
        return { modelOf, providerOf, tokensOf };
    const baseFilter = `in(trace_id, [${traceIds.map((id) => `"${id}"`).join(', ')}])`;
    for (let page = 0; page < JOIN_MAX_PAGES; page++) {
        const res = yield queryRuns(headers, projectId, {
            filter: `and(${baseFilter}, eq(run_type, "llm"))`,
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            // #237: `extra` carries `ls_provider`; the model still comes from the
            // run name (the join's existing key).
            select: ['trace_id', 'name', 'total_tokens', 'extra'],
        });
        const children = (_a = res.runs) !== null && _a !== void 0 ? _a : [];
        for (const run of children) {
            if (!run.trace_id)
                continue;
            const model = (0, exports.modelFromRunName)(run.name);
            if (model && !modelOf.has(run.trace_id))
                modelOf.set(run.trace_id, model);
            const provider = (0, exports.providerFromRun)(run);
            if (provider && !providerOf.has(run.trace_id))
                providerOf.set(run.trace_id, provider);
            if (typeof run.total_tokens === 'number' && run.total_tokens > 0) {
                tokensOf.set(run.trace_id, ((_b = tokensOf.get(run.trace_id)) !== null && _b !== void 0 ? _b : 0) + run.total_tokens);
            }
        }
        if (children.length < PAGE_SIZE)
            break;
    }
    return { modelOf, providerOf, tokensOf };
});
const rootFilter = (errorsOnly) => errorsOnly ? 'and(eq(is_root, true), eq(status, "error"))' : 'eq(is_root, true)';
const toTraceRow = (run, join) => {
    var _a, _b, _c, _d, _e, _f;
    if (!run.id || !run.trace_id)
        return null;
    return Object.assign({ id: run.id, traceId: run.trace_id, name: (_a = run.name) !== null && _a !== void 0 ? _a : '', status: (_b = run.status) !== null && _b !== void 0 ? _b : 'unknown', model: (_c = join.modelOf.get(run.trace_id)) !== null && _c !== void 0 ? _c : null, provider: (_d = join.providerOf.get(run.trace_id)) !== null && _d !== void 0 ? _d : null, startedAt: (_e = run.start_time) !== null && _e !== void 0 ? _e : '', durationMs: durationMsOf(run), totalTokens: (_f = join.tokensOf.get(run.trace_id)) !== null && _f !== void 0 ? _f : null, error: errorSnippet(run.error) }, (run.app_path ? { appPath: run.app_path } : {}));
};
const headersFor = (apiKey) => ({
    'x-api-key': apiKey,
    'Content-Type': 'application/json',
});
// Recent root runs, newest first, with the model filter applied post-merge
// (the model lives on a child run name — a server-side filter would mean
// fragile filter-string quoting for no gain at this window size).
const listTraces = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (params = {}) {
    var _a, _b;
    const apiKey = config_1.config.langsmith.apiKey;
    const project = config_1.config.langsmith.project;
    if (!apiKey || !project)
        return null;
    const headers = headersFor(apiKey);
    const resolved = yield resolveProject(headers, project);
    const limit = Math.min(100, Math.max(1, (_a = params.limit) !== null && _a !== void 0 ? _a : 50));
    const res = yield queryRuns(headers, resolved.id, {
        filter: rootFilter(Boolean(params.errorsOnly)),
        limit,
        select: ['id', 'trace_id', 'name', 'status', 'error', 'start_time', 'end_time', 'app_path'],
    });
    const roots = (_b = res.runs) !== null && _b !== void 0 ? _b : [];
    const join = yield joinLlmChildren(headers, resolved.id, roots.map((r) => r.trace_id).filter((id) => Boolean(id)));
    const traces = roots
        .map((run) => toTraceRow(run, join))
        .filter((row) => row !== null)
        .filter((row) => !params.model || row.model === params.model)
        .slice(0, limit);
    return { project: resolved, traces };
});
exports.listTraces = listTraces;
// Full run set of one trace, `chunk:` streaming artifacts dropped (dozens
// per turn, zero duration, no diagnostic value), oldest first so the client
// can render the tree top-down. Pages by PAGE_SIZE — the API rejects any
// per-query limit above 100 (verified live: 101 → 400). Returns an empty
// run list for an unknown trace id — the route distinguishes that as a 404.
const getTrace = (traceId) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const apiKey = config_1.config.langsmith.apiKey;
    const project = config_1.config.langsmith.project;
    if (!apiKey || !project)
        return null;
    const headers = headersFor(apiKey);
    const resolved = yield resolveProject(headers, project);
    const raw = [];
    const filter = `eq(trace_id, "${traceId}")`;
    for (let offset = 0; offset < DETAIL_MAX_RUNS; offset += PAGE_SIZE) {
        const res = yield queryRuns(headers, resolved.id, { filter, limit: PAGE_SIZE, offset });
        const page = (_a = res.runs) !== null && _a !== void 0 ? _a : [];
        raw.push(...page);
        if (page.length < PAGE_SIZE)
            break;
    }
    const kept = raw
        .filter((run) => { var _a; return !((_a = run.name) === null || _a === void 0 ? void 0 : _a.startsWith('chunk:')); })
        .sort((a, b) => { var _a, _b; return new Date((_a = a.start_time) !== null && _a !== void 0 ? _a : 0).getTime() - new Date((_b = b.start_time) !== null && _b !== void 0 ? _b : 0).getTime(); });
    const runs = [];
    for (const run of kept) {
        if (!run.id)
            continue;
        runs.push({
            id: run.id,
            parentId: (_b = run.parent_run_id) !== null && _b !== void 0 ? _b : null,
            name: (_c = run.name) !== null && _c !== void 0 ? _c : '',
            runType: (_d = run.run_type) !== null && _d !== void 0 ? _d : 'unknown',
            status: (_e = run.status) !== null && _e !== void 0 ? _e : 'unknown',
            model: (0, exports.modelFromRunName)(run.name),
            provider: (0, exports.providerFromRun)(run),
            startedAt: (_f = run.start_time) !== null && _f !== void 0 ? _f : '',
            endedAt: (_g = run.end_time) !== null && _g !== void 0 ? _g : null,
            durationMs: durationMsOf(run),
            ttftMs: (0, exports.ttftMsOf)(run),
            totalTokens: typeof run.total_tokens === 'number' ? run.total_tokens : null,
            error: errorSnippet(run.error),
            inputs: (_h = run.inputs) !== null && _h !== void 0 ? _h : null,
            outputs: (_j = run.outputs) !== null && _j !== void 0 ? _j : null,
        });
    }
    return { traceId, runs };
});
exports.getTrace = getTrace;
/*
 * Per-(model, provider) rollup since `days` ago, aggregated from llm runs
 * directly.
 *
 * Why llm runs and not root turns: the model identity and token counts live
 * on the llm children, so a root-based rollup would need a children-join
 * per page (multiplying requests against a burstily rate-limited API — the
 * first live smoke test of that shape hung for minutes). One paged sweep of
 * llm runs answers per-model health in ~STATS_MAX_RUNS/PAGE_SIZE + 2 calls.
 *
 * #237: under racing one model is served by two providers at different
 * pricise; the rollup is now keyed by `(model, provider)`, using the
 * `ls_provider` metadata the exporter already emits. A run without a provider
 * (legacy trace) rolls up under the model with a null provider. Rows also
 * carry `avgTtftMs` from `first_token_time - start_time`, so the runtime TTFT
 * the weighted pick uses can be eyeballed against LangSmith.
 *
 * Semantics, kept honest in the contract: rows count llm *calls* (a tool
 * turn makes several to the same model), and turns that failed before any
 * llm call do not appear here — the traces list's errors-only filter covers
 * turn-level failures. An aborted race loser (an errored run whose error is an
 * abort/cancel) is excluded entirely: it never served the user.
 *
 * #224: each row and the totals also carry the input/output token split
 * (`prompt_tokens`/`completion_tokens`), so the cached rollup can price a
 * model. `totalTokens` is kept as before.
 */
const traceStats = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (days = 7) {
    var _a, _b;
    const apiKey = config_1.config.langsmith.apiKey;
    const project = config_1.config.langsmith.project;
    if (!apiKey || !project)
        return null;
    const headers = headersFor(apiKey);
    const resolved = yield resolveProject(headers, project);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const since = new Date(sinceMs).toISOString();
    const filter = `and(eq(run_type, "llm"), gte(start_time, "${since}"))`;
    const byKey = new Map();
    const totals = { calls: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    // Stable key for `(model, provider)`; the provider is null for a legacy run.
    const keyOf = (model, provider) => `${model}\u0000${provider !== null && provider !== void 0 ? provider : ''}`;
    for (let offset = 0; offset < STATS_MAX_RUNS; offset += PAGE_SIZE) {
        const res = yield queryRuns(headers, resolved.id, {
            filter,
            limit: PAGE_SIZE,
            offset,
            select: [
                'name',
                'status',
                'error',
                'start_time',
                'end_time',
                'total_tokens',
                'prompt_tokens',
                'completion_tokens',
                'first_token_time',
                'extra',
            ],
        });
        const llmRuns = (_a = res.runs) !== null && _a !== void 0 ? _a : [];
        if (llmRuns.length === 0)
            break;
        for (const run of llmRuns) {
            const model = (0, exports.modelFromRunName)(run.name);
            if (!model)
                continue;
            // #237: an aborted race loser never served the user; drop it entirely.
            if ((0, exports.isAbortedRun)(run))
                continue;
            const provider = (0, exports.providerFromRun)(run);
            const duration = durationMsOf(run);
            const ttft = (0, exports.ttftMsOf)(run);
            const tokens = typeof run.total_tokens === 'number' ? run.total_tokens : 0;
            // Token split for cost (#224). Absent/non-numeric counts as 0, same as
            // the total above; `totalTokens` stays the reported run total, not the
            // sum of the split (a run can report a total without the breakdown).
            const inputTokens = typeof run.prompt_tokens === 'number' ? run.prompt_tokens : 0;
            const outputTokens = typeof run.completion_tokens === 'number' ? run.completion_tokens : 0;
            const isError = run.status === 'error';
            const key = keyOf(model, provider);
            const entry = (_b = byKey.get(key)) !== null && _b !== void 0 ? _b : {
                model,
                provider,
                calls: 0,
                errors: 0,
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                durationSum: 0,
                durationCount: 0,
                ttftSum: 0,
                ttftCount: 0,
            };
            entry.calls += 1;
            if (isError)
                entry.errors += 1;
            entry.totalTokens += tokens;
            entry.inputTokens += inputTokens;
            entry.outputTokens += outputTokens;
            if (duration !== null) {
                entry.durationSum += duration;
                entry.durationCount += 1;
            }
            if (ttft !== null) {
                entry.ttftSum += ttft;
                entry.ttftCount += 1;
            }
            byKey.set(key, entry);
            totals.calls += 1;
            if (isError)
                totals.errors += 1;
            totals.totalTokens += tokens;
            totals.inputTokens += inputTokens;
            totals.outputTokens += outputTokens;
        }
        if (llmRuns.length < PAGE_SIZE)
            break;
    }
    const models = [...byKey.values()]
        .map((_a) => {
        var { durationSum, durationCount, ttftSum, ttftCount } = _a, stats = __rest(_a, ["durationSum", "durationCount", "ttftSum", "ttftCount"]);
        return (Object.assign(Object.assign({}, stats), { avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null, avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null, 
            // Cost is joined at read time from the in-DB price (#224); the raw
            // aggregator never prices.
            estimatedCostUsd: null }));
    })
        .sort((a, b) => b.calls - a.calls);
    return { since, models, totals: Object.assign(Object.assign({}, totals), { estimatedCostUsd: null }) };
});
exports.traceStats = traceStats;
