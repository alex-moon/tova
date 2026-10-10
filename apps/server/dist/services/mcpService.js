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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearMcpCachesForTests = exports.mcpToolsetsForUser = exports.callMcpTool = exports.listMcpServerTools = exports.zodFromJsonSchema = void 0;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/client/sse.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const tools_1 = require("@mastra/core/tools");
const mongoose_1 = __importDefault(require("mongoose"));
const zod_1 = require("zod");
const McpServer_1 = require("../models/McpServer");
const crypto_1 = require("./crypto");
const toolDegrade_1 = require("./toolDegrade");
/*
 * MCP client bridge (issue #36). Connects to platform and user-configured
 * MCP servers over HTTP transports (streamable first, legacy SSE fallback
 * per the SDK's documented pattern), caches tool lists, and wraps each MCP
 * tool as a Mastra tool that proxies `callTool` server-side. Stdio
 * transports are deliberately out of scope (#36): no child processes.
 */
const CONNECT_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30000;
// How long a cached DB snapshot of a user's MCP servers is trusted. Chat
// turns stay cheap: one query per window, not per message.
const SERVERS_CACHE_TTL_MS = 2000;
const connectionCache = new Map();
const serversCache = new Map();
const connectionCacheKey = (url, headers) => `${url}|${headers ? JSON.stringify(headers) : ''}`;
const authHeaders = (server) => {
    if (!server.headers || !server.headersConfigured)
        return undefined;
    try {
        return JSON.parse((0, crypto_1.decryptEnvelope)(server.headers));
    }
    catch (_a) {
        return undefined;
    }
};
/*
 * JSON Schema -> zod for MCP tool inputs. MCP tools declare JSON Schema;
 * Mastra tools declare zod. Supported shapes: primitives, arrays, buffers of
 * nested objects. Anything unsupported degrades to `z.any()` so a tool can
 * never fail to register. Field descriptions ride into the model-visible
 * schema wherever they appear.
 */
const zodFromJsonSchema = (schema) => {
    var _a;
    if (!schema || typeof schema !== 'object')
        return zod_1.z.any();
    const s = schema;
    const described = (base) => typeof s.description === 'string' ? base.describe(s.description) : base;
    switch (s.type) {
        case 'string':
            return described(zod_1.z.string());
        case 'number':
            return described(zod_1.z.number());
        case 'integer':
            return described(zod_1.z.number().int());
        case 'boolean':
            return described(zod_1.z.boolean());
        case 'null':
            return described(zod_1.z.null());
        case 'array':
            return described(zod_1.z.array((0, exports.zodFromJsonSchema)(s.items)));
        case 'object': {
            const props = ((_a = s.properties) !== null && _a !== void 0 ? _a : {});
            const required = Array.isArray(s.required) ? s.required : [];
            const shape = {};
            for (const [key, value] of Object.entries(props)) {
                const field = (0, exports.zodFromJsonSchema)(value);
                shape[key] = required.includes(key) ? field : field.optional();
            }
            return described(zod_1.z.looseObject(shape));
        }
        default:
            return described(zod_1.z.any());
    }
};
exports.zodFromJsonSchema = zodFromJsonSchema;
const buildTransport = (url, headers, prefer) => {
    const requestInit = headers ? { headers } : undefined;
    return prefer === 'streamable'
        ? new streamableHttp_js_1.StreamableHTTPClientTransport(new URL(url), { requestInit })
        : new sse_js_1.SSEClientTransport(new URL(url), { requestInit });
};
const asToolInfo = ({ tools, }) => tools
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : {},
}));
const handshake = (url, headers) => __awaiter(void 0, void 0, void 0, function* () {
    let lastError;
    for (const prefer of ['streamable', 'sse']) {
        const client = new index_js_1.Client({ name: 'tova', version: '0.1.0' });
        try {
            yield client.connect(buildTransport(url, headers, prefer), { timeout: CONNECT_TIMEOUT_MS });
            const tools = asToolInfo(yield client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }));
            return { client, tools };
        }
        catch (error) {
            lastError = error;
            yield client.close().catch(() => undefined);
        }
    }
    throw lastError instanceof Error ? lastError : new Error('MCP handshake failed');
});
const listMcpServerTools = (url, headers) => __awaiter(void 0, void 0, void 0, function* () {
    const key = connectionCacheKey(url, headers);
    const cached = connectionCache.get(key);
    if (cached) {
        try {
            cached.tools = asToolInfo(yield cached.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }));
            cached.connectedAt = Date.now();
            return cached.tools;
        }
        catch (_a) {
            connectionCache.delete(key);
            yield cached.client.close().catch(() => undefined);
        }
    }
    const { client, tools } = yield handshake(url, headers);
    connectionCache.set(key, { client, tools, connectedAt: Date.now() });
    return tools;
});
exports.listMcpServerTools = listMcpServerTools;
/*
 * Call an MCP tool through a (possibly cached) client. One failed call
 * triggers a single fresh handshake + retry; persistent failure degrades to
 * a descriptive `error` result (#82, issue wording) so a dead server can
 * never hang or fail a turn, and the model is told the tool was tried and
 * failed — not left to guess between "unavailable tool" and "empty result".
 */
