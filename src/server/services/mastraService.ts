import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { buildTracingOptions } from '@mastra/observability';
import { LangSmithExporter, withLangsmithMetadata } from '@mastra/langsmith';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { truncateForPrompt } from './textExtraction';
import { mcpToolsetsForUser } from './mcpService';
import {
  degradedToolError,
  markToolFailed,
  reasonFrom,
  toolDegradeReason,
  toolIsFailed,
} from './toolDegrade';
import {
  CompletionOptions,
  LlmConnector,
  LlmProvider,
  NeutralChunkStream,
  NeutralCompletion,
  TraceContext,
} from './llmTypes';
import { webSearch } from './webSearchService';
import { createSystemAsset } from './systemAssetService';
import { isStorageConfigured } from './storageService';

/*
 * LangSmith tracing (issue #5), via the official Mastra plugin
 * (`@mastra/langsmith`): a singleton `Mastra` instance carries
 * `LangSmithExporter` in its observability config, and every agent call in
 * the process is traced hierarchically (agent run → step → inference → llm,
 * with token usage and latency) into the configured project. Env-gated:
 * with no API key no exporter is configured at all and nothing is posted —
 * the off-path is byte-identical to the pre-#5 behaviour. Credentials are
 * read from `LANGSMITH_API_KEY` (`LANGCHAIN_API_KEY` works too) and the
 * project from `LANGCHAIN_PROJECT` — see `.env.example`.
 */
const langsmithKey = process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY;
const projectName = process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT;

// Mastra docs: storage is required for tracing even when exporting
// externally. Application data stays in MongoDB; `InMemoryStore` only
// backs Mastra's internal snapshot lookups.
export const mastra = new Mastra({
  storage: new InMemoryStore(),
  ...(langsmithKey
    ? {
        observability: new Observability({
          configs: {
            default: {
              serviceName: 'tova',
              exporters: [
                new LangSmithExporter({ apiKey: langsmithKey, projectName: projectName }),
              ],
            },
          },
        }),
      }
    : {}),
});

/*
 * The single owner of all `@mastra/*` imports and of provider construction.
 * Mastra's bundled model router ships both providers inside `@mastra/core`
 * (router ids `groq/<model>` / `deepinfra/<model>`) and reads the keys from
 * `GROQ_API_KEY` / `DEEPINFRA_API_KEY` when none is passed explicitly, so the
 * provider classes reduce to: build an Agent per call aimed at the right
 * router id, and normalise Mastra's AI-SDK-style shapes to the neutral types.
 * Callers never see Mastra or Groq shapes past this module.
 *
 * Mapping notes (verified in the #4 spike):
 * - `agent.generate` resolves to an object with `text`.
 * - `agent.stream` resolves to an output object whose `fullStream` yields
 *   AI-SDK-style chunks; only `text-delta` chunks carry content (in
 *   `payload.text`). Every lifecycle chunk (`start`/`step-start`/
 *   `text-start`/`text-end`/`step-finish`/`finish`) is filtered out — the
 *   SSE contract upstream emits only `{ delta }` chunks. `error` chunks are
 *   rethrown (fail loudly).
 */

/*
 * FullStream chunk shape (verified 2026-09-12 against real Groq/DeepInfra
 * endpoints, `@mastra/core@1.66.0`): content is nested in `payload`, i.e.
 * `{ type: 'text-delta', payload: { text: '...' } }` — flat `chunk.delta`
 * does not exist. Upstream errors surface as `{ type: 'error', payload:
 * { error } }` chunks rather than iterator rejections; they are rethrown
 * here so callers fail loudly instead of seeing a silent all-empty stream.
 */
interface FullStreamChunk {
  type?: string;
  /* For 'text-delta'/'error' the text lives at payload.text / payload.error;
   * for 'tool-call'/'tool-result' (issue #16) the tool name and structured
   * result live at payload.toolName / payload.result — verified against
   * ToolCallPayload/ToolResultPayload in @mastra/core@1.66.0. Tool-call
   * arguments surface as payload.input (AI-SDK shape); some versions use
   * payload.args — both are read (issue #33).
   */
  payload?: {
    text?: string;
    error?: unknown;
    toolName?: string;
    result?: unknown;
    input?: unknown;
    args?: unknown;
  };
}

