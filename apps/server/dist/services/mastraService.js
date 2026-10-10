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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fireworksConnector = exports.deepinfraConnector = exports.groqConnector = exports.mastraMessagesFor = exports.currentDatetimeTool = exports.generateFileTool = exports.readFileTool = exports.listFilesTool = exports.fetchUrlTool = exports.webSearchTool = exports.mastra = void 0;
const agent_1 = require("@mastra/core/agent");
const core_1 = require("@mastra/core");
const request_context_1 = require("@mastra/core/request-context");
const storage_1 = require("@mastra/core/storage");
const observability_1 = require("@mastra/observability");
const observability_2 = require("@mastra/observability");
const langsmith_1 = require("@mastra/langsmith");
const traceRedaction_1 = require("./traceRedaction");
const tools_1 = require("@mastra/core/tools");
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const Asset_1 = require("../models/Asset");
const textExtraction_1 = require("./textExtraction");
const mcpService_1 = require("./mcpService");
const toolDegrade_1 = require("./toolDegrade");
const webSearchService_1 = require("./webSearchService");
const webFetchService_1 = require("./webFetchService");
const systemAssetService_1 = require("./systemAssetService");
const workspaceStorage_1 = require("./workspaceStorage");
const config_1 = require("../config");
/*
 * LangSmith tracing (issue #5), via the official Mastra plugin
 * (`@mastra/langsmith`): a singleton `Mastra` instance carries
 * `LangSmithExporter` in its observability config, and every agent call in
 * the process is traced hierarchically (agent run → step → inference → llm,
 * with token usage and latency) into the configured project. Env-gated:
 * with no API key no exporter is configured at all and nothing is posted —
 * the off-path is byte-identical to the pre-#5 behaviour. Credentials are
 * read from `LANGSMITH_API_KEY` (`LANGCHAIN_API_KEY` works too) and the
 * project from `LANGCHAIN_PROJECT` — see `.env.example`. The exporter is
 * wrapped by `RedactedLangSmithExporter` (traceRedaction.ts) so span
 * input/output/error payloads are redacted before they leave the process
 * (issue #145: LangSmith traces are a prompt-leak surface).
 */
const langsmithKey = config_1.config.langsmith.apiKey;
const projectName = config_1.config.langsmith.project;
// Mastra docs: storage is required for tracing even when exporting
// externally. Application data stays in MongoDB; `InMemoryStore` only
// backs Mastra's internal snapshot lookups.
exports.mastra = new core_1.Mastra(Object.assign({ storage: new storage_1.InMemoryStore() }, (langsmithKey
    ? {
        observability: new observability_1.Observability({
            configs: {
                default: {
                    serviceName: 'tova',
                    exporters: [
                        new traceRedaction_1.RedactedLangSmithExporter({
                            apiKey: langsmithKey,
                            projectName,
                        }),
                    ],
                },
            },
        }),
    }
    : {})));
const errorTextFrom = (payload) => {
    const err = payload === null || payload === void 0 ? void 0 : payload.error;
    if (err instanceof Error)
        return err.message;
    if (typeof (err === null || err === void 0 ? void 0 : err.message) === 'string')
        return err.message;
    return JSON.stringify(err);
};
/*
 * Usage normalisation (issue #224): mastra's `LanguageModelUsage` fields are
 * `number | undefined`; drop absent/NaN fields so the neutral boundary keeps
 * "unknown" distinct from a real `0`. Returns undefined when nothing usable
 * was reported, so callers can omit the field entirely.
 */