const callMcpTool = (url, headers, toolName, args, 
// #82: display name used in the model-facing degraded text. The toolset
// wrapper (the only production caller) passes the qualified tool id so a
// degraded retry-short-circuit and a degraded live failure read identically.
displayName) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    let lastError;
    const resolveClient = () => __awaiter(void 0, void 0, void 0, function* () {
        const key = connectionCacheKey(url, headers);
        const cached = connectionCache.get(key);
        if (cached) {
            try {
                yield cached.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
                return cached.client;
            }
            catch (_a) {
                connectionCache.delete(key);
                yield cached.client.close().catch(() => undefined);
            }
        }
        const fresh = yield handshake(url, headers);
        connectionCache.set(key, { client: fresh.client, tools: fresh.tools, connectedAt: Date.now() });
        return fresh.client;
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
            // Retry only on a genuinely fresh connection.
            const key = connectionCacheKey(url, headers);
            connectionCache.delete(key);
        }
        try {
            const client = yield resolveClient();
            return yield client.callTool({ name: toolName, arguments: (_a = (args || {})) !== null && _a !== void 0 ? _a : {} }, types_js_1.CallToolResultSchema, { timeout: CALL_TIMEOUT_MS });
        }
        catch (error) {
            lastError = error; // fall through to retry / degraded result
        }
    }
    // The `reason` field (also #82) carries the original failure reason so the
    // toolset wrapper can remember it for short-circuited retries; `error`
    // stays the complete model-facing degraded text.
    return {
        error: (0, toolDegrade_1.degradedToolError)(displayName || toolName, (0, toolDegrade_1.reasonFrom)(lastError)),
        reason: (0, toolDegrade_1.reasonFrom)(lastError),
    };
});
exports.callMcpTool = callMcpTool;
const sanitizeToolsetKey = (name) => `mcp_${name.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40)}`;
/*
 * Per-user toolset resolution: platform servers plus the calling user's own.
 * Connections happen in parallel with a bounded connect timeout so a first
 * chat after adding N servers stays within that bound, never N× it. Any
 * unreachable server is dropped from the set (its tools stop being offered)
 * — chat proceeds degraded, not stalled.
 */
const mcpToolsetsForUser = (userId) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const now = Date.now();
    const cacheKey = userId !== null && userId !== void 0 ? userId : '__anon__';
    const cached = serversCache.get(cacheKey);
    if (cached && cached.expiresAt > now)
        return cached.promise;
    const promise = (() => __awaiter(void 0, void 0, void 0, function* () {
        // userId is a session-string elsewhere in the app, but the Mongo owner
        // field is a real ObjectId: a non-parseable id simply matches no
        // user-scope rows (platform servers still resolve) instead of throwing.
        const ownerId = userId && mongoose_1.default.Types.ObjectId.isValid(userId)
            ? new mongoose_1.default.Types.ObjectId(userId)
            : null;
        const servers = yield McpServer_1.McpServer.find({
            enabled: true,
            $or: [{ scope: 'platform' }, { scope: 'user', userId: ownerId }],
        });
        const live = yield Promise.all(servers.map((server) => __awaiter(void 0, void 0, void 0, function* () {
            try {
                const headers = authHeaders(server);
                const tools = yield (0, exports.listMcpServerTools)(server.url, headers);
                return { server, headers, tools };
            }
            catch (_a) {
                return null;
            }
        })));
        const toolsets = {};
        for (const entry of live) {
            if (!entry)
                continue;
            const setKey = sanitizeToolsetKey(entry.server.name);
            const tools = {};
            for (const toolInfo of entry.tools) {
                if (tools[toolInfo.name])
                    continue;
                tools[toolInfo.name] = (0, tools_1.createTool)({
                    id: `${setKey}/${toolInfo.name}`,
                    description: toolInfo.description || `Tool ${toolInfo.name} from an MCP server`,
                    inputSchema: (0, exports.zodFromJsonSchema)(toolInfo.inputSchema),
                    // #82: the wrapper short-circuits when this same tool already
                    // failed earlier in the completion (no second handshake), and
                    // marks it failed when callMcpTool itself degrades — a retried
                    // dead tool then skips both handshakes on the next step.
                    execute: (inputData, ctx) => __awaiter(void 0, void 0, void 0, function* () {
                        const toolId = `${setKey}/${toolInfo.name}`;
                        if ((0, toolDegrade_1.toolIsFailed)(ctx, toolId))
                            return { error: (0, toolDegrade_1.degradedToolError)(toolId, (0, toolDegrade_1.toolDegradeReason)(ctx, toolId)) };
                        const _a = (yield (0, exports.callMcpTool)(entry.server.url, entry.headers, toolInfo.name, inputData, toolId)), { reason } = _a, visible = __rest(_a, ["reason"]);
                        if (typeof (visible === null || visible === void 0 ? void 0 : visible.error) === 'string')
                            (0, toolDegrade_1.markToolFailed)(ctx, toolId, typeof reason === 'string' ? reason : undefined);
                        return visible;
                    }),
                });
            }
            if (Object.keys(tools).length)
                toolsets[setKey] = tools;
        }
        return toolsets;
    }))();
    // Cache hygiene: a rejection must not outlive the TTL it was stored for.
    // The no-op catch keeps an unawaited cached promise silent; dropping the
    // entry on failure makes the next turn rebuild instead of re-serving a
    // poisoned entry until it expires.
    serversCache.set(cacheKey, { expiresAt: now + SERVERS_CACHE_TTL_MS, promise });
    promise.catch(() => undefined);
    try {
        return yield promise;
    }
    catch (error) {
        if (((_a = serversCache.get(cacheKey)) === null || _a === void 0 ? void 0 : _a.promise) === promise)
            serversCache.delete(cacheKey);
        throw error;
    }
});
exports.mcpToolsetsForUser = mcpToolsetsForUser;
const clearMcpCachesForTests = () => {
    connectionCache.clear();
    serversCache.clear();
};
exports.clearMcpCachesForTests = clearMcpCachesForTests;
