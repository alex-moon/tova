import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { buildTracingOptions } from '@mastra/observability';
import { withLangsmithMetadata } from '@mastra/langsmith';
import { RedactedLangSmithExporter } from './traceRedaction';
import { createTool } from '@mastra/core/tools';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { User } from '../models/User';
import { MAX_PROMPT_TEXT_CHARS, truncateForPrompt } from './textExtraction';
import { evaluateExpression } from './calculator';
import { connectorToolsetsForUser } from './connectorService';
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
import { fetchPage, safeSlice, MAX_FETCH_CHARS, type FetchedPage } from './webFetchService';
import { firecrawlScrape } from './firecrawlService';
import { createSystemAsset, createSystemSideAsset, findFreshScrape } from './systemAssetService';
import { applyAssetEdits, type AssetEdit } from './assetEditService';
import { spacesWorkspaceStorage } from './workspaceStorage';
import { config } from '../config';

/* LangSmith tracing via the official Mastra plugin: a singleton Mastra instance with the redacting exporter; env-gated — with no key nothing is posted and behaviour is byte-identical to pre-#5. */
// @see #5 #145
const langsmithKey = config.langsmith.apiKey;
const projectName = config.langsmith.project;

// Mastra requires storage for tracing even when exporting externally; InMemoryStore only backs internal snapshot lookups — app data stays in MongoDB.
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

/* The single owner of all @mastra/* imports and provider construction: one Agent per call aimed at the right router id, normalising Mastra's AI-SDK shapes to the neutral types; callers never see Mastra shapes past this module. */
// @see #4