const errorTextFrom = (payload: FullStreamChunk['payload']): string => {
  const err = payload?.error;
  if (err instanceof Error) return err.message;
  if (typeof (err as { message?: unknown })?.message === 'string')
    return (err as { message: string }).message;
  return JSON.stringify(err);
};

const toNeutralStream = async (fullStream: AsyncIterable<unknown>): Promise<NeutralChunkStream> =>
  (async function* () {
    for await (const raw of fullStream ?? []) {
      const chunk = raw as FullStreamChunk;
      if (chunk?.type === 'error') throw new Error(errorTextFrom(chunk.payload));
      if (chunk?.type === 'text-delta') yield { delta: chunk.payload?.text ?? null };
      // Tool chunks (issue #16): pass the call/result across the neutral
      // boundary so callers can emit 'Searching the web…' status and collect
      // provenance without knowing Mastra's shapes. Only `web_search` calls
      // flow here, but the mapping stays tool-name-agnostic.
      if (chunk?.type === 'tool-call') {
        const rawArgs = chunk.payload?.input ?? chunk.payload?.args ?? undefined;
        const scalarArgs =
          rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
            ? Object.entries(rawArgs as Record<string, unknown>).filter(
                ([, v]) => typeof v === 'string' || typeof v === 'number',
              )
            : [];
        yield {
          toolCall: {
            name: chunk.payload?.toolName ?? '',
            ...(scalarArgs.length > 0 ? { args: Object.fromEntries(scalarArgs) } : {}),
          },
        };
      }
      if (chunk?.type === 'tool-result')
        yield {
          toolResult: { name: chunk.payload?.toolName ?? '', result: chunk.payload?.result },
        };
    }
  })();

/*
 * Omit unset call settings rather than forwarding `temperature: undefined`
 * / `maxOutputTokens: undefined` into Mastra's model settings (undefined
 * keys can trip SDK-level validation; absent keys cannot).
 */