const normaliseUsage = (usage) => {
    const u = usage;
    if (!u)
        return undefined;
    const pick = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const normalised = {
        inputTokens: pick(u.inputTokens),
        outputTokens: pick(u.outputTokens),
        totalTokens: pick(u.totalTokens),
    };
    return normalised.inputTokens !== undefined ||
        normalised.outputTokens !== undefined ||
        normalised.totalTokens !== undefined
        ? normalised
        : undefined;
};
const toNeutralStream = (fullStream) => __awaiter(void 0, void 0, void 0, function* () {
    return (function () {
        return __asyncGenerator(this, arguments, function* () {
            var _a, e_1, _b, _c;
            var _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
            try {
                for (var _q = true, _r = __asyncValues(fullStream !== null && fullStream !== void 0 ? fullStream : []), _s; _s = yield __await(_r.next()), _a = _s.done, !_a; _q = true) {
                    _c = _s.value;
                    _q = false;
                    const raw = _c;
                    const chunk = raw;
                    if ((chunk === null || chunk === void 0 ? void 0 : chunk.type) === 'error')
                        throw new Error(errorTextFrom(chunk.payload));
                    if ((chunk === null || chunk === void 0 ? void 0 : chunk.type) === 'text-delta')
                        yield yield __await({ delta: (_e = (_d = chunk.payload) === null || _d === void 0 ? void 0 : _d.text) !== null && _e !== void 0 ? _e : null });
                    // Tool chunks (issue #16): pass the call/result across the neutral
                    // boundary so callers can emit 'Searching the web…' status and collect
                    // provenance without knowing Mastra's shapes. Only `web_search` calls
                    // flow here, but the mapping stays tool-name-agnostic.
                    if ((chunk === null || chunk === void 0 ? void 0 : chunk.type) === 'tool-call') {
                        const rawArgs = (_j = (_g = (_f = chunk.payload) === null || _f === void 0 ? void 0 : _f.input) !== null && _g !== void 0 ? _g : (_h = chunk.payload) === null || _h === void 0 ? void 0 : _h.args) !== null && _j !== void 0 ? _j : undefined;
                        const scalarArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
                            ? Object.entries(rawArgs).filter(([, v]) => typeof v === 'string' || typeof v === 'number')
                            : [];
                        yield yield __await({
                            toolCall: Object.assign({ name: (_l = (_k = chunk.payload) === null || _k === void 0 ? void 0 : _k.toolName) !== null && _l !== void 0 ? _l : '' }, (scalarArgs.length > 0 ? { args: Object.fromEntries(scalarArgs) } : {})),
                        });
                    }
                    if ((chunk === null || chunk === void 0 ? void 0 : chunk.type) === 'tool-result')
                        yield yield __await({
                            toolResult: { name: (_o = (_m = chunk.payload) === null || _m === void 0 ? void 0 : _m.toolName) !== null && _o !== void 0 ? _o : '', result: (_p = chunk.payload) === null || _p === void 0 ? void 0 : _p.result },
                        });
                }
            }
            catch (e_1_1) { e_1 = { error: e_1_1 }; }
            finally {
                try {
                    if (!_q && !_a && (_b = _r.return)) yield __await(_b.call(_r));
                }
                finally { if (e_1) throw e_1.error; }
            }
        });
    })();
});
/*
 * Omit unset call settings rather than forwarding `temperature: undefined`
 * / `maxOutputTokens: undefined` into Mastra's model settings (undefined
 * keys can trip SDK-level validation; absent keys cannot).
 */
const modelSettingsFrom = (options) => (Object.assign(Object.assign({}, (options.temperature !== undefined ? { temperature: options.temperature } : {})), (options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {})));
/*
 * Abort/disconnect plumbing: forward a caller-supplied signal to Mastra's
 * call options (AI-SDK style) instead of sending undefined keys.
 * `maxSteps` caps the agent's own tool loop: with built-in tools attached
 * the agent decides how many rounds to run (search → answer, with follow-up
 * rounds allowed — e.g. #159's long-document workflows walk units and emit
 * one file per section, so a low cap silently starves the task of its final
 * answer step); without tools a completion is single-step,
 * as before #16. Since #52 the tools-mode, not the Brave key, drives this:
 * the key-free `current_datetime` keeps tools attached for key-less
 * deployments too.
 *
 * Since #58 the caller's userId rides into Mastra's request context (a
 * fresh `RequestContext` per call, never per agent — agents are memoised
 * per provider/model/mode so per-user state cannot live on them). Tool
 * `execute` receives this context as its second argument and reads
 * `requestContext.get('userId')` to scope per-user work (e.g. asset
 * library lookups).
 */
/*
 * MCP toolsets (#36): when the caller is a user, resolve platform + personal
 * MCP servers into per-call toolsets (resolutions are cached with a short
 * TTL inside mcpService). Empty result -> no `toolsets` key forwarded at
 * all, so a user with zero MCP servers gets the exact pre-#36 call shape.
 */
const mcpToolsetsFrom = (options) => __awaiter(void 0, void 0, void 0, function* () {
    if (!options.userId)
        return {};
    const toolsets = yield (0, mcpService_1.mcpToolsetsForUser)(options.userId);
    return Object.keys(toolsets).length ? { toolsets } : {};
});
const callOptionsFrom = (options, mode = 'full', instructions) => {
    const requestContext = new request_context_1.RequestContext();
    if (options.userId !== undefined)
        requestContext.set('userId', options.userId);
    return Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, (options.abortSignal ? { abortSignal: options.abortSignal } : {})), (instructions ? { instructions } : {})), { maxSteps: mode === 'full' ? 12 : 1, modelSettings: modelSettingsFrom(options) }), traceOptionsFrom(options.trace)), { requestContext });
};
/*
 * Trace attach: plain metadata/tags ride directly on the call, the
 * LangSmith session key goes through the plugin helper. `withLangsmithMetadata`
 * is only consulted when an exporter exists (key present).
 */
