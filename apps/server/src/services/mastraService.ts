import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { buildTracingOptions } from '@mastra/observability';
import { withLangsmithMetadata } from '@mastra/langsmith';
import { RedactedLangSmithExporter } from './traceRedaction';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { User } from '../models/User';
import { truncateForPrompt } from './textExtraction';
import { evaluateExpression } from './calculator';
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
  TokenUsage,
  TraceContext,
} from './llmTypes';
import { webSearch } from './webSearchService';
import { fetchPage } from './webFetchService';
import { createSystemAsset } from './systemAssetService';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { config } from '../config';

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
const langsmithKey = config.langsmith.apiKey;
const projectName = config.langsmith.project;

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
                new RedactedLangSmithExporter({
                  apiKey: langsmithKey,
                  projectName,
                }),
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

/*
 * Usage normalisation (issue #224): mastra's `LanguageModelUsage` fields are
 * `number | undefined`; drop absent/NaN fields so the neutral boundary keeps
 * "unknown" distinct from a real `0`. Returns undefined when nothing usable
 * was reported, so callers can omit the field entirely.
 */
const normaliseUsage = (usage: unknown): TokenUsage | undefined => {
  const u = usage as
    { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } | null | undefined;
  if (!u) return undefined;
  const pick = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const normalised: TokenUsage = {
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
 * library lookups). Since #252 the caller's sessionId rides alongside it
 * (`requestContext.get('sessionId')`) so provenance-writing tools can
 * attribute files to their conversation.
 */
/*
 * MCP toolsets (#36): when the caller is a user, resolve platform + personal
 * MCP servers into per-call toolsets (resolutions are cached with a short
 * TTL inside mcpService). Empty result -> no `toolsets` key forwarded at
 * all, so a user with zero MCP servers gets the exact pre-#36 call shape.
 */
const mcpToolsetsFrom = async (options: CompletionOptions) => {
  if (!options.userId) return {};
  const toolsets = await mcpToolsetsForUser(options.userId);
  return Object.keys(toolsets).length ? { toolsets } : {};
};

const callOptionsFrom = (
  options: CompletionOptions,
  mode: ToolsMode = 'full',
  instructions?: string,
) => {
  const requestContext = new RequestContext();
  if (options.userId !== undefined) requestContext.set('userId', options.userId);
  // #252: the chat session rides alongside userId so provenance-writing tools
  // (generate_file) can attribute a file to its conversation without coupling
  // to the LangSmith tracing switch (see CompletionOptions.sessionId).
  if (options.sessionId !== undefined) requestContext.set('sessionId', options.sessionId);
  return {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    // #198: the merged single system message rides in as a per-call override
    // (superseding the agent's default `instructions`, which Mastra would
    // otherwise inject as a second leading system message).
    ...(instructions ? { instructions } : {}),
    // #254: a caller may pin the agent's per-call step cap (the task sequencer
    // sets 1 so one call is one driver-observable step). Absent falls back to
    // the mode default, so every existing chat call site is byte-identical.
    maxSteps: options.maxSteps ?? (mode === 'full' ? 12 : 1),
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
const hasSearchKey = (): boolean => Boolean(config.search.braveApiKey);

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
 * Fetch-url tool (issue #113): a parseable URL the user pasted is a direct
 * link, not a search query, so the agent reads the actual page. Execution
 * is `webFetchService.fetchPage`; like web_search, any failure degrades to
 * a typed error instead of throwing (a tool call must never fail the turn).
 * Unconditionally attached — it needs no API key.
 */
export const fetchUrlTool = createTool({
  id: 'fetch_url',
  description:
    'Fetch the content of a web page at a specific URL (e.g. one the user pasted), ' +
    'returning its title and readable text. Use it whenever the user provides a ' +
    'complete http(s) URL; prefer it over web_search for any such link.',
  inputSchema: z.object({ url: z.string().min(1).describe('Full http(s) URL to fetch') }),
  outputSchema: z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    results: z.array(z.object({ title: z.string(), snippet: z.string(), url: z.string() })),
    error: z.string().optional(),
  }),
  execute: async ({ url }, ctx) => {
    // #82: retry-within-completion short-circuit for a previously failed call.
    if (toolIsFailed(ctx, 'fetch_url'))
      return {
        results: [],
        error: degradedToolError('fetch_url', toolDegradeReason(ctx, 'fetch_url')),
      };
    try {
      const page = await fetchPage(url);
      if (!page)
        return {
          results: [],
          error:
            'The page could not be retrieved (unsupported content type); ' +
            'fall back to web_search or answer from your own knowledge.',
        };
      // `results` mirrors web_search's provenance shape so the sources
      // block picks up the fetched page for free.
      return {
        title: page.title,
        content: page.content,
        results: [{ title: page.title, snippet: '', url: page.url }],
      };
    } catch (error) {
      markToolFailed(ctx, 'fetch_url', reasonFrom(error));
      return { results: [], error: degradedToolError('fetch_url', reasonFrom(error)) };
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
    'List the files in the calling user’s file library (uploaded documents/text ' +
    'files), newest first, with metadata (filename, type, size, upload date). ' +
    'Call it when the user refers to their files or library; call it ' +
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
    'Read a file from the calling user’s file library by its id (from `list_files`), ' +
    'returning its metadata (filename, type, size, upload date) and extracted text ' +
    'content when any exists. For long documents call with `unitsOnly: true` first ' +
    'to list the document’s units (pages/sections) with a short preview each, then ' +
    'read specific units selectively with `unit: n` or `unit: "start-end"` instead ' +
    'of re-reading the whole file.',
  inputSchema: z.object({
    id: z.string().min(1),
    // #159 live run: models emit boolean tool args as the string "true" (same
    // wire-encoding drift as numeric `unit`), and a strict boolean schema
    // makes Mastra reject the whole call. The string branch exists to accept
    // those encodings; execute coerces to an actual boolean.
    unitsOnly: z.union([z.boolean(), z.enum(['true', 'false', 'True', 'False'])]).optional(),
    unit: z
      .union([z.number(), z.string()])
      .optional()
      .describe('Unit number (1-based) or inclusive range "start-end" to read selectively'),
  }),
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
    units: z
      .array(
        z.object({
          index: z.number(),
          label: z.string(),
          preview: z.string(),
        }),
      )
      .optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ id, unitsOnly: rawUnitsOnly, unit }, ctx) => {
    // #159: boolean wire-encoding coercion (see inputSchema note).
    const unitsOnly =
      rawUnitsOnly === undefined ? undefined : /^\s*(true|1)$/i.test(String(rawUnitsOnly));
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
        'filename contentType size createdAt textExtracted markdownExtracted units',
      );
      if (!asset) return { error: 'not_found' };
      const file = assetFileFrom(asset);
      // #159: per-unit text (one unit per PDF page / top-level section),
      // selected explicitly because the field is `select: false`.
      const units = (asset.get('units') ?? []) as { index: number; label: string; text: string }[];
      const readUnitRange = (
        from: number,
        to: number,
      ): { index: number; label: string; text: string }[] =>
        units.filter((u) => u.index >= from && u.index <= to);
      if (unitsOnly) {
        if (units.length === 0) {
          return {
            file,
            note:
              'This document has no per-unit text available; read it without ' +
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
            note:
              'This document has no per-unit text available; read it without the ' +
              '`unit` parameter to get its full extracted text.',
          };
        }
        let from: number;
        let to: number;
        // Models routinely emit numeric tool args as strings ("58") (#159
        // eval run: the agent burned a step on each retry until it sent the
        // number as JSON). Coerce digit-only strings to numbers first.
        const numeric = typeof unit === 'string' ? /^\s*\d+\s*$/.test(unit) : true;
        if (typeof unit === 'number' || (typeof unit === 'string' && numeric)) {
          from = to = Math.trunc(Number(unit));
        } else {
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
          content: truncateForPrompt(selected.map((u) => u.text).join('\n\n')),
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
    'Create a NEW markdown file in the calling user’s file library, saved from your ' +
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
  if (!spacesWorkspaceStorage.isConfigured()) return { error: 'unavailable' };
  // #252: attribute the file to its conversation when a session is on the
  // context; with no session we leave provenance absent (unknown) rather than
  // inventing one (ZDR turns, raced calls, future non-chat callers).
  const sessionId = requestContext.get('sessionId') as string | undefined;
  try {
    const result = await createSystemAsset(
      userId,
      filename,
      Buffer.from(content, 'utf8'),
      'text/markdown',
      sessionId ? { kind: 'chat', sessionId } : undefined,
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
 * round trip. The tool is a per-agent singleton with no per-user context, so
 * it reports the authoritative UTC instant; the system prompt supplies the
 * user's IANA zone and current local time (#261), and the model combines the
 * two. `timezoneOffsetMinutes` stays null here — not resolved in the tool.
 */
export const currentDatetimeTool = createTool({
  id: 'current_datetime',
  description:
    'Get the current date and time as an authoritative UTC instant. Always call this ' +
    'instead of guessing. The system prompt names the user’s timezone and its current ' +
    'offset; use them to state the local time — the tool itself reports UTC.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    utc: z.string().describe('Current time as an ISO 8601 UTC timestamp'),
    timezoneOffsetMinutes: z
      .number()
      .nullable()
      .describe('Minutes from UTC the user is — always null: not resolved in the tool'),
  }),
  execute: async () => ({ utc: new Date().toISOString(), timezoneOffsetMinutes: null }),
});

/*
 * Calculator tool (#283, follow-up to #263). Arithmetic is not a weights task —
 * the model gets multi-digit products and percentages wrong quietly — so it is
 * a tool. The evaluation and its security lockdown live in `calculator.ts`;
 * the tool is a thin, per-agent singleton with no per-user context, so it is
 * always attached (no key gate, unlike `web_search`).
 */
export const calculateTool = createTool({
  id: 'calculate',
  description:
    'Evaluate an arithmetic expression and return the exact numeric result. Use it for ' +
    'any non-trivial calculation — percentages, products, multi-step sums — instead of ' +
    'working it out in your head. Accepts a plain expression using + - * / % ^, ' +
    'parentheses and numeric functions such as sqrt, log, sin, cos, abs, round, min, max ' +
    '(for example "0.18 * 2450 + 137").',
  inputSchema: z.object({
    expression: z.string().describe('A plain arithmetic expression, e.g. "0.18 * 2450 + 137"'),
  }),
  outputSchema: z.object({
    result: z.number().optional().describe('The exact numeric result'),
    error: z.string().optional().describe('Why the expression could not be evaluated'),
  }),
  execute: async ({ expression }) => evaluateExpression(expression),
});

/*
 * Delegate-to-worker tool (#255, epic #251; F2/F3). Creates a task — a
 * first-class stream that runs offline over the workspace — with this chat as
 * its thin origin (`origin: { kind: 'chat', sessionId }`). The task is *not* a
 * chat's child: the chat only references it, and the task never writes the chat
 * stream (single writer per stream). The tool reads `userId`/`sessionId` off the
 * per-call `RequestContext`, exactly like `generateFileExecute` reads them for
 * provenance.
 *
 * ZDR turns cannot delegate: a task is durable by definition (D7). A ZDR turn
 * carries no `sessionId` on the context, and the tool refuses with a graceful
 * result; it also re-reads `User.settings.zdr` (mirroring the creation route's
 * refusal in `routes/tasks.ts`) so the two seams cannot disagree.
 *
 * `taskService` is imported lazily: a top-level import would close a module
 * cycle (`taskService` -> `taskProcessor` -> `taskSequencer` -> `routes/chat` ->
 * `racingService` -> `inferenceService` -> this module). The import happens at
 * execution time, long after every module has loaded.
 */
export const delegateTaskTool = createTool({
  id: 'delegate_task',
  description:
    'Hand a longer piece of agent work to a background worker (a "task") that runs ' +
    'unattended over the user’s workspace: multi-step research, building a document, ' +
    'anything needing more than a quick reply. Returns immediately with a task id; ' +
    'the user can watch and steer it in the Tasks view, and its result is reported ' +
    'back into this chat when it finishes. Use it when the request is substantial and ' +
    'the user is happy for it to run in the background rather than replying now.',
  inputSchema: z.object({
    instruction: z
      .string()
      .min(1)
      .describe('What the worker should accomplish, stated as a complete standalone instruction'),
  }),
  outputSchema: z.object({
    taskId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ instruction }, { requestContext }) => {
    const userId = requestContext.get('userId') as string | undefined;
    const sessionId = requestContext.get('sessionId') as string | undefined;
    // A ZDR turn (or any non-persisted call) has no session to attribute or
    // notify — and a durable task is exactly what ZDR forbids (D7).
    if (!userId || !sessionId) {
      return { error: 'Delegation is not available in this conversation.' };
    }
    try {
      const user = await User.findById(userId);
      if (!user || user.settings?.zdr) {
        return { error: 'Delegation is not available with zero-data-retention enabled.' };
      }
      const { enqueueTask } = await import('./taskService');
      const task = await enqueueTask({
        userId,
        instruction,
        origin: { kind: 'chat', sessionId },
        maxSteps: config.task.maxSteps,
        maxCostUsd: config.task.maxCostUsd,
      });
      return { taskId: String(task._id) };
    } catch {
      return { error: 'Could not start that background task.' };
    }
  },
});

const TOOL_INSTRUCTIONS =
  'You may call the `web_search` tool to find current or external information. ' +
  'When the user message contains a complete http(s) URL, do not search — call ' +
  'the `fetch_url` tool with that exact URL and read the returned page content ' +
  'before answering; use it whenever you need the substance of a specific page. ' +
  'When the user asks about the current date or time, call the `current_datetime` ' +
  'tool instead of guessing; it returns UTC, and the system prompt names the ' +
  'user’s local timezone and offset — state the time in the user’s local zone. ' +
  'For any non-trivial arithmetic — a percentage, a product, a multi-step sum — ' +
  'call the `calculate` tool with a plain numeric expression rather than ' +
  'working it out yourself. ' +
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
  'appears in their library and in `list_files` output. When a request is ' +
  'substantial background work — multi-step research, building a long document, ' +
  'anything that would take many tool calls — call `delegate_task` with a ' +
  'complete standalone instruction to hand it to the worker instead of doing it ' +
  'inline; tell the user it is running in the background and will report back here.';

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
  const routerId = MASTRA_PROVIDER_ID[provider];
  const agent = new Agent({
    // The neutral message shape is structurally Core-compatible; the cast
    // exists because the union `role` in the neutral type does not narrow
    // to a single Mastra message variant.
    id: `tova-${provider}`,
    name: `tova-${provider}`,
    instructions: mode === 'full' ? TOOL_INSTRUCTIONS : '',
    model: `${routerId}/${model}`,
    ...(mode === 'full'
      ? {
          tools: {
            // web_search stays key-gated (its execution needs a Brave key and
            // degrades to empty results without one); current_datetime has no
            // such dependency (#52).
            ...(hasSearchKey() ? { web_search: webSearchTool } : {}),
            fetch_url: fetchUrlTool,
            current_datetime: currentDatetimeTool,
            calculate: calculateTool,
            list_files: listFilesTool,
            read_file: readFileTool,
            generate_file: generateFileTool,
            delegate_task: delegateTaskTool,
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
export const mastraMessagesFor = (
  provider: LlmProvider,
  messages: CompletionOptions['messages'],
): Parameters<Agent['generate']>[0] => {
  if (messages.every((m) => typeof m.content === 'string')) {
    return messages as unknown as Parameters<Agent['generate']>[0];
  }
  if (provider === 'groq') {
    throw new Error('The Groq connector does not support multimodal (image) content parts');
  }
  return messages.map((message) =>
    typeof message.content === 'string'
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === 'image_url'
              ? { type: 'image' as const, image: new URL(part.image_url.url) }
              : part,
          ),
        },
  ) as unknown as Parameters<Agent['generate']>[0];
};

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
const splitLeadingSystem = (
  messages: CompletionOptions['messages'],
): { system: string | undefined; rest: CompletionOptions['messages'] } => {
  let index = 0;
  while (index < messages.length && messages[index].role === 'system') index += 1;
  const leading = messages.slice(0, index);
  const rest = messages.slice(index);
  if (rest.some((message) => message.role === 'system')) {
    throw new Error(
      'Non-leading system message in completion request (#198): system messages must ' +
        'come before any user/assistant message so they can be collapsed into a single ' +
        'leading system message.',
    );
  }
  const system = leading
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    )
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
const mergedInstructions = (toolInstructions: string, callerSystem: string | undefined): string =>
  [toolInstructions, callerSystem].filter((part): part is string => Boolean(part)).join('\n\n');

/*
 * #232: Mastra's bundled router reaches Fireworks under the provider id
 * `fireworks-ai` (its registry entry is `fireworks-ai`, base URL
 * `https://api.fireworks.ai/inference/v1/`, key `FIREWORKS_API_KEY`). The
 * neutral app-level provider name stays `fireworks`; only the router id that
 * Mastra receives is remapped here. Every other provider id is identical to
 * its Mastra router id.
 */
const MASTRA_PROVIDER_ID: Record<LlmProvider, string> = {
  groq: 'groq',
  deepinfra: 'deepinfra',
  fireworks: 'fireworks-ai',
  typesafe: 'typesafe',
};

const buildConnector = (provider: LlmProvider): LlmConnector => {
  // #52: the default main-chat path always carries built-in tools now.
  const defaultMode: ToolsMode = 'full';

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model).generate(
        mastraMessagesFor(provider, rest),
        {
          ...callOptionsFrom(options, defaultMode, mergedInstructions(TOOL_INSTRUCTIONS, system)),
          ...(await mcpToolsetsFrom(options)),
        },
      );
      // Tool executions (issue #16): FullOutput.toolResults carries every
      // executed call with its structured result; surfaced so callers can
      // persist sources. Empty/tool-less runs leave it undefined. #254: the
      // entry's `args` (Mastra's `ToolResultPayload` carries them) ride across
      // too, so the task sequencer can rebuild a step's tool chips and replay
      // its own calls as history — the streaming path already exposes args.
      //
      // Mastra's `ToolResultChunk` nests everything under `payload`
      // (`{ type, runId, from, payload: { toolName, args, result, toolCallId } }`),
      // so the fields live on `entry.payload`, not on the entry itself. Reading
      // the entry directly yielded `name: ''` and a missing `result` — the
      // #254 sequencer's tool chips/replay were silently broken live. Unwrap
      // `payload`, with an entry-level fallback so a future Mastra shape (or a
      // bare payload in tests) still maps.
      const toolResults = (result as { toolResults?: unknown[] }).toolResults?.map((entry) => {
        const outer = entry as {
          payload?: { toolName?: string; name?: string; args?: unknown; result?: unknown };
          toolName?: string;
          name?: string;
          args?: unknown;
          result?: unknown;
        };
        const r = outer.payload ?? outer;
        const args =
          r.args && typeof r.args === 'object' && !Array.isArray(r.args)
            ? (r.args as Record<string, unknown>)
            : undefined;
        return {
          name: r.toolName ?? r.name ?? '',
          result: r.result,
          ...(args ? { args } : {}),
        };
      });
      // Token usage (#224): the turn total across all tool steps, falling back
      // to the last step's usage. Persisted on the assistant message.
      const usage = normaliseUsage(
        (result as { totalUsage?: unknown; usage?: unknown }).totalUsage ??
          (result as { usage?: unknown }).usage,
      );
      return {
        choices: [{ message: { content: result.text ?? null } }],
        ...(toolResults?.length ? { toolResults } : {}),
        ...(usage ? { usage } : {}),
      };
    },
    createStreamingCompletion: async (options: CompletionOptions): Promise<NeutralChunkStream> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model).stream(
        mastraMessagesFor(provider, rest),
        {
          ...callOptionsFrom(options, defaultMode, mergedInstructions(TOOL_INSTRUCTIONS, system)),
          ...(await mcpToolsetsFrom(options)),
        },
      );
      // #224: resolve usage after the real chunks, as a final `usage` chunk
      // (OQ-9 design a). `totalUsage` is a promise on the stream output; it
      // settles once the stream drains, so awaiting after the loop cannot race.
      const inner = await toNeutralStream(result.fullStream);
      const streamResult = result as { totalUsage?: Promise<unknown> };
      return (async function* () {
        for await (const chunk of inner) yield chunk;
        const usage = normaliseUsage(await streamResult.totalUsage);
        if (usage) yield { usage };
      })();
    },
    /**
     * One-off completion path for auxiliary generation (title, guard,
     * follow-up suggestions): built with a tool-free agent even when the
     * Brave key is set, so small tool-rejecting models cannot fail the call
     * (issue #41). No tool mapping is needed — a plain agent never emits
     * tool transport.
     */
    createToolFreeCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model, false).generate(
        mastraMessagesFor(provider, rest),
        { ...callOptionsFrom(options, 'plain', mergedInstructions('', system)), maxSteps: 1 },
      );
      return { choices: [{ message: { content: result.text ?? null } }] };
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
export const fireworksConnector: LlmConnector = buildConnector('fireworks');