const modelSettingsFrom = (options: CompletionOptions) => ({
  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  ...(options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
});

/*
 * Abort/disconnect plumbing: forward a caller-supplied signal to Mastra's
 * call options (AI-SDK style) instead of sending undefined keys.
 * `maxSteps` caps the agent's own tool loop: with built-in tools attached
 * the agent decides how many rounds to run (search → answer, with a
 * follow-up round allowed); without tools a completion is single-step,
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
const mcpToolsetsFrom = async (options: CompletionOptions) => {
  if (!options.userId) return {};
  const toolsets = await mcpToolsetsForUser(options.userId, { provider: options.provider });
  return Object.keys(toolsets).length ? { toolsets } : {};
};

const callOptionsFrom = (options: CompletionOptions, mode: ToolsMode = 'full') => {
  const requestContext = new RequestContext();
  if (options.userId !== undefined) requestContext.set('userId', options.userId);
  return {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    maxSteps: mode === 'full' ? 4 : 1,
    modelSettings: modelSettingsFrom(options),
    ...traceOptionsFrom(options.trace),
    requestContext,
  };
};

/*
 * Trace attach: plain metadata/tags ride directly on the call, the
 * LangSmith session key goes through the plugin helper. `withLangsmithMetadata`
 * is only consulted when an exporter exists (key present).
 */
const traceOptionsFrom = (trace?: TraceContext) => ({
  ...(trace?.metadata ? { metadata: trace.metadata } : {}),
  ...(trace?.tags?.length ? { tags: trace.tags } : {}),
  ...(langsmithKey && trace?.sessionId
    ? {
        tracingOptions: buildTracingOptions(withLangsmithMetadata({ sessionId: trace.sessionId })),
      }
    : {}),
});

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
const hasSearchKey = (): boolean =>
  Boolean(process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY);

export const webSearchTool = createTool({
  id: 'web_search',
  description:
    'Search the public web for current or factual information. Use it when a question ' +
    'benefits from up-to-date or external information (recent events, prices, ' +
    'documentation); do not use it for opinions, personal data, or general knowledge ' +
    'you are confident about.',
  inputSchema: z.object({ query: z.string().min(1).describe('Web search query') }),
  outputSchema: z.object({
    results: z.array(z.object({ title: z.string(), snippet: z.string(), url: z.string() })),
    // #82: optional — only set when the search itself failed (never for a
    // genuinely-empty search), so the model can tell the failure apart.
    error: z.string().optional(),
  }),
  execute: async ({ query }, ctx) => {
    // #82: a web_search that already failed earlier in this completion
    // short-circuits to the degraded result without another Brave call.
    if (toolIsFailed(ctx, 'web_search'))
      return {
        results: [],
        error: degradedToolError('web_search', toolDegradeReason(ctx, 'web_search')),
      };
    try {
      return { results: await webSearch(query) };
    } catch (error) {
      markToolFailed(ctx, 'web_search', reasonFrom(error));
      return { results: [], error: degradedToolError('web_search', reasonFrom(error)) };
    }
  },
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
const assetFileFrom = (asset: {
  _id: mongoose.Types.ObjectId;
  filename: string;
  contentType: string;
  size: number;
  createdAt?: Date;
}) => ({
  id: asset._id.toString(),
  filename: asset.filename,
  // filename carries the extension hint, but the explicit MIME type keeps
  // the model honest about what a file actually is.
  contentType: asset.contentType,
  size: asset.size,
  createdAt: (asset.createdAt ?? new Date()).toISOString(),
});

export const listFilesTool = createTool({
  id: 'list_files',
  description:
    'List the files in the calling user’s asset library (uploaded documents/text ' +
    'files), newest first, with metadata (filename, type, size, upload date). ' +
    'Call it when the user refers to their files, assets, or library; call it ' +
    'first whenever the user wants anything from the library.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(
      z.object({
        id: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number(),
        createdAt: z.string().describe('Upload time as an ISO 8601 UTC timestamp'),
      }),
    ),
    more: z.boolean().optional().describe('True when the list was truncated at 20'),
    error: z.string().optional(),
  }),
  execute: async (_input, ctx) => {
    // #82: retry-within-completion short-circuit for a previously failed call.
    if (toolIsFailed(ctx, 'list_files'))
      return {
        files: [],
        error: degradedToolError('list_files', toolDegradeReason(ctx, 'list_files')),
      };
    const userId = ctx.requestContext.get('userId') as string | undefined;
    if (!userId) return { files: [], error: 'unavailable' };
    try {
      // 21 rows: 20 returned, the 21st only feeds the `more` flag.
      const rows = await Asset.find({ userId, status: 'ready' })
        .sort({ _id: -1 })
        .limit(21)
        .select('filename contentType size createdAt');
      const hasMore = rows.length > 20;
      return {
        files: rows.slice(0, 20).map((r) => assetFileFrom(r)),
        ...(hasMore ? { more: true } : {}),
      };
    } catch (error) {
      markToolFailed(ctx, 'list_files', reasonFrom(error));
      return { files: [], error: degradedToolError('list_files', reasonFrom(error)) };
    }
  },
});

export const readFileTool = createTool({
  id: 'read_file',
  description:
    'Read a file from the calling user’s asset library by its id (from `list_files`), ' +
    'returning its metadata (filename, type, size, upload date) and extracted text ' +
    'content when any exists.',
  inputSchema: z.object({ id: z.string().min(1) }),
  outputSchema: z.object({
    file: z
      .object({
        id: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number(),
        createdAt: z.string().describe('Upload time as an ISO 8601 UTC timestamp'),
      })
      .optional(),
    content: z.string().nullable().optional(),
    hasText: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ id }, ctx) => {
    // #82: retry-within-completion short-circuit for a previously failed call.
    if (toolIsFailed(ctx, 'read_file'))
      return { error: degradedToolError('read_file', toolDegradeReason(ctx, 'read_file')) };
    const userId = ctx.requestContext.get('userId') as string | undefined;
    if (!userId) return { error: 'unavailable' };
    if (!id || !mongoose.isValidObjectId(id)) {
      return { error: 'not_found' };
    }
    try {
      const asset = await Asset.findOne({ _id: id, userId, status: 'ready' }).select(
        'filename contentType size createdAt textExtracted markdownExtracted',
      );
      if (!asset) return { error: 'not_found' };
      const file = assetFileFrom(asset);
      // Issue #67: markdown conversion is the fallback content source when
      // the fast extraction did not produce text (pdf/docx/html).
      const text = asset.textExtracted ?? asset.markdownExtracted;
      if (text == null) {
        return {
          file,
          content: null,
          hasText: false,
          note:
            'No readable text could be extracted from this file (it is likely a ' +
            'binary type such as an image); use the attach flow to include it in the chat.',
        };
      }
      return { file, content: truncateForPrompt(text), hasText: true };
    } catch (error) {
      markToolFailed(ctx, 'read_file', reasonFrom(error));
      return { error: degradedToolError('read_file', reasonFrom(error)) };
    }
  },
});