const traceOptionsFrom = (trace) => {
    var _a;
    return (Object.assign(Object.assign(Object.assign({}, ((trace === null || trace === void 0 ? void 0 : trace.metadata) ? { metadata: trace.metadata } : {})), (((_a = trace === null || trace === void 0 ? void 0 : trace.tags) === null || _a === void 0 ? void 0 : _a.length) ? { tags: trace.tags } : {})), (langsmithKey && (trace === null || trace === void 0 ? void 0 : trace.sessionId)
        ? {
            tracingOptions: (0, observability_2.buildTracingOptions)((0, langsmith_1.withLangsmithMetadata)({ sessionId: trace.sessionId })),
        }
        : {})));
};
/*
 * Web search tool (issue #16). The tool is defined here, not in a separate
 * `tools/` module, because this file is the single owner of all `@mastra/*`
 * imports — `createTool` comes from `@mastra/core/tools`. Execution is the
 * raw Brave REST client in `webSearchService.ts`; it degrades any failure
 * (missing key, timeout, HTTP error) into an empty result instead of
 * throwing, so a tool call can never fail the chat turn.
 *
 * When the Brave key is unset the tool is not attached at all: the model
 * never sees it and plain chat behaves byte-identically to pre-#16.
 */
const hasSearchKey = () => Boolean(config_1.config.search.braveApiKey);
exports.webSearchTool = (0, tools_1.createTool)({
    id: 'web_search',
    description: 'Search the public web for current or factual information. Use it when a question ' +
        'benefits from up-to-date or external information (recent events, prices, ' +
        'documentation); do not use it for opinions, personal data, or general knowledge ' +
        'you are confident about.',
    inputSchema: zod_1.z.object({ query: zod_1.z.string().min(1).describe('Web search query') }),
    outputSchema: zod_1.z.object({
        results: zod_1.z.array(zod_1.z.object({ title: zod_1.z.string(), snippet: zod_1.z.string(), url: zod_1.z.string() })),
        // #82: optional — only set when the search itself failed (never for a
        // genuinely-empty search), so the model can tell the failure apart.
        error: zod_1.z.string().optional(),
    }),
    execute: (_a, ctx_1) => __awaiter(void 0, [_a, ctx_1], void 0, function* ({ query }, ctx) {
        // #82: a web_search that already failed earlier in this completion
        // short-circuits to the degraded result without another Brave call.
        if ((0, toolDegrade_1.toolIsFailed)(ctx, 'web_search'))
            return {
                results: [],
                error: (0, toolDegrade_1.degradedToolError)('web_search', (0, toolDegrade_1.toolDegradeReason)(ctx, 'web_search')),
            };
        try {
            return { results: yield (0, webSearchService_1.webSearch)(query) };
        }
        catch (error) {
            (0, toolDegrade_1.markToolFailed)(ctx, 'web_search', (0, toolDegrade_1.reasonFrom)(error));
            return { results: [], error: (0, toolDegrade_1.degradedToolError)('web_search', (0, toolDegrade_1.reasonFrom)(error)) };
        }
    }),
});
/*
 * Fetch-url tool (issue #113): a parseable URL the user pasted is a direct
 * link, not a search query, so the agent reads the actual page. Execution
 * is `webFetchService.fetchPage`; like web_search, any failure degrades to
 * a typed error instead of throwing (a tool call must never fail the turn).
 * Unconditionally attached — it needs no API key.
 */
exports.fetchUrlTool = (0, tools_1.createTool)({
    id: 'fetch_url',
    description: 'Fetch the content of a web page at a specific URL (e.g. one the user pasted), ' +
        'returning its title and readable text. Use it whenever the user provides a ' +
        'complete http(s) URL; prefer it over web_search for any such link.',
    inputSchema: zod_1.z.object({ url: zod_1.z.string().min(1).describe('Full http(s) URL to fetch') }),
    outputSchema: zod_1.z.object({
        url: zod_1.z.string().optional(),
        title: zod_1.z.string().optional(),
        content: zod_1.z.string().optional(),
        results: zod_1.z.array(zod_1.z.object({ title: zod_1.z.string(), snippet: zod_1.z.string(), url: zod_1.z.string() })),
        error: zod_1.z.string().optional(),
    }),
    execute: (_a, ctx_1) => __awaiter(void 0, [_a, ctx_1], void 0, function* ({ url }, ctx) {
        // #82: retry-within-completion short-circuit for a previously failed call.
        if ((0, toolDegrade_1.toolIsFailed)(ctx, 'fetch_url'))
            return {
                results: [],
                error: (0, toolDegrade_1.degradedToolError)('fetch_url', (0, toolDegrade_1.toolDegradeReason)(ctx, 'fetch_url')),
            };
        try {
            const page = yield (0, webFetchService_1.fetchPage)(url);
            if (!page)
                return {
                    results: [],
                    error: 'The page could not be retrieved (unsupported content type); ' +
                        'fall back to web_search or answer from your own knowledge.',
                };
            // `results` mirrors web_search's provenance shape so the sources
            // block picks up the fetched page for free.
            return {
                title: page.title,
                content: page.content,
                results: [{ title: page.title, snippet: '', url: page.url }],
            };
        }
        catch (error) {
            (0, toolDegrade_1.markToolFailed)(ctx, 'fetch_url', (0, toolDegrade_1.reasonFrom)(error));
            return { results: [], error: (0, toolDegrade_1.degradedToolError)('fetch_url', (0, toolDegrade_1.reasonFrom)(error)) };
        }
    }),
});
/*
 * Asset-library tools (issue #58). Per-user scoping comes from the request
 * context (never closed over — agents are memoised per provider/model/mode);
 * a missing userId degrades to an explicit `unavailable` result instead of
 * throwing, mirroring `web_search`. Only `ready` assets are exposed, and the
 * ownership filter makes cross-user probes indistinguishable from "not
 * found". The `read_file` tool serves the stored light extraction only —
 * textExtracted null means non-extractable or empty at confirm time, so no
 * Spaces round-trip happens inside a tool.
 */