/* FullStream chunk shape: content nests in `payload`; upstream errors arrive as `{type:'error'}` chunks and are rethrown so callers fail loudly. */
interface FullStreamChunk {
  type?: string;
  /* Text/error live at payload.text/payload.error; tool name/result at payload.toolName/payload.result; tool args at payload.input (payload.args read too). */
  // @see #16 #33
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

/* Usage normalisation: drop absent/NaN fields so "unknown" stays distinct from a real 0; undefined when nothing usable was reported. */
// @see #224
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
      // Tool chunks pass the call/result across the neutral boundary so callers can emit status and collect provenance without knowing Mastra's shapes; tool-name-agnostic.
      // @see #16
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

/* Omit unset call settings rather than forwarding `temperature: undefined` into Mastra's model settings (undefined keys can trip SDK validation). */
const modelSettingsFrom = (options: CompletionOptions) => ({
  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  ...(options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
});

/* Abort/disconnect plumbing plus `maxSteps` semantics: tools-mode (not the Brave key) drives the loop cap — a low cap starves long-document workflows; userId/sessionId/taskId ride the per-call RequestContext so tools scope per user and attribute provenance, while agents are memoised per provider/model/mode. */
// @see #16 #159 #52 #58 #252 #298
/* Connector toolsets resolve per call (TTL cache) and defer to search via a per-call ToolSearchProcessor; built-ins stay in-prompt. */
// @see #36 #329 #360
export const connectorSearchOptionsFrom = async (options: CompletionOptions) => {
  if (!options.userId) return {};
  const toolsets = await connectorToolsetsForUser(options.userId);
  if (!Object.keys(toolsets).length) return {};
  const catalog: Record<string, (typeof toolsets)[string][string]> = {};
  for (const tools of Object.values(toolsets)) {
    for (const [name, tool] of Object.entries(tools)) {
      // First connector wins on collisions; sanitized id keeps function names provider-safe.
      if (catalog[name]) continue;
      catalog[name] = createTool({
        id: name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: tool.execute,
      });
    }
  }
  return {
    inputProcessors: [
      new ToolSearchProcessor({ tools: catalog, search: { topK: 5, autoLoad: true } }),
    ],
  };
};

const callOptionsFrom = (
  options: CompletionOptions,
  mode: ToolsMode = 'full',
  instructions?: string,
) => {
  const requestContext = new RequestContext();
  if (options.userId !== undefined) requestContext.set('userId', options.userId);
  // The chat session rides alongside userId so provenance-writing tools can attribute a file to its conversation without coupling to the tracing switch.
  // @see #252
  if (options.sessionId !== undefined) requestContext.set('sessionId', options.sessionId);
  // The task id rides alongside so a task-generated file is attributed to its task (the task stream has no session).
  // @see #298
  if (options.taskId !== undefined) requestContext.set('taskId', options.taskId);
  return {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    // The merged single system message rides in as a per-call override, superseding the agent's default instructions (which would be a second leading system message).
    // @see #198
    ...(instructions ? { instructions } : {}),
    // A caller may pin the per-call step cap (the task sequencer sets 1); absent falls back to the mode default.
    // @see #254
    maxSteps: options.maxSteps ?? (mode === 'full' ? 12 : 1),
    modelSettings: modelSettingsFrom(options),
    ...traceOptionsFrom(options.trace),
    requestContext,
  };
};

/* Trace attach: everything rides through `tracingOptions` — Mastra drops top-level metadata/tags call options entirely, while TracingOptions metadata/tags reach the root span. */
// @see #308
const traceOptionsFrom = (trace?: TraceContext) => {
  if (!trace) return {};
  const vendor =
    langsmithKey && trace.sessionId ? withLangsmithMetadata({ sessionId: trace.sessionId }) : null;
  const hasFacts = Boolean(vendor || trace.metadata || trace.tags?.length);
  if (!hasFacts) return {};
  return {
    tracingOptions: buildTracingOptions(...(vendor ? [vendor] : []), (opts) => ({
      ...opts,
      ...(trace.metadata ? { metadata: { ...opts.metadata, ...trace.metadata } } : {}),
      ...(trace.tags?.length ? { tags: [...(opts.tags ?? []), ...trace.tags] } : {}),
    })),
  };
};

/* Web search tool: defined here because this file owns all @mastra/* imports; execution is the raw Brave client degrading any failure to an empty result; with no key the tool is not attached at all. */
// @see #16
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
    // Optional — only set when the search itself failed (never for a genuinely-empty search), so the model can tell the failure apart.
    // @see #82
    error: z.string().optional(),
  }),
  execute: async ({ query }, ctx) => {
    // A web_search that already failed earlier in this completion short-circuits to the degraded result without another Brave call.
    // @see #82
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

/* Fetch-url tool: read a pasted URL directly; failures degrade to a typed error, never failing the turn; a native-fetch failure retries through Firecrawl when configured, and a long scraped page is saved agent-side for read_file. */
// @see #113 #340
const scrapedFilename = (page: FetchedPage): string => {
  let host = '';
  try {
    host = new URL(page.url).hostname.replace(/^www\./, '');
  } catch {
    /* keep '' */
  }
  const slug = (page.title || host || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = slug || 'page';
  return `web-${host ? `${host}-` : ''}${base}.md`.slice(0, 120);
};

const saveScrapedPage = async (
  userId: string,
  page: FetchedPage,
  ctx: { requestContext: { get: (key: string) => unknown } },
  sourceUrl?: string,
): Promise<{ fileId: string; filename: string } | null> => {
  const sessionId = ctx.requestContext.get('sessionId') as string | undefined;
  const taskId = ctx.requestContext.get('taskId') as string | undefined;
  // A ZDR turn persists nothing — exactly the turn with no session and no task — so its scrapes stay head-only.
  // @see #116
  if (!sessionId && !taskId) return null;
  // Same provenance rule as generate_file: attribute to the task, else the chat.
  // @see #252 #298
  const provenance = taskId
    ? ({ kind: 'task', taskId } as const)
    : ({ kind: 'chat', sessionId } as const);
  try {
    return await createSystemSideAsset(
      userId,
      scrapedFilename(page),
      page.content,
      provenance,
      sourceUrl,
    );
  } catch {
    return null;
  }
};

export const fetchUrlTool = createTool({
  id: 'fetch_url',
  description:
    'Fetch the content of a web page at a specific URL (e.g. one the user pasted), ' +
    'returning its title and readable text. Use it whenever the user provides a ' +
    'complete http(s) URL; prefer it over web_search for any such link. A page a ' +
    'plain fetch cannot reach is retried through a hosted scraper; when the page is ' +
    'longer than the preview it is saved agent-side (invisible to the user) and the ' +
    'result carries its `fileId` — tell the user you saved the page so you could ' +
    'read it in full, then read the rest with `read_file` (offset/limit, or ' +
    'unitsOnly for the section list).',
  inputSchema: z.object({ url: z.string().min(1).describe('Full http(s) URL to fetch') }),
  outputSchema: z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    fileId: z
      .string()
      .optional()
      .describe('Agent-side file id when the full page was saved (read it with read_file)'),
    note: z.string().optional(),
    results: z.array(z.object({ title: z.string(), snippet: z.string(), url: z.string() })),
    error: z.string().optional(),
  }),
  execute: async ({ url }, ctx) => {
    // Retry-within-completion short-circuit for a previously failed call.
    // @see #82
    if (toolIsFailed(ctx, 'fetch_url'))
      return {
        results: [],
        error: degradedToolError('fetch_url', toolDegradeReason(ctx, 'fetch_url')),
      };
    const userId = ctx.requestContext.get('userId') as string | undefined;
    let page: FetchedPage | null = null;
    let viaAgentSide = false;
    // Normalized requested URL — the scrape-cache key; declared here because the save below reuses it.
    let cacheKey: string | null = null;
    // Set when the page is (or already was) persisted agent-side, so the result can carry the fileId.
    let saved: { fileId: string; filename: string } | null = null;
    try {
      page = await fetchPage(url);
    } catch (nativeError) {
      // Native fetch failed — retry through Firecrawl when configured.
      // @see #340
      if (!config.firecrawl.apiKey) {
        markToolFailed(ctx, 'fetch_url', reasonFrom(nativeError));
        return { results: [], error: degradedToolError('fetch_url', reasonFrom(nativeError)) };
      }
      // A fresh cached copy of this URL (within the TTL) is reused instead of paying for a re-scrape.
      try {
        cacheKey = new URL(url).toString();
      } catch {
        cacheKey = null; // Invalid URL — firecrawlScrape throws the same below.
      }
      const cached = userId && cacheKey ? await findFreshScrape(userId, cacheKey) : null;
      if (cached && cacheKey) {
        page = { url: cacheKey, title: cached.filename, content: cached.content };
        saved = { fileId: cached.fileId, filename: cached.filename };
        viaAgentSide = true;
      } else {
        try {
          page = await firecrawlScrape(url);
          viaAgentSide = true;
        } catch (scrapeError) {
          markToolFailed(ctx, 'fetch_url', reasonFrom(scrapeError));
          return { results: [], error: degradedToolError('fetch_url', reasonFrom(scrapeError)) };
        }
      }
    }
    if (!page)
      return {
        results: [],
        error:
          'The page could not be retrieved (unsupported content type); ' +
          'fall back to web_search or answer from your own knowledge.',
      };
    // `results` mirrors web_search's provenance shape so the sources block picks up the fetched page for free.
    const results = [{ title: page.title, snippet: '', url: page.url }];
    // A scraped page larger than the visible cap is saved agent-side (invisible to the user) so the agent can read it in full with read_file; short pages need no file, and a cache hit is already saved.
    // @see #340 #350
    if (!saved && viaAgentSide && userId && page.content.length > MAX_FETCH_CHARS) {
      saved = await saveScrapedPage(userId, page, ctx, cacheKey ?? undefined);
    }
    if (saved) {
      return {
        url: page.url,
        title: page.title,
        content: safeSlice(page.content, MAX_FETCH_CHARS),
        fileId: saved.fileId,
        note:
          `The page was longer than this preview, so a full copy is saved as a ` +
          `file ("${saved.filename}", id ${saved.fileId}) — tell the user you saved ` +
          'it so you could read it in full (they can see it in Files under the ' +
          'Agent files filter). Use read_file to read the rest: offset/limit for ' +
          'a line range, or unitsOnly for the section list.',
        results,
      };
    }
    return {
      url: page.url,
      title: page.title,
      content: safeSlice(page.content, MAX_FETCH_CHARS),
      results,
    };
  },
});