/*
 * generate_file tool (issue #66): the agent can create a NEW markdown file
 * in the calling user's asset library out of its own output (notes,
 * summaries, drafts — nothing to do with chat history). Bytes are pushed
 * server-side (no presign round-trip); the file appears in list_files /
 * read_file and the library immediately, indistinguishable from an upload.
 * Errors map to the same typed variants as the other asset tools.
 */
export const generateFileTool = createTool({
  id: 'generate_file',
  description:
    'Create a NEW markdown file in the calling user’s asset library, saved from your ' +
    'own output (notes, summaries, drafts). Use it when the user asks to save, ' +
    'generate or create a file/note/document. Content must be markdown text.',
  inputSchema: z.object({
    filename: z.string().min(1).describe('File name for the library, e.g. meeting-notes.md'),
    content: z.string().min(1).describe('Full markdown content of the file'),
  }),
  outputSchema: z.object({
    file: z
      .object({
        id: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number(),
        createdAt: z.string().describe('Creation time as an ISO 8601 UTC timestamp'),
      })
      .optional(),
    error: z.string().optional(),
  }),
  execute: ({ filename, content }, { requestContext }) =>
    generateFileExecute(filename, content, requestContext),
});

const generateFileExecute = async (
  filename: string,
  content: string,
  requestContext: { get: (key: string) => unknown },
): Promise<{
  file?: { id: string; filename: string; contentType: string; size: number; createdAt: string };
  error?: string;
}> => {
  const userId = requestContext.get('userId') as string | undefined;
  if (!userId) return { error: 'unavailable' };
  if (!isStorageConfigured()) return { error: 'unavailable' };
  try {
    const result = await createSystemAsset(
      userId,
      filename,
      Buffer.from(content, 'utf8'),
      'text/markdown',
    );
    if (!result.ok) return { error: result.code };
    return {
      file: {
        id: result.fileId,
        filename: result.filename,
        contentType: 'text/markdown',
        size: result.size,
        createdAt: result.createdAt.toISOString(),
      },
    };
  } catch {
    return { error: 'unavailable' };
  }
};

/*
 * Built-in clock tool (issue #52): deterministic, zero-dependency, no
 * external calls. It answers "what's the date/time" without a web-search
 * round trip. No user timezone is stored anywhere (#50 model), so the
 * offset is always `null` — the tool and instructions both report UTC so
 * the model stays honest about it.
 */
export const currentDatetimeTool = createTool({
  id: 'current_datetime',
  description:
    'Get the current date and time. Always call this instead of guessing the current ' +
    'date or time. It reports UTC only — it does not know the local time of day.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    utc: z.string().describe('Current time as an ISO 8601 UTC timestamp'),
    timezoneOffsetMinutes: z
      .number()
      .nullable()
      .describe('Minutes from UTC the user is — always null: not resolved yet'),
  }),
  execute: async () => ({ utc: new Date().toISOString(), timezoneOffsetMinutes: null }),
});

const TOOL_INSTRUCTIONS =
  'You may call the `web_search` tool to find current or external information. ' +
  'When the user asks about the current date or time, call the `current_datetime` ' +
  'tool instead of guessing; it reports UTC only, do not convert to local time. ' +
  'Write the query as focused keywords. When search results arrive, answer with ' +
  'terse markdown links ([title](url)) for the claims you used; answer from your ' +
  'own knowledge when no search is needed. When the user refers to their files, ' +
  'assets, or library, call the `list_files` tool to see what they have; call ' +
  '`read_file` with a file id from that list before quoting any file contents, ' +
  'and never invent file contents you have not read. When the user asks you to ' +
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
const agentCache = new Map<string, Agent>();