const assetFileFrom = (asset) => {
    var _a;
    return ({
        id: asset._id.toString(),
        filename: asset.filename,
        // filename carries the extension hint, but the explicit MIME type keeps
        // the model honest about what a file actually is.
        contentType: asset.contentType,
        size: asset.size,
        createdAt: ((_a = asset.createdAt) !== null && _a !== void 0 ? _a : new Date()).toISOString(),
    });
};
exports.listFilesTool = (0, tools_1.createTool)({
    id: 'list_files',
    description: 'List the files in the calling user’s file library (uploaded documents/text ' +
        'files), newest first, with metadata (filename, type, size, upload date). ' +
        'Call it when the user refers to their files or library; call it ' +
        'first whenever the user wants anything from the library.',
    inputSchema: zod_1.z.object({}),
    outputSchema: zod_1.z.object({
        files: zod_1.z.array(zod_1.z.object({
            id: zod_1.z.string(),
            filename: zod_1.z.string(),
            contentType: zod_1.z.string(),
            size: zod_1.z.number(),
            createdAt: zod_1.z.string().describe('Upload time as an ISO 8601 UTC timestamp'),
        })),
        more: zod_1.z.boolean().optional().describe('True when the list was truncated at 20'),
        error: zod_1.z.string().optional(),
    }),
    execute: (_input, ctx) => __awaiter(void 0, void 0, void 0, function* () {
        // #82: retry-within-completion short-circuit for a previously failed call.
        if ((0, toolDegrade_1.toolIsFailed)(ctx, 'list_files'))
            return {
                files: [],
                error: (0, toolDegrade_1.degradedToolError)('list_files', (0, toolDegrade_1.toolDegradeReason)(ctx, 'list_files')),
            };
        const userId = ctx.requestContext.get('userId');
        if (!userId)
            return { files: [], error: 'unavailable' };
        try {
            // 21 rows: 20 returned, the 21st only feeds the `more` flag.
            const rows = yield Asset_1.Asset.find({ userId, status: 'ready' })
                .sort({ _id: -1 })
                .limit(21)
                .select('filename contentType size createdAt');
            const hasMore = rows.length > 20;
            return Object.assign({ files: rows.slice(0, 20).map((r) => assetFileFrom(r)) }, (hasMore ? { more: true } : {}));
        }
        catch (error) {
            (0, toolDegrade_1.markToolFailed)(ctx, 'list_files', (0, toolDegrade_1.reasonFrom)(error));
            return { files: [], error: (0, toolDegrade_1.degradedToolError)('list_files', (0, toolDegrade_1.reasonFrom)(error)) };
        }
    }),
});
exports.readFileTool = (0, tools_1.createTool)({
    id: 'read_file',
    description: 'Read a file from the calling user’s file library by its id (from `list_files`), ' +
        'returning its metadata (filename, type, size, upload date) and extracted text ' +
        'content when any exists. For long documents call with `unitsOnly: true` first ' +
        'to list the document’s units (pages/sections) with a short preview each, then ' +
        'read specific units selectively with `unit: n` or `unit: "start-end"` instead ' +
        'of re-reading the whole file.',
    inputSchema: zod_1.z.object({
        id: zod_1.z.string().min(1),
        // #159 live run: models emit boolean tool args as the string "true" (same
        // wire-encoding drift as numeric `unit`), and a strict boolean schema
        // makes Mastra reject the whole call. The string branch exists to accept
        // those encodings; execute coerces to an actual boolean.
        unitsOnly: zod_1.z.union([zod_1.z.boolean(), zod_1.z.enum(['true', 'false', 'True', 'False'])]).optional(),
        unit: zod_1.z
            .union([zod_1.z.number(), zod_1.z.string()])
            .optional()
            .describe('Unit number (1-based) or inclusive range "start-end" to read selectively'),
    }),
    outputSchema: zod_1.z.object({
        file: zod_1.z
            .object({
            id: zod_1.z.string(),
            filename: zod_1.z.string(),
            contentType: zod_1.z.string(),
            size: zod_1.z.number(),
            createdAt: zod_1.z.string().describe('Upload time as an ISO 8601 UTC timestamp'),
        })
            .optional(),
        content: zod_1.z.string().nullable().optional(),
        hasText: zod_1.z.boolean().optional(),
        units: zod_1.z
            .array(zod_1.z.object({
            index: zod_1.z.number(),
            label: zod_1.z.string(),
            preview: zod_1.z.string(),
        }))
            .optional(),
        note: zod_1.z.string().optional(),
        error: zod_1.z.string().optional(),
    }),
    execute: (_a, ctx_1) => __awaiter(void 0, [_a, ctx_1], void 0, function* ({ id, unitsOnly: rawUnitsOnly, unit }, ctx) {
        var _b, _c;
        // #159: boolean wire-encoding coercion (see inputSchema note).
        const unitsOnly = rawUnitsOnly === undefined ? undefined : /^\s*(true|1)$/i.test(String(rawUnitsOnly));
        // #82: retry-within-completion short-circuit for a previously failed call.
        if ((0, toolDegrade_1.toolIsFailed)(ctx, 'read_file'))
            return { error: (0, toolDegrade_1.degradedToolError)('read_file', (0, toolDegrade_1.toolDegradeReason)(ctx, 'read_file')) };
        const userId = ctx.requestContext.get('userId');
        if (!userId)
            return { error: 'unavailable' };
        if (!id || !mongoose_1.default.isValidObjectId(id)) {
            return { error: 'not_found' };
        }
        try {
            const asset = yield Asset_1.Asset.findOne({ _id: id, userId, status: 'ready' }).select('filename contentType size createdAt textExtracted markdownExtracted units');
            if (!asset)
                return { error: 'not_found' };
            const file = assetFileFrom(asset);
            // #159: per-unit text (one unit per PDF page / top-level section),
            // selected explicitly because the field is `select: false`.
            const units = ((_b = asset.get('units')) !== null && _b !== void 0 ? _b : []);
            const readUnitRange = (from, to) => units.filter((u) => u.index >= from && u.index <= to);
            if (unitsOnly) {
                if (units.length === 0) {
                    return {
                        file,
                        note: 'This document has no per-unit text available; read it without ' +
                            '`unitsOnly` to get its full extracted text.',
                    };
                }
                return {
                    file,
                    units: units.map((u) => ({
                        index: u.index,
                        label: u.label,
                        preview: u.text.slice(0, 120),
                    })),
                };
            }
            if (unit !== undefined) {
                if (units.length === 0) {
                    return {
                        file,
                        note: 'This document has no per-unit text available; read it without the ' +
                            '`unit` parameter to get its full extracted text.',
                    };
                }
                let from;
                let to;
                // Models routinely emit numeric tool args as strings ("58") (#159
                // eval run: the agent burned a step on each retry until it sent the
                // number as JSON). Coerce digit-only strings to numbers first.
                const numeric = typeof unit === 'string' ? /^\s*\d+\s*$/.test(unit) : true;
                if (typeof unit === 'number' || (typeof unit === 'string' && numeric)) {
                    from = to = Math.trunc(Number(unit));
                }
                else {
                    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(unit);
                    if (!range)
                        return { file, error: 'invalid', note: 'unit must be a number or "start-end"' };
                    from = Number(range[1]);
                    to = Number(range[2]);
                }
                if (!Number.isFinite(from) || from < 1 || to < from) {
                    return { file, error: 'invalid', note: `unit must be within 1-${units.length}` };
                }
                const selected = readUnitRange(from, to);
                if (selected.length === 0) {
                    return { file, error: 'invalid', note: `unit must be within 1-${units.length}` };
                }
                return {
                    file,
                    content: (0, textExtraction_1.truncateForPrompt)(selected.map((u) => u.text).join('\n\n')),
                    hasText: true,
                    units: selected.map((u) => ({
                        index: u.index,
                        label: u.label,
                        preview: u.text.slice(0, 120),
                    })),
                };
            }
            // Issue #67: markdown conversion is the fallback content source when
            // the fast extraction did not produce text (pdf/docx/html).
            const text = (_c = asset.textExtracted) !== null && _c !== void 0 ? _c : asset.markdownExtracted;
            if (text == null) {
                return {
                    file,
                    content: null,
                    hasText: false,
                    note: 'No readable text could be extracted from this file (it is likely a ' +
                        'binary type such as an image); use the attach flow to include it in the chat.',
                };
            }
            return { file, content: (0, textExtraction_1.truncateForPrompt)(text), hasText: true };
        }
        catch (error) {
            (0, toolDegrade_1.markToolFailed)(ctx, 'read_file', (0, toolDegrade_1.reasonFrom)(error));
            return { error: (0, toolDegrade_1.degradedToolError)('read_file', (0, toolDegrade_1.reasonFrom)(error)) };
        }
    }),
});
/*
 * generate_file tool (issue #66): the agent can create a NEW markdown file
 * in the calling user's asset library out of its own output (notes,
 * summaries, drafts — nothing to do with chat history). Bytes are pushed
 * server-side (no presign round-trip); the file appears in list_files /
 * read_file and the library immediately, indistinguishable from an upload.
 * Errors map to the same typed variants as the other asset tools.
 */