/* Asset-library tools: per-user scoping from the request context (agents are memoised, never closed over); a missing userId degrades to an explicit `unavailable` result; only `ready` assets are exposed and ownership filtering makes cross-user probes read as "not found"; read_file serves the stored extraction only — no Spaces round-trip inside a tool. */
// @see #58
const assetFileFrom = (asset: {
  _id: mongoose.Types.ObjectId;
  filename: string;
  contentType: string;
  size: number;
  createdAt?: Date;
  sourceUrl?: string | null;
}) => ({
  id: asset._id.toString(),
  filename: asset.filename,
  // filename carries the extension hint, but the explicit MIME type keeps the model honest about what a file actually is.
  contentType: asset.contentType,
  size: asset.size,
  createdAt: (asset.createdAt ?? new Date()).toISOString(),
  // Present on system-side rows only — the URL the page was fetched from, so the agent can match a cached copy.
  // @see #356
  ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}),
});

export const listFilesTool = createTool({
  id: 'list_files',
  description:
    'List the files in the calling user’s file library, newest first, with metadata ' +
    '(filename, type, size, upload date). Covers uploaded documents/text files, ' +
    'files Tova generated, and cached copies of web pages fetch_url saved for the ' +
    'agent (those carry a `sourceUrl` — the page they were scraped from) and can be ' +
    'read in full with `read_file`. Call it when the user refers to their files or ' +
    'library, or to find a previously fetched page; call it first whenever the user ' +
    'wants anything from the library.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    files: z.array(
      z.object({
        id: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number(),
        createdAt: z.string().describe('Upload time as an ISO 8601 UTC timestamp'),
        sourceUrl: z
          .string()
          .optional()
          .describe('For cached web pages: the URL the page was fetched from'),
      }),
    ),
    more: z.boolean().optional().describe('True when the list was truncated at 20'),
    error: z.string().optional(),
  }),
  execute: async (_input, ctx) => {
    // Retry-within-completion short-circuit for a previously failed call.
    // @see #82
    if (toolIsFailed(ctx, 'list_files'))
      return {
        files: [],
        error: degradedToolError('list_files', toolDegradeReason(ctx, 'list_files')),
      };
    const userId = ctx.requestContext.get('userId') as string | undefined;
    if (!userId) return { files: [], error: 'unavailable' };
    try {
      // 21 rows: 20 returned, the 21st only feeds the `more` flag. Agent-side rows ARE listed with their sourceUrl so the agent can rediscover a cached page in a later session; no leak to the user UI (the route keeps its own exclusion).
      // @see #356
      const rows = await Asset.find({ userId, status: 'ready' })
        .sort({ _id: -1 })
        .limit(21)
        .select('filename contentType size createdAt sourceUrl');
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
    'content when any exists. Read long documents in slices with `offset` (1-based ' +
    'start line) and `limit` (number of lines); every result reports `totalLines`, ' +
    '`totalChars` and whether more remains (`truncated`). To navigate a long ' +
    'document, call with `unitsOnly: true` first to list its units (pages/sections) ' +
    'as a table of contents with each unit’s `startLine`, then read from that line.',
  inputSchema: z.object({
    id: z.string().min(1),
    // Models emit boolean tool args as the string "true" (wire-encoding drift), and a strict boolean schema makes Mastra reject the whole call; execute coerces to an actual boolean.
    // @see #159
    unitsOnly: z.union([z.boolean(), z.enum(['true', 'false', 'True', 'False'])]).optional(),
    // Models also emit numeric tool args as strings; execute coerces digit-only strings to numbers.
    // @see #350
    offset: z
      .union([z.number(), z.string()])
      .optional()
      .describe('1-based line number to start reading from (default 1)'),
    limit: z
      .union([z.number(), z.string()])
      .optional()
      .describe('Maximum number of lines to return from offset'),
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
          startLine: z.number().optional().describe('1-based line where this unit begins'),
          preview: z.string(),
        }),
      )
      .optional(),
    totalLines: z.number().optional(),
    totalChars: z.number().optional(),
    offset: z.number().optional().describe('1-based line the returned content starts at'),
    endLine: z.number().optional().describe('1-based line the returned content ends at'),
    truncated: z.boolean().optional().describe('True when more text remains beyond this read'),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ id, unitsOnly: rawUnitsOnly, offset: rawOffset, limit: rawLimit }, ctx) => {
    // Boolean wire-encoding coercion (see inputSchema note).
    // @see #159
    const unitsOnly =
      rawUnitsOnly === undefined ? undefined : /^\s*(true|1)$/i.test(String(rawUnitsOnly));
    // Retry-within-completion short-circuit for a previously failed call.
    // @see #82
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
      // Per-unit text (one unit per PDF page / top-level section), selected explicitly because the field is `select: false`.
      // @see #159
      const units = (asset.get('units') ?? []) as { index: number; label: string; text: string }[];
      // Markdown conversion is the fallback content source when fast extraction produced nothing.
      // @see #67
      const text = asset.textExtracted ?? asset.markdownExtracted;
      // Units are a table of contents — each points at the line where it begins; computed at read time so pre-#350 rows still get start lines.
      // @see #350
      const startLineOf = (needle: string): number | undefined => {
        if (!text || !needle) return undefined;
        const at = text.indexOf(needle);
        return at < 0 ? undefined : text.slice(0, at).split('\n').length;
      };
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
            startLine: startLineOf(u.text),
            preview: u.text.slice(0, 120),
          })),
        };
      }
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
      // Line-range read over the extracted text; numeric args may arrive as digit-only strings, so coerce before validating.
      // @see #350 #159
      const coerceLine = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
        if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
        return null;
      };
      const lines = text.split('\n');
      const totalLines = lines.length;
      const totalChars = text.length;
      const offset = rawOffset === undefined ? 1 : coerceLine(rawOffset);
      if (offset === null || offset < 1 || offset > totalLines) {
        return {
          file,
          error: 'invalid',
          note: `offset must be within 1-${totalLines}`,
          totalLines,
          totalChars,
        };
      }
      const limit = rawLimit === undefined ? undefined : coerceLine(rawLimit);
      if (limit !== undefined && (limit === null || limit < 1)) {
        return { file, error: 'invalid', note: 'limit must be a positive line count' };
      }
      const endLine = limit === undefined ? totalLines : Math.min(offset + limit - 1, totalLines);
      const joined = lines.slice(offset - 1, endLine).join('\n');
      const content = truncateForPrompt(joined);
      const truncated = endLine < totalLines || joined.length > MAX_PROMPT_TEXT_CHARS;
      return {
        file,
        content,
        hasText: true,
        offset,
        endLine,
        totalLines,
        totalChars,
        truncated,
        ...(truncated
          ? {
              note:
                `Showing lines ${offset}-${endLine} of ${totalLines}. ` +
                `Call read_file again with offset=${endLine + 1} to continue.`,
            }
          : {}),
      };
    } catch (error) {
      markToolFailed(ctx, 'read_file', reasonFrom(error));
      return { error: degradedToolError('read_file', reasonFrom(error)) };
    }
  },
});

