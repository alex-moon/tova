import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTool } from '@mastra/core/tools';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { McpServerDocument } from '../models/McpServer';
import { McpServer } from '../models/McpServer';
import { decryptEnvelope } from './crypto';
import {
  degradedToolError,
  markToolFailed,
  reasonFrom,
  toolDegradeReason,
  toolIsFailed,
} from './toolDegrade';

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
// A cached connection is reused until a call proves it dead; the next access
// reconnects lazily. (Handshake-on-failure keeps the primitive simple: no
// background prober, no stale-clock.)

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ConnectionEntry {
  client: Client;
  tools: McpToolInfo[];
  connectedAt: number;
}

const connectionCache = new Map<string, ConnectionEntry>();

const serversCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<Record<string, Record<string, ReturnType<typeof createTool>>>>;
  }
>();

const connectionCacheKey = (url: string, headers: Record<string, string> | undefined): string =>
  `${url}|${headers ? JSON.stringify(headers) : ''}`;

const authHeaders = (server: McpServerDocument): Record<string, string> | undefined => {
  if (!server.headers || !server.headersConfigured) return undefined;
  try {
    return JSON.parse(decryptEnvelope(server.headers)) as Record<string, string>;
  } catch {
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
export const zodFromJsonSchema = (schema: unknown): z.ZodTypeAny => {
  if (!schema || typeof schema !== 'object') return z.any();
  const s = schema as Record<string, unknown>;
  const described = (base: z.ZodTypeAny): z.ZodTypeAny =>
    typeof s.description === 'string' ? base.describe(s.description) : base;
  switch (s.type) {
    case 'string':
      return described(z.string());
    case 'number':
      return described(z.number());
    case 'integer':
      return described(z.number().int());
    case 'boolean':
      return described(z.boolean());
    case 'null':
      return described(z.null());
    case 'array':
      return described(z.array(zodFromJsonSchema(s.items)));
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(props)) {
        const field = zodFromJsonSchema(value);
        shape[key] = required.includes(key) ? field : field.optional();
      }
      return described(z.looseObject(shape));
    }
    default:
      return described(z.any());
  }
};

const buildTransport = (
  url: string,
  headers: Record<string, string> | undefined,
  prefer: 'streamable' | 'sse',
) => {
  const requestInit = headers ? { headers } : undefined;
  return prefer === 'streamable'
    ? new StreamableHTTPClientTransport(new URL(url), { requestInit })
    : new SSEClientTransport(new URL(url), { requestInit });
};

const asToolInfo = ({
  tools,
}: {
  tools: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
}): McpToolInfo[] =>
  tools
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema:
        t.inputSchema && typeof t.inputSchema === 'object'
          ? (t.inputSchema as Record<string, unknown>)
          : {},
    }));

const handshake = async (
  url: string,
  headers: Record<string, string> | undefined,
): Promise<{ client: Client; tools: McpToolInfo[] }> => {
  let lastError: unknown;
  for (const prefer of ['streamable', 'sse'] as const) {
    const client = new Client({ name: 'tova', version: '0.1.0' });
    try {
      await client.connect(buildTransport(url, headers, prefer), { timeout: CONNECT_TIMEOUT_MS });
      const tools = asToolInfo(await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }));
      return { client, tools };
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('MCP handshake failed');
};

export const listMcpServerTools = async (
  url: string,
  headers?: Record<string, string>,
): Promise<McpToolInfo[]> => {
  const key = connectionCacheKey(url, headers);
  const cached = connectionCache.get(key);
  if (cached) {
    try {
      cached.tools = asToolInfo(
        await cached.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS }),
      );
      cached.connectedAt = Date.now();
      return cached.tools;
    } catch {
      connectionCache.delete(key);
      await cached.client.close().catch(() => undefined);
    }
  }
  const { client, tools } = await handshake(url, headers);
  connectionCache.set(key, { client, tools, connectedAt: Date.now() });
  return tools;
};

/*
 * Call an MCP tool through a (possibly cached) client. One failed call
 * triggers a single fresh handshake + retry; persistent failure degrades to
 * a descriptive `error` result (#82, issue wording) so a dead server can
 * never hang or fail a turn, and the model is told the tool was tried and
 * failed — not left to guess between "unavailable tool" and "empty result".
 */