exports.generateFileTool = (0, tools_1.createTool)({
    id: 'generate_file',
    description: 'Create a NEW markdown file in the calling user’s file library, saved from your ' +
        'own output (notes, summaries, drafts). Use it when the user asks to save, ' +
        'generate or create a file/note/document. Content must be markdown text.',
    inputSchema: zod_1.z.object({
        filename: zod_1.z.string().min(1).describe('File name for the library, e.g. meeting-notes.md'),
        content: zod_1.z.string().min(1).describe('Full markdown content of the file'),
    }),
    outputSchema: zod_1.z.object({
        file: zod_1.z
            .object({
            id: zod_1.z.string(),
            filename: zod_1.z.string(),
            contentType: zod_1.z.string(),
            size: zod_1.z.number(),
            createdAt: zod_1.z.string().describe('Creation time as an ISO 8601 UTC timestamp'),
        })
            .optional(),
        error: zod_1.z.string().optional(),
    }),
    execute: ({ filename, content }, { requestContext }) => generateFileExecute(filename, content, requestContext),
});
const generateFileExecute = (filename, content, requestContext) => __awaiter(void 0, void 0, void 0, function* () {
    const userId = requestContext.get('userId');
    if (!userId)
        return { error: 'unavailable' };
    if (!workspaceStorage_1.spacesWorkspaceStorage.isConfigured())
        return { error: 'unavailable' };
    try {
        const result = yield (0, systemAssetService_1.createSystemAsset)(userId, filename, Buffer.from(content, 'utf8'), 'text/markdown');
        if (!result.ok)
            return { error: result.code };
        return {
            file: {
                id: result.fileId,
                filename: result.filename,
                contentType: 'text/markdown',
                size: result.size,
                createdAt: result.createdAt.toISOString(),
            },
        };
    }
    catch (_a) {
        return { error: 'unavailable' };
    }
});
/*
 * Built-in clock tool (issue #52): deterministic, zero-dependency, no
 * external calls. It answers "what's the date/time" without a web-search
 * round trip. No user timezone is stored anywhere (#50 model), so the
 * offset is always `null` — the tool and instructions both report UTC so
 * the model stays honest about it.
 */