/* generate_file tool: the agent can create a NEW markdown file in the calling user's library from its own output; bytes pushed server-side; errors map to the same typed variants as the other asset tools. */
// @see #66
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
  // Attribute the file to its conversation when a session is on the context; with no session, leave provenance absent (unknown) rather than inventing one; a task-origin call stamps `kind: 'task'` and takes precedence.
  // @see #252 #298
  const sessionId = requestContext.get('sessionId') as string | undefined;
  const taskId = requestContext.get('taskId') as string | undefined;
  const provenance = taskId
    ? ({ kind: 'task', taskId } as const)
    : sessionId
      ? ({ kind: 'chat', sessionId } as const)
      : undefined;
  try {
    const result = await createSystemAsset(
      userId,
      filename,
      Buffer.from(content, 'utf8'),
      'text/markdown',
      provenance,
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

/* edit_file tool: revise an assistant-generated file with search/replace blocks (cost proportional to the edit); only system-generated files are editable, provenance untouched, each write snapshots a new version. */
// @see #325
export const editFileTool = createTool({
  id: 'edit_file',
  description:
    'Edit a markdown file that you previously created with `generate_file` in the ' +
    'calling user’s file library. Use it to update, revise or fix an existing file ' +
    'instead of generating a new one. Provide the file id (from `list_files`) and one ' +
    'or more search/replace edits: each `oldText` must be a unique block of the ' +
    'file’s current text and `newText` its replacement. Call `read_file` first to get ' +
    'the current text when unsure; preserve exact indentation and never include ' +
    'line-number prefixes in oldText. If there is no exact match, the edit retries ' +
    'while ignoring typographic quote, dash, and space variants, then trailing ' +
    'whitespace on each line — but it still fails if oldText is absent or matches ' +
    'more than one place. The file keeps its id and provenance; every edit is kept ' +
    'as a new version.',
  inputSchema: z.object({
    id: z.string().min(1).describe('The file id from `list_files`'),
    edits: z
      .array(
        z.object({
          oldText: z
            .string()
            .min(1)
            .describe('Existing text to replace; must occur exactly once in the file'),
          newText: z.string().describe('Replacement text (may be empty to delete the block)'),
        }),
      )
      .min(1)
      .describe('One or more search/replace edits, applied in order'),
  }),
  outputSchema: z.object({
    file: z
      .object({
        id: z.string(),
        filename: z.string(),
        contentType: z.string(),
        size: z.number(),
        version: z.number().describe('The new version number after this edit'),
        createdAt: z.string().describe('Creation time as an ISO 8601 UTC timestamp'),
      })
      .optional(),
    diff: z
      .string()
      .optional()
      .describe('Unified diff of the edit (before → after), so the change is auditable'),
    error: z.string().optional(),
    note: z.string().optional(),
  }),
  execute: ({ id, edits }, { requestContext }) => editFileExecute(id, edits, requestContext),
});

const editFileExecute = async (
  id: string,
  edits: AssetEdit[],
  requestContext: { get: (key: string) => unknown },
): Promise<{
  file?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    version: number;
    createdAt: string;
  };
  diff?: string;
  error?: string;
  note?: string;
}> => {
  const userId = requestContext.get('userId') as string | undefined;
  if (!userId) return { error: 'unavailable' };
  if (!spacesWorkspaceStorage.isConfigured()) return { error: 'unavailable' };
  if (!id || !mongoose.isValidObjectId(id)) return { error: 'not_found' };
  try {
    const asset = await Asset.findOne({ _id: id, userId, status: 'ready' });
    if (!asset) return { error: 'not_found' };
    // Captured before the write: the unified diff of the edit is returned so the change is auditable in the conversation.
    const before = asset.textExtracted ?? '';
    const result = await applyAssetEdits(asset, edits);
    if (!result.ok) return { error: result.code, note: result.message };
    const file = result.asset;
    return {
      file: {
        id: String(file._id),
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        version: file.version ?? 1,
        createdAt: (file.createdAt ?? new Date()).toISOString(),
      },
      diff: createTwoFilesPatch(asset.filename, asset.filename, before, file.textExtracted ?? ''),
    };
  } catch {
    return { error: 'unavailable' };
  }
};

/* Built-in clock tool: deterministic UTC instant, no external calls; the system prompt supplies the user's zone and the model combines the two. */
// @see #52 #261
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

/* Calculator tool: arithmetic is not a weights task; the evaluation and its security lockdown live in calculator.ts; thin per-agent singleton, always attached. */
// @see #283 #263
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

/* Delegate-to-worker tool: creates a task with this chat as its thin origin; the chat never receives task writes (single writer per stream). ZDR turns cannot delegate (a task is durable) and re-check settings.zdr so the seams cannot disagree; taskService is imported lazily to avoid a module cycle. */
// @see #255 #251
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
    // A ZDR turn (or any non-persisted call) has no session to attribute or notify — and a durable task is exactly what ZDR forbids.
    // @see #255
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
  'and never invent file contents you have not read. For a long document, call ' +
  '`read_file` with `unitsOnly: true` first to see the unit (page/section) list ' +
  'with each unit’s start line, then read only the lines you need with `offset` ' +
  'and `limit` — never re-read a long document end to end. When the user asks you to ' +
  'save, generate or create a new file, note or document, call `generate_file` ' +
  'with a filename (ending in .md) and the full markdown content; the file then ' +
  'appears in their library and in `list_files` output. When the user asks to ' +
  'update, revise, fix or add to a file you previously generated, do not create a ' +
  'new one — call `edit_file` with that file’s id and search/replace edits whose ' +
  '`oldText` is copied exactly from its current text (call `read_file` first if ' +
  'unsure); each edit is saved as a new version. When a request is ' +
  'substantial background work — multi-step research, building a long document, ' +
  'anything that would take many tool calls — call `delegate_task` with a ' +
  'complete standalone instruction to hand it to the worker instead of doing it ' +
  'inline; tell the user it is running in the background and will report back here. ' +
  'The tools above are your primary tools and are always available. Capabilities from ' +
  'connected apps (integrations) are separate: when a request looks like it needs one, ' +
  'call the `search_tools` tool with keywords and the matching integration tools are ' +
  'enabled automatically; do not claim an integration is unavailable without searching first. ' +
  'Bracketed lines like `[tools used: …]` in the conversation are system-added records of ' +
  'real tool calls; never write such a line yourself.';
// @see #360

/* Agents are memoised per provider/model (creation is stateful); instructions are empty — the system prompt rides in on the message list. */
const agentCache = new Map<string, Agent>();

/* `tools` override: `false` forces a plain agent with no tools (for aux completions whose model rejects tool-carrying requests); undefined keeps the default built-in-tools behaviour. */
// @see #52
type ToolsMode = 'full' | 'plain';

const agentFor = (provider: LlmProvider, model: string, tools?: boolean): Agent => {
  const mode: ToolsMode = tools === false ? 'plain' : 'full';
  // The tool set is baked in at construction, so the cache key must include the Brave-key state — toggling it without a restart must not hand back a stale full agent.
  const cacheKey = `${provider}/${model}/${mode}/${hasSearchKey() ? 'search' : 'nosearch'}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;
  const routerId = MASTRA_PROVIDER_ID[provider];
  const agent = new Agent({
    // The neutral message shape is structurally Core-compatible; the cast exists because the union `role` does not narrow to a single Mastra message variant.
    id: `tova-${provider}`,
    name: `tova-${provider}`,
    instructions: mode === 'full' ? TOOL_INSTRUCTIONS : '',
    model: `${routerId}/${model}`,
    ...(mode === 'full'
      ? {
          tools: {
            // web_search stays key-gated; current_datetime has no such dependency.
            // @see #52
            ...(hasSearchKey() ? { web_search: webSearchTool } : {}),
            fetch_url: fetchUrlTool,
            current_datetime: currentDatetimeTool,
            calculate: calculateTool,
            list_files: listFilesTool,
            read_file: readFileTool,
            generate_file: generateFileTool,
            edit_file: editFileTool,
            delegate_task: delegateTaskTool,
          },
        }
      : {}),
  });
  // Register with the singleton so the call context carries observability — unregistered agents generate without spans and the exporter never sees them.
  mastra.addAgent(agent, cacheKey);
  agentCache.set(cacheKey, agent);
  return agent;
};

/* Multimodal messages: neutral image_url parts map to Mastra's AI-SDK-style image part; Mastra downloads URL parts itself (verified live). Groq never takes completions with images — part-array content is rejected with a clear error. */
// @see #115 #94
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

/* Single-system-message invariant: strict OpenAI-compatible servers reject a system message not at index 0, so leading system messages are pulled out and merged into one per-call instructions override; a non-leading system message is a loud contract violation. */
// @see #198
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

/* Merged per-call system prompt: the agent's tool instructions first, then the caller's system content — a caller with no system message still gets the tool guidance. */
// @see #198
const mergedInstructions = (toolInstructions: string, callerSystem: string | undefined): string =>
  [toolInstructions, callerSystem].filter((part): part is string => Boolean(part)).join('\n\n');

/* Mastra's bundled router reaches Fireworks under the provider id `fireworks-ai`; the neutral app-level name stays `fireworks` — only the router id is remapped here. */
// @see #232
const MASTRA_PROVIDER_ID: Record<LlmProvider, string> = {
  groq: 'groq',
  deepinfra: 'deepinfra',
  fireworks: 'fireworks-ai',
  typesafe: 'typesafe',
};

const buildConnector = (provider: LlmProvider): LlmConnector => {
  // The default main-chat path always carries built-in tools now.
  // @see #52
  const defaultMode: ToolsMode = 'full';

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model).generate(
        mastraMessagesFor(provider, rest),
        {
          ...callOptionsFrom(options, defaultMode, mergedInstructions(TOOL_INSTRUCTIONS, system)),
          ...(await connectorSearchOptionsFrom(options)),
        },
      );
      // Tool executions: FullOutput.toolResults carries every executed call with its structured result; args ride across too so the task sequencer can rebuild chips and replay calls. Mastra nests the fields under `payload` — reading the entry directly yielded `name: ''` and a missing result — so unwrap with an entry-level fallback.
      // @see #16 #254
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
      // Token usage: the turn total across all tool steps, falling back to the last step's usage.
      // @see #224
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
          ...(await connectorSearchOptionsFrom(options)),
        },
      );
      // Resolve usage after the real chunks, as a final `usage` chunk; `totalUsage` settles once the stream drains, so awaiting after the loop cannot race.
      // @see #224
      const inner = await toNeutralStream(result.fullStream);
      const streamResult = result as { totalUsage?: Promise<unknown> };
      return (async function* () {
        for await (const chunk of inner) yield chunk;
        const usage = normaliseUsage(await streamResult.totalUsage);
        if (usage) yield { usage };
      })();
    },
    /* One-off completion path for auxiliary generation: built with a tool-free agent even when the Brave key is set, so small tool-rejecting models cannot fail the call. */
    // @see #41
    createToolFreeCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model, false).generate(
        mastraMessagesFor(provider, rest),
        { ...callOptionsFrom(options, 'plain', mergedInstructions('', system)), maxSteps: 1 },
      );
      // Thread the finish reason through so a `length` stop is observable instead of silently scoring as a short answer.
      return {
        choices: [{ message: { content: result.text ?? null }, finishReason: result.finishReason }],
      };
    },
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
export const fireworksConnector: LlmConnector = buildConnector('fireworks');
