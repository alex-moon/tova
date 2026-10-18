import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTool } from '@mastra/core/tools';
import mongoose from 'mongoose';
import { z } from 'zod';
import type { ConnectorDocument } from '../models/Connector';
import { Connector } from '../models/Connector';
import { decryptEnvelope } from './crypto';
import { oauthAuthHeaders } from './oauthConnectors';
import {
  degradedToolError,
  markToolFailed,
  reasonFrom,
  toolDegradeReason,
  toolIsFailed,
} from './toolDegrade';

/* DB-facing layer over the MCP wire code; dispatches auth per type. */
// @see #329 #328 #36

const CONNECT_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30000;
// Cache TTL for a user's connector snapshot: one query per window.
const CONNECTORS_CACHE_TTL_MS = 2000;
// A cached connection is reused until a call proves it dead.

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

const toolsetsCache = new Map<
  string,
  {
    expiresAt: number;
    promise: Promise<Record<string, Record<string, ReturnType<typeof createTool>>>>;
  }
>();

const connectionCacheKey = (url: string, headers: Record<string, string> | undefined): string =>
  `${url}|${headers ? JSON.stringify(headers) : ''}`;

// mcp.pat auth: the encrypted header envelope.
const patAuthHeaders = (connector: ConnectorDocument): Record<string, string> | undefined => {
  if (!connector.headers || !connector.headersConfigured) return undefined;
  try {
    return JSON.parse(decryptEnvelope(connector.headers)) as Record<string, string>;
  } catch {
    return undefined;
  }
};

/* Type-dispatch seam: stored auth → wire headers; unknown → anonymous. */
// @see #329 #327
const authFor = async (
  connector: ConnectorDocument,
): Promise<Record<string, string> | undefined> => {
  switch (connector.type) {
    case 'mcp.pat':
      return patAuthHeaders(connector);
    case 'mcp.oauth':
      return oauthAuthHeaders(connector);
    default:
      return undefined;
  }
};

/* JSON Schema → zod for MCP tool inputs; unsupported shapes → z.any(). */
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

export const listMcpTools = async (
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

/* Call an MCP tool via a cached client; one retry on a fresh handshake. */
// @see #82
export const callMcpTool = async (
  url: string,
  headers: Record<string, string> | undefined,
  toolName: string,
  args: unknown,
  // Display name for model-facing degraded text (qualified tool id).
  // @see #82
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
      lastError = error;
    }
  }
  // `reason` carries the original failure; `error` the degraded text.
  // @see #82
  return {
    error: degradedToolError(displayName || toolName, reasonFrom(lastError)),
    reason: reasonFrom(lastError),
  };
};

const sanitizeToolsetKey = (name: string): string =>
  `mcp_${name.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40)}`;

/* Per-user toolsets: own connectors in parallel; unreachable ones dropped. */
export const connectorToolsetsForUser = async (
  userId?: string,
): Promise<Record<string, Record<string, ReturnType<typeof createTool>>>> => {
  const now = Date.now();
  const cacheKey = userId ?? '__anon__';
  const cached = toolsetsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = (async () => {
    // Owner is a real ObjectId; a bad session id matches no user rows.
    const ownerId =
      userId && mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : null;
    const connectors = await Connector.find({
      enabled: true,
      $or: [{ scope: 'platform' }, { scope: 'user', userId: ownerId }],
    });
    const live = await Promise.all(
      connectors.map(async (connector) => {
        try {
          const headers = await authFor(connector);
          const tools = await listMcpTools(connector.url, headers);
          return { connector, headers, tools };
        } catch {
          return null;
        }
      }),
    );
    const toolsets: Record<string, Record<string, ReturnType<typeof createTool>>> = {};
    for (const entry of live) {
      if (!entry) continue;
      const setKey = sanitizeToolsetKey(entry.connector.name);
      const tools: Record<string, ReturnType<typeof createTool>> = {};
      for (const toolInfo of entry.tools) {
        if (tools[toolInfo.name]) continue;
        tools[toolInfo.name] = createTool({
          id: `${setKey}/${toolInfo.name}`,
          description: toolInfo.description || `Tool ${toolInfo.name} from an MCP server`,
          inputSchema: zodFromJsonSchema(toolInfo.inputSchema),
          // Short-circuit repeats of a failed tool; mark degraded failures.
          // @see #82
          execute: async (inputData, ctx) => {
            const toolId = `${setKey}/${toolInfo.name}`;
            if (toolIsFailed(ctx, toolId))
              return { error: degradedToolError(toolId, toolDegradeReason(ctx, toolId)) };
            const { reason, ...visible } = (await callMcpTool(
              entry.connector.url,
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

  // A rejection must not outlive its TTL; drop the entry on failure.
  toolsetsCache.set(cacheKey, { expiresAt: now + CONNECTORS_CACHE_TTL_MS, promise });
  promise.catch(() => undefined);
  try {
    return await promise;
  } catch (error) {
    if (toolsetsCache.get(cacheKey)?.promise === promise) toolsetsCache.delete(cacheKey);
    throw error;
  }
};

export const clearConnectorCachesForTests = (): void => {
  connectionCache.clear();
  toolsetsCache.clear();
};