exports.currentDatetimeTool = (0, tools_1.createTool)({
    id: 'current_datetime',
    description: 'Get the current date and time. Always call this instead of guessing the current ' +
        'date or time. It reports UTC only — it does not know the local time of day.',
    inputSchema: zod_1.z.object({}),
    outputSchema: zod_1.z.object({
        utc: zod_1.z.string().describe('Current time as an ISO 8601 UTC timestamp'),
        timezoneOffsetMinutes: zod_1.z
            .number()
            .nullable()
            .describe('Minutes from UTC the user is — always null: not resolved yet'),
    }),
    execute: () => __awaiter(void 0, void 0, void 0, function* () { return ({ utc: new Date().toISOString(), timezoneOffsetMinutes: null }); }),
});
const TOOL_INSTRUCTIONS = 'You may call the `web_search` tool to find current or external information. ' +
    'When the user message contains a complete http(s) URL, do not search — call ' +
    'the `fetch_url` tool with that exact URL and read the returned page content ' +
    'before answering; use it whenever you need the substance of a specific page. ' +
    'When the user asks about the current date or time, call the `current_datetime` ' +
    'tool instead of guessing; it reports UTC only, do not convert to local time. ' +
    'Write the query as focused keywords. When search results arrive, answer with ' +
    'terse markdown links ([title](url)) for the claims you used; answer from your ' +
    'own knowledge when no search is needed. When the user refers to their files ' +
    'or library, call the `list_files` tool to see what they have; call ' +
    '`read_file` with a file id from that list before quoting any file contents, ' +
    'and never invent file contents you have not read. For a long multi-unit ' +
    'document, call `read_file` with `unitsOnly: true` first to see the unit ' +
    '(page/section) list, then read only the relevant units with `unit` — never ' +
    're-read a long document end to end. When the user asks you to ' +
    'save, generate or create a new file, note or document, call `generate_file` ' +
    'with a filename (ending in .md) and the full markdown content; the file then ' +
    'appears in their library and in `list_files` output.';