export const callMcpTool = async (
  url: string,
  headers: Record<string, string> | undefined,
  toolName: string,
  args: unknown,
  // #82: display name used in the model-facing degraded text. The toolset
  // wrapper (the only production caller) passes the qualified tool id so a
  // degraded retry-short-circuit and a degraded live failure read identically.
  displayName?: string,
): Promise<unknown> => {
  let lastError: unknown;
  const resolveClient = async (): Promise<Client> => {
    const key = connectionCacheKey(url, headers);
    const cached = connectionCache.get(key);
    if (cached) {
      try {
        await cached.client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
        return cached.client;
      } catch {
        connectionCache.delete(key);
        await cached.client.close().catch(() => undefined);
      }
    }
    const fresh = await handshake(url, headers);
    connectionCache.set(key, { client: fresh.client, tools: fresh.tools, connectedAt: Date.now() });
    return fresh.client;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      // Retry only on a genuinely fresh connection.
      const key = connectionCacheKey(url, headers);
      connectionCache.delete(key);
    }
    try {
      const client = await resolveClient();
      return await client.callTool(
        { name: toolName, arguments: ((args || {}) as Record<string, unknown>) ?? {} },
        CallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
    } catch (error) {
      lastError = error; // fall through to retry / degraded result
    }
  }
  // The `reason` field (also #82) carries the original failure reason so the
  // toolset wrapper can remember it for short-circuited retries; `error`
  // stays the complete model-facing degraded text.
  return {
    error: degradedToolError(displayName || toolName, reasonFrom(lastError)),
    reason: reasonFrom(lastError),
  };
};

const sanitizeToolsetKey = (name: string): string =>
  `mcp_${name.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40)}`;

/*
 * Per-user toolset resolution: platform servers plus the calling user's own.
 * Connections happen in parallel with a bounded connect timeout so a first
 * chat after adding N servers stays within that bound, never N× it. Any
 * unreachable server is dropped from the set (its tools stop being offered)
 * — chat proceeds degraded, not stalled.
 */
export const mcpToolsetsForUser = async (
  userId?: string,
): Promise<Record<string, Record<string, ReturnType<typeof createTool>>>> => {
  const now = Date.now();
  const cacheKey = userId ?? '__anon__';
  const cached = serversCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = (async () => {
    // userId is a session-string elsewhere in the app, but the Mongo owner
    // field is a real ObjectId: a non-parseable id simply matches no
    // user-scope rows (platform servers still resolve) instead of throwing.
    const ownerId =
      userId && mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : null;
    const servers = await McpServer.find({
      enabled: true,
      $or: [{ scope: 'platform' }, { scope: 'user', userId: ownerId }],
    });
    const live = await Promise.all(
      servers.map(async (server) => {
        try {
          const headers = authHeaders(server);
          const tools = await listMcpServerTools(server.url, headers);
          return { server, headers, tools };
        } catch {
          return null;
        }
      }),
    );
    const toolsets: Record<string, Record<string, ReturnType<typeof createTool>>> = {};
    for (const entry of live) {
      if (!entry) continue;
      const setKey = sanitizeToolsetKey(entry.server.name);
      const tools: Record<string, ReturnType<typeof createTool>> = {};
      for (const toolInfo of entry.tools) {
        if (tools[toolInfo.name]) continue;
        tools[toolInfo.name] = createTool({
          id: `${setKey}/${toolInfo.name}`,
          description: toolInfo.description || `Tool ${toolInfo.name} from an MCP server`,
          inputSchema: zodFromJsonSchema(toolInfo.inputSchema),
          // #82: the wrapper short-circuits when this same tool already
          // failed earlier in the completion (no second handshake), and
          // marks it failed when callMcpTool itself degrades — a retried
          // dead tool then skips both handshakes on the next step.
          execute: async (inputData, ctx) => {
            const toolId = `${setKey}/${toolInfo.name}`;
            if (toolIsFailed(ctx, toolId))
              return { error: degradedToolError(toolId, toolDegradeReason(ctx, toolId)) };
            const { reason, ...visible } = (await callMcpTool(
              entry.server.url,
              entry.headers,
              toolInfo.name,
              inputData,
              toolId,
            )) as Record<string, unknown>;
            if (typeof visible?.error === 'string')
              markToolFailed(ctx, toolId, typeof reason === 'string' ? reason : undefined);
            return visible;
          },
        });
      }
      if (Object.keys(tools).length) toolsets[setKey] = tools;
    }
    return toolsets;
  })();

  // Cache hygiene: a rejection must not outlive the TTL it was stored for.
  // The no-op catch keeps an unawaited cached promise silent; dropping the
  // entry on failure makes the next turn rebuild instead of re-serving a
  // poisoned entry until it expires.
  serversCache.set(cacheKey, { expiresAt: now + SERVERS_CACHE_TTL_MS, promise });
  promise.catch(() => undefined);
  try {
    return await promise;
  } catch (error) {
    if (serversCache.get(cacheKey)?.promise === promise) serversCache.delete(cacheKey);
    throw error;
  }
};

export const clearMcpCachesForTests = (): void => {
  connectionCache.clear();
  serversCache.clear();
};