/**
 * `tools` override: `false` forces a plain agent with no tool attached
 * regardless of the Brave key — used by one-off completions (follow-up
 * suggestions) whose target model may reject tool-carrying requests.
 * `undefined` keeps the default built-in-tools behaviour (#52): the
 * key-free `current_datetime` tool is always attached.
 */
type ToolsMode = 'full' | 'plain';

const agentFor = (provider: LlmProvider, model: string, tools?: boolean): Agent => {
  const mode: ToolsMode = tools === false ? 'plain' : 'full';
  // The tool set is baked into the agent at construction, so the cache key
  // must include the Brave-key state — toggling it without a restart (as
  // tests do) must not hand back a stale full agent without web_search.
  const cacheKey = `${provider}/${model}/${mode}/${hasSearchKey() ? 'search' : 'nosearch'}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;
  const agent = new Agent({
    // The neutral message shape is structurally Core-compatible; the cast
    // exists because the union `role` in the neutral type does not narrow
    // to a single Mastra message variant.
    id: `tova-${provider}`,
    name: `tova-${provider}`,
    instructions: mode === 'full' ? TOOL_INSTRUCTIONS : '',
    model: `${provider}/${model}`,
    ...(mode === 'full'
      ? {
          tools: {
            // web_search stays key-gated (its execution needs a Brave key and
            // degrades to empty results without one); current_datetime has no
            // such dependency (#52).
            ...(hasSearchKey() ? { web_search: webSearchTool } : {}),
            current_datetime: currentDatetimeTool,
            list_files: listFilesTool,
            read_file: readFileTool,
            generate_file: generateFileTool,
          },
        }
      : {}),
  });
  // Register with the singleton so the call context carries observability;
  // unregistered agents generate without spans and LangSmithExporter
  // never sees them. addAgent skips duplicates on the same key.
  mastra.addAgent(agent, cacheKey);
  agentCache.set(cacheKey, agent);
  return agent;
};

const buildConnector = (provider: LlmProvider): LlmConnector => {
  const asMessageList = (messages: CompletionOptions['messages']) =>
    messages as unknown as Parameters<Agent['generate']>[0];
  // #52: the default main-chat path always carries built-in tools now.
  const defaultMode: ToolsMode = 'full';

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const result = await agentFor(provider, options.model).generate(
        asMessageList(options.messages),
        {
          ...callOptionsFrom(options, defaultMode),
          ...(await mcpToolsetsFrom(options)),
        },
      );
      // Tool executions (issue #16): FullOutput.toolResults carries every
      // executed call with its structured result; surfaced so callers can
      // persist sources. Empty/tool-less runs leave it undefined.
      const toolResults = (result as { toolResults?: unknown[] }).toolResults?.map((entry) => {
        const r = entry as { name?: string; result?: unknown };
        return { name: r.name ?? '', result: r.result };
      });
      return {
        choices: [{ message: { content: result.text ?? null } }],
        ...(toolResults?.length ? { toolResults } : {}),
      };
    },
    createStreamingCompletion: async (options: CompletionOptions): Promise<NeutralChunkStream> => {
      const result = await agentFor(provider, options.model).stream(
        asMessageList(options.messages),
        {
          ...callOptionsFrom(options, defaultMode),
          ...(await mcpToolsetsFrom(options)),
        },
      );
      return toNeutralStream(result.fullStream);
    },
    /**
     * One-off completion path for auxiliary generation (title, guard,
     * follow-up suggestions): built with a tool-free agent even when the
     * Brave key is set, so small tool-rejecting models cannot fail the call
     * (issue #41). No tool mapping is needed — a plain agent never emits
     * tool transport.
     */
    createToolFreeCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const result = await agentFor(provider, options.model, false).generate(
        asMessageList(options.messages),
        { ...callOptionsFrom(options), maxSteps: 1 },
      );
      return { choices: [{ message: { content: result.text ?? null } }] };
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