/*
 * Agents are memoised per provider/model (creation is stateful — Mastra
 * wires an internal store per agent) so repeated turns on the same model
 * reuse one instance. Agent instructions: empty — the system prompt rides
 * in on the message list. With the tool attached a short instruction tells
 * the agent when to search and how to answer (title/snippet/url synthesis).
 */
const agentCache = new Map();
const agentFor = (provider, model, tools) => {
    const mode = tools === false ? 'plain' : 'full';
    // The tool set is baked into the agent at construction, so the cache key
    // must include the Brave-key state — toggling it without a restart (as
    // tests do) must not hand back a stale full agent without web_search.
    const cacheKey = `${provider}/${model}/${mode}/${hasSearchKey() ? 'search' : 'nosearch'}`;
    const cached = agentCache.get(cacheKey);
    if (cached)
        return cached;
    const routerId = MASTRA_PROVIDER_ID[provider];
    const agent = new agent_1.Agent(Object.assign({ 
        // The neutral message shape is structurally Core-compatible; the cast
        // exists because the union `role` in the neutral type does not narrow
        // to a single Mastra message variant.
        id: `tova-${provider}`, name: `tova-${provider}`, instructions: mode === 'full' ? TOOL_INSTRUCTIONS : '', model: `${routerId}/${model}` }, (mode === 'full'
        ? {
            tools: Object.assign(Object.assign({}, (hasSearchKey() ? { web_search: exports.webSearchTool } : {})), { fetch_url: exports.fetchUrlTool, current_datetime: exports.currentDatetimeTool, list_files: exports.listFilesTool, read_file: exports.readFileTool, generate_file: exports.generateFileTool }),
        }
        : {})));
    // Register with the singleton so the call context carries observability;
    // unregistered agents generate without spans and LangSmithExporter
    // never sees them. addAgent skips duplicates on the same key.
    exports.mastra.addAgent(agent, cacheKey);
    agentCache.set(cacheKey, agent);
    return agent;
};
/*
 * Multimodal messages (#115): neutral `image_url` parts map to Mastra's
 * AI-SDK-style `image` part (`image: URL`). Mastra downloads URL-based parts
 * itself and converts them to base64 inside the provider payload — verified
 * live against `deepinfra/Qwen/Qwen3-VL-8B-Instruct` (both URL and data-URI
 * variants), so a presigned Spaces URL is fetchable by this process but never
 * requires the inference endpoint itself to fetch anything. Groq never takes
 * completions with images (#94 policy): part-array content is rejected with a
 * clear error instead of silently flattening.
 */
const mastraMessagesFor = (provider, messages) => {
    if (messages.every((m) => typeof m.content === 'string')) {
        return messages;
    }
    if (provider === 'groq') {
        throw new Error('The Groq connector does not support multimodal (image) content parts');
    }
    return messages.map((message) => typeof message.content === 'string'
        ? message
        : Object.assign(Object.assign({}, message), { content: message.content.map((part) => part.type === 'image_url'
                ? { type: 'image', image: new URL(part.image_url.url) }
                : part) }));
};
exports.mastraMessagesFor = mastraMessagesFor;
/*
 * #198 single-system-message invariant. Qwen3.5 on DeepInfra (and other
 * strict OpenAI-compatible servers) reject any `role: 'system'` message that
 * is not at index 0 — including a second one at index 1 with the provider
 * error "System message must be at the beginning.". Mastra injects the
 * agent's own `instructions` (TOOL_INSTRUCTIONS on the full-tools path) as a
 * leading system message, and the caller's `buildSystemContent(...)` system
 * message rode in right after it, producing exactly that rejected shape.
 *
 * `splitLeadingSystem` pulls the caller's leading system message(s) out of the
 * array so the connector can merge them with the agent's tool instructions
 * into one per-call `instructions` override (D4). Only *leading* system
 * messages are extracted; a system message after a non-system message is a
 * contract violation surfaced loudly rather than silently reordered into a
 * second leading system message (T5).
 */
const splitLeadingSystem = (messages) => {
    let index = 0;
    while (index < messages.length && messages[index].role === 'system')
        index += 1;
    const leading = messages.slice(0, index);
    const rest = messages.slice(index);
    if (rest.some((message) => message.role === 'system')) {
        throw new Error('Non-leading system message in completion request (#198): system messages must ' +
            'come before any user/assistant message so they can be collapsed into a single ' +
            'leading system message.');
    }
    const system = leading
        .map((message) => typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
        .filter((text) => text.length > 0)
        .join('\n\n');
    return { system: system.length > 0 ? system : undefined, rest };
};
/*
 * Merged per-call system prompt (#198): the agent's tool instructions first,
 * mirroring today's index-0 order, then the caller's system content, joined by
 * a blank line (D4/OQ1). A caller with no system message still gets the tool
 * guidance, so the collapse never silently drops it (D3).
 */
const mergedInstructions = (toolInstructions, callerSystem) => [toolInstructions, callerSystem].filter((part) => Boolean(part)).join('\n\n');
/*
 * #232: Mastra's bundled router reaches Fireworks under the provider id
 * `fireworks-ai` (its registry entry is `fireworks-ai`, base URL
 * `https://api.fireworks.ai/inference/v1/`, key `FIREWORKS_API_KEY`). The
 * neutral app-level provider name stays `fireworks`; only the router id that
 * Mastra receives is remapped here. Every other provider id is identical to
 * its Mastra router id.
 */
const MASTRA_PROVIDER_ID = {
    groq: 'groq',
    deepinfra: 'deepinfra',
    fireworks: 'fireworks-ai',
    typesafe: 'typesafe',
};
const buildConnector = (provider) => {
    // #52: the default main-chat path always carries built-in tools now.
    const defaultMode = 'full';
    return {
        createCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c;
            const { system, rest } = splitLeadingSystem(options.messages);
            const result = yield agentFor(provider, options.model).generate((0, exports.mastraMessagesFor)(provider, rest), Object.assign(Object.assign({}, callOptionsFrom(options, defaultMode, mergedInstructions(TOOL_INSTRUCTIONS, system))), (yield mcpToolsetsFrom(options))));
            // Tool executions (issue #16): FullOutput.toolResults carries every
            // executed call with its structured result; surfaced so callers can
            // persist sources. Empty/tool-less runs leave it undefined.
            const toolResults = (_a = result.toolResults) === null || _a === void 0 ? void 0 : _a.map((entry) => {
                var _a;
                const r = entry;
                return { name: (_a = r.name) !== null && _a !== void 0 ? _a : '', result: r.result };
            });
            // Token usage (#224): the turn total across all tool steps, falling back
            // to the last step's usage. Persisted on the assistant message.
            const usage = normaliseUsage((_b = result.totalUsage) !== null && _b !== void 0 ? _b : result.usage);
            return Object.assign(Object.assign({ choices: [{ message: { content: (_c = result.text) !== null && _c !== void 0 ? _c : null } }] }, ((toolResults === null || toolResults === void 0 ? void 0 : toolResults.length) ? { toolResults } : {})), (usage ? { usage } : {}));
        }),
        createStreamingCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () {
            const { system, rest } = splitLeadingSystem(options.messages);
            const result = yield agentFor(provider, options.model).stream((0, exports.mastraMessagesFor)(provider, rest), Object.assign(Object.assign({}, callOptionsFrom(options, defaultMode, mergedInstructions(TOOL_INSTRUCTIONS, system))), (yield mcpToolsetsFrom(options))));
            // #224: resolve usage after the real chunks, as a final `usage` chunk
            // (OQ-9 design a). `totalUsage` is a promise on the stream output; it
            // settles once the stream drains, so awaiting after the loop cannot race.
            const inner = yield toNeutralStream(result.fullStream);
            const streamResult = result;
            return (function () {
                return __asyncGenerator(this, arguments, function* () {
                    var _a, e_2, _b, _c;
                    try {
                        for (var _d = true, inner_1 = __asyncValues(inner), inner_1_1; inner_1_1 = yield __await(inner_1.next()), _a = inner_1_1.done, !_a; _d = true) {
                            _c = inner_1_1.value;
                            _d = false;
                            const chunk = _c;
                            yield yield __await(chunk);
                        }
                    }
                    catch (e_2_1) { e_2 = { error: e_2_1 }; }
                    finally {
                        try {
                            if (!_d && !_a && (_b = inner_1.return)) yield __await(_b.call(inner_1));
                        }
                        finally { if (e_2) throw e_2.error; }
                    }
                    const usage = normaliseUsage(yield __await(streamResult.totalUsage));
                    if (usage)
                        yield yield __await({ usage });
                });
            })();
        }),
        /**
         * One-off completion path for auxiliary generation (title, guard,
         * follow-up suggestions): built with a tool-free agent even when the
         * Brave key is set, so small tool-rejecting models cannot fail the call
         * (issue #41). No tool mapping is needed — a plain agent never emits
         * tool transport.
         */
        createToolFreeCompletion: (options) => __awaiter(void 0, void 0, void 0, function* () {
            var _a;
            const { system, rest } = splitLeadingSystem(options.messages);
            const result = yield agentFor(provider, options.model, false).generate((0, exports.mastraMessagesFor)(provider, rest), Object.assign(Object.assign({}, callOptionsFrom(options, 'plain', mergedInstructions('', system))), { maxSteps: 1 }));
            return { choices: [{ message: { content: (_a = result.text) !== null && _a !== void 0 ? _a : null } }] };
        }),
    };
};
exports.groqConnector = buildConnector('groq');
exports.deepinfraConnector = buildConnector('deepinfra');
exports.fireworksConnector = buildConnector('fireworks');
