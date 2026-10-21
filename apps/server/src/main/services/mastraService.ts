import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { ToolSearchProcessor } from '@mastra/core/processors';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { buildTracingOptions } from '@mastra/observability';
import { withLangsmithMetadata } from '@mastra/langsmith';
import { RedactedLangSmithExporter } from './trace/traceRedaction';
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
import { sanitizeFilename } from './asset/assetLimits';
import { applyAssetEdits, writeAssetContent, type AssetEdit } from './asset/assetEditService';
import { spacesWorkspaceStorage } from './workspace/workspaceStorage';
import { config } from '../config';

/* LangSmith tracing via the official Mastra plugin, env-gated on the key. */
// @see #5 #145
const langsmithKey = config.langsmith.apiKey;
const projectName = config.langsmith.project;

// Mastra requires storage for tracing; InMemoryStore backs snapshot lookups.
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

/* Single owner of @mastra/* imports; maps Mastra shapes to neutral types. */
// @see #4

/* FullStream chunk shape: content nests in payload; error chunks rethrow. */
interface FullStreamChunk {
  type?: string;
  /* Text/error, toolName, result, input all live under payload (args too). */
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

/* Usage normalisation: drop absent/NaN fields so unknown stays distinct. */
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
      // Tool chunks pass call/result across the neutral boundary to callers.
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

/* Omit unset call settings; undefined keys can trip SDK validation. */
const modelSettingsFrom = (options: CompletionOptions) => ({
  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  ...(options.max_tokens !== undefined ? { maxOutputTokens: options.max_tokens } : {}),
});

/* Abort plumbing plus maxSteps semantics; context ids ride RequestContext. */
// @see #16 #159 #52 #58 #252 #298
/* Connector toolsets resolve per call (TTL cache) and defer to search. */
// @see #36 #329 #360
export const connectorSearchOptionsFrom = async (options: CompletionOptions) => {
  if (!options.userId) return {};
  const toolsets = await connectorToolsetsForUser(options.userId);
  if (!Object.keys(toolsets).length) return {};
  const catalog: Record<string, (typeof toolsets)[string][string]> = {};
  for (const tools of Object.values(toolsets)) {
    for (const [name, tool] of Object.entries(tools)) {
      // First connector wins on collisions; sanitized ids stay provider-safe.
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
  // The chat session rides alongside userId for provenance attribution.
  // @see #252
  if (options.sessionId !== undefined) requestContext.set('sessionId', options.sessionId);
  // The task id rides alongside so a task-generated file is attributed to it.
  // @see #298
  if (options.taskId !== undefined) requestContext.set('taskId', options.taskId);
  return {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    // The merged system message rides in as a per-call instructions override.
    // @see #198
    ...(instructions ? { instructions } : {}),
    // Tasks force tool use; the model must act, not chat. @see #387
    ...(options.toolUse === 'required' ? { toolChoice: 'required' as const } : {}),
    // Caller may pin the per-call step cap; absent falls back to the default.
    // @see #254
    maxSteps: options.maxSteps ?? (mode === 'full' ? 12 : 1),
    modelSettings: modelSettingsFrom(options),
    ...traceOptionsFrom(options.trace),
    requestContext,
  };
};

/* Trace attach: metadata/tags only reach spans via tracingOptions. */
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

/* Web search tool: raw Brave client; failures degrade to empty results. */
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
    // Set only when the search failed, so the model can tell failure apart.
    // @see #82
    error: z.string().optional(),
  }),
  execute: async ({ query }, ctx) => {
    // A failed web_search short-circuits to the degraded result, no re-call.
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

/* Fetch-url tool: read a pasted URL; failures degrade to a typed error. */
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
  // A ZDR turn (no session, no task) persists nothing; scrapes stay head-only.
  // @see #116
  if (!sessionId && !taskId) return null;
  // Same provenance rule as generate_file: task, else the chat.
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
    // Normalized URL — the scrape-cache key; reused by the save below.
    let cacheKey: string | null = null;
    // Set when the page was persisted agent-side; result carries the fileId.
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
      // A fresh cached copy (within TTL) is reused instead of a re-scrape.
      try {
        cacheKey = new URL(url).toString();
      } catch {
        cacheKey = null; // Invalid URL — firecrawlScrape throws below.
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
    // results mirrors web_search's provenance shape for the sources block.
    const results = [{ title: page.title, snippet: '', url: page.url }];
    // An oversized scraped page is saved agent-side for full read_file access.
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

/* Asset-library tools: per-user scoping; missing userId reads unavailable. */
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
  // The explicit MIME type keeps the model honest about the file type.
  contentType: asset.contentType,
  size: asset.size,
  createdAt: (asset.createdAt ?? new Date()).toISOString(),
  // System-side rows only: the fetched URL, so the agent can match a cache.
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
      // 21 rows: 20 returned, the 21st feeds more; agent rows list too.
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

// Resolve by id or sanitized filename; null when neither matches.
// @see #369
const resolveLibraryAsset = async (
  userId: string,
  id?: string,
  filename?: string,
): Promise<typeof Asset.prototype | null> => {
  if (id && mongoose.isValidObjectId(id)) {
    return Asset.findOne({ _id: id, userId, status: 'ready' }).select('+units');
  }
  const safeName = sanitizeFilename((filename ?? '').trim());
  if (safeName) {
    return Asset.findOne({ userId, status: 'ready', filename: safeName })
      .select('+units')
      .sort({ _id: -1 });
  }
  return null;
};

export const readFileTool = createTool({
  id: 'read_file',
  description:
    'Read a file from the calling user’s file library by its id (from `list_files`) or ' +
    'by its filename, returning its metadata (filename, type, size, upload date) and ' +
    'extracted text content when any exists. Read long documents in slices with `offset` ' +
    '(1-based start line) and `limit` (number of lines); every result reports ' +
    '`totalLines`, `totalChars` and whether more remains (`truncated`). To navigate a ' +
    'long document, call with `unitsOnly: true` first to list its units (pages/sections) ' +
    'as a table of contents with each unit’s `startLine`, then read from that line.',
  inputSchema: z.object({
    id: z.string().min(1).optional().describe('The file id from `list_files`'),
    filename: z.string().min(1).optional().describe('The file name, e.g. meeting-notes.md'),
    // Models emit booleans as strings; execute coerces to a real boolean.
    // @see #159
    unitsOnly: z.union([z.boolean(), z.enum(['true', 'false', 'True', 'False'])]).optional(),
    // Models emit numbers as strings; execute coerces digit-only strings.
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
  execute: async (
    { id, filename, unitsOnly: rawUnitsOnly, offset: rawOffset, limit: rawLimit },
    ctx,
  ) => {
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
    if ((!id || !mongoose.isValidObjectId(id)) && !(filename && filename.trim())) {
      return { error: 'not_found' };
    }
    try {
      // return await: a bare return leaks rejections past the catch.
      return await resolveThenRead(userId, id, filename, unitsOnly, rawOffset, rawLimit);
    } catch (error) {
      markToolFailed(ctx, 'read_file', reasonFrom(error));
      return { error: degradedToolError('read_file', reasonFrom(error)) };
    }
  },
});

// The read body after resolution; errors propagate to the caller's catch.
// @see #369
const resolveThenRead = async (
  userId: string,
  id?: string,
  filename?: string,
  unitsOnly?: boolean,
  rawOffset?: unknown,
  rawLimit?: unknown,
) => {
  const asset = await resolveLibraryAsset(userId, id, filename);
  if (!asset) return { error: 'not_found' };
  const file = assetFileFrom(asset);
  // Per-unit text; selected explicitly because the field is select: false.
  // @see #159
  const units = (asset.get('units') ?? []) as { index: number; label: string; text: string }[];
  // Markdown conversion is the fallback when fast extraction found nothing.
  // @see #67
  const text = asset.textExtracted ?? asset.markdownExtracted;
  // Units point at the line where they begin; computed at read time.
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
  // Numeric args may arrive as digit-only strings; coerce before validating.
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
};

/* generate_file tool: create a new markdown file in the caller's library. */
// @see #66
export const generateFileTool = createTool({
  id: 'generate_file',
  description:
    'Create a markdown file in the calling user’s file library, saved from your ' +
    'own output (notes, summaries, drafts). Use it when the user asks to save, ' +
    'generate or create a file/note/document. Content must be markdown text. If a ' +
    'file with the same name (one you generated before) already exists, the content ' +
    'becomes a new version of that file — same id, previous version superseded; old ' +
    'versions are not visible to you.',
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
        version: z.number().optional().describe('The version number after this write'),
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
  file?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    version?: number;
    createdAt: string;
  };
  error?: string;
}> => {
  const userId = requestContext.get('userId') as string | undefined;
  if (!userId) return { error: 'unavailable' };
  if (!spacesWorkspaceStorage.isConfigured()) return { error: 'unavailable' };
  // Attribute to task, else chat; no context leaves provenance unknown.
  // @see #252 #298
  const sessionId = requestContext.get('sessionId') as string | undefined;
  const taskId = requestContext.get('taskId') as string | undefined;
  const provenance = taskId
    ? ({ kind: 'task', taskId } as const)
    : sessionId
      ? ({ kind: 'chat', sessionId } as const)
      : undefined;
  try {
    // A repeated generated filename is a new version, not a duplicate row.
    // @see #369
    const safeName = sanitizeFilename(filename);
    const existing = safeName
      ? await Asset.findOne({
          userId,
          filename: safeName,
          origin: 'system-generated',
          status: 'ready',
        }).sort({ _id: -1 })
      : null;
    if (existing) {
      const result = await writeAssetContent(existing, content);
      if (!result.ok) return { error: result.code };
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
      };
    }
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

/* edit_file tool: search/replace edits; each write snapshots a new version. */
// @see #325
export const editFileTool = createTool({
  id: 'edit_file',
  description:
    'Edit a markdown file that you previously created with `generate_file` in the ' +
    'calling user’s file library. Use it to update, revise or fix an existing file ' +
    'instead of generating a new one. Provide the file id (from `list_files`) or its ' +
    'filename, plus one or more search/replace edits: each `oldText` must be a unique ' +
    'block of the file’s current text and `newText` its replacement. Call `read_file` ' +
    'first to get the current text when unsure; preserve exact indentation and never ' +
    'include line-number prefixes in oldText. If there is no exact match, the edit ' +
    'retries while ignoring typographic quote, dash, and space variants, then trailing ' +
    'whitespace on each line — but it still fails if oldText is absent or matches ' +
    'more than one place. The file keeps its id and provenance; every edit is kept ' +
    'as a new version.',
  inputSchema: z.object({
    id: z.string().min(1).optional().describe('The file id from `list_files`'),
    filename: z.string().min(1).optional().describe('The file name, e.g. meeting-notes.md'),
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
  execute: async ({ id, filename, edits }, { requestContext }) =>
    editFileExecute(id, filename, edits, requestContext),
});

const editFileExecute = async (
  id: string | undefined,
  filename: string | undefined,
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
  if ((!id || !mongoose.isValidObjectId(id)) && !(filename && filename.trim())) {
    return { error: 'not_found' };
  }
  try {
    const asset = await resolveLibraryAsset(userId, id, filename);
    if (!asset) return { error: 'not_found' };
    // Captured before the write: the diff is returned for auditability.
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

/* Built-in clock tool: deterministic UTC instant, no external calls. */
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

/* Calculator tool: arithmetic is not a weights task (calculator.ts). */
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

/* Delegate tool: creates a task with this chat as its thin origin. */
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
    // A ZDR turn has no session; a durable task is what ZDR forbids.
    // @see #255
    if (!userId || !sessionId) {
      return { error: 'Delegation is not available in this conversation.' };
    }
    try {
      const user = await User.findById(userId);
      if (!user || user.settings?.zdr) {
        return { error: 'Delegation is not available with zero-data-retention enabled.' };
      }
      const { enqueueTask } = await import('./task/taskService');
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

/* Task prompt: tool use only, no personality. */
// @see #387
const TASK_INSTRUCTIONS =
  'Work the task to completion using the tools; act rather than describe. ' +
  'For current or external facts, call `web_search` (focused keyword queries) ' +
  'and `fetch_url` for complete http(s) URLs, and answer from what they return ' +
  'instead of guessing. Call `current_datetime` for date/time rather than ' +
  'assuming it. Route non-trivial arithmetic through `calculate`. When the task ' +
  'references the user’s files, call `list_files` first, then `read_file` with a ' +
  'file id before quoting anything — never invent file contents; for long ' +
  'documents use `unitsOnly: true` to list units, then `offset`/`limit` for only ' +
  'the lines needed. Deliver files with `generate_file` (filename ending in .md, ' +
  'full markdown content) and revise existing ones with `edit_file`, copying ' +
  '`oldText` exactly from the current text. When the task may need a connected ' +
  'integration, call `search_tools` with keywords first. Bracketed lines like ' +
  '`[tools used: …]` are system-added records; never write one yourself.';

/* Agents are memoised per provider/model; instructions stay empty.
 * Insertion-order cap: a pathological model rotation cannot grow it. */
const AGENT_CACHE_MAX = 50;
const agentCache = new Map<string, Agent>();

/* 'task' swaps in the lean task prompt and drops delegate_task. */
// @see #387 #52
type ToolsMode = 'full' | 'plain' | 'task';

const agentFor = (provider: LlmProvider, model: string, mode: ToolsMode = 'full'): Agent => {
  // Cache key includes Brave-key state; the tool set is baked in.
  const cacheKey = `${provider}/${model}/${mode}/${hasSearchKey() ? 'search' : 'nosearch'}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;
  const routerId = MASTRA_PROVIDER_ID[provider];
  // Trace identity carries the model; ids are slug-safe, not model-raw.
  // @see #398
  const agentLabel = `tova-${provider}-${model.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  const agent = new Agent({
    // Cast: the union role does not narrow to a single Mastra message variant.
    id: agentLabel,
    name: agentLabel,
    instructions: mode === 'full' ? TOOL_INSTRUCTIONS : mode === 'task' ? TASK_INSTRUCTIONS : '',
    model: `${routerId}/${model}`,
    ...(mode !== 'plain'
      ? {
          tools: {
            // web_search stays key-gated; datetime has no dependency.
            // @see #52
            ...(hasSearchKey() ? { web_search: webSearchTool } : {}),
            fetch_url: fetchUrlTool,
            current_datetime: currentDatetimeTool,
            calculate: calculateTool,
            list_files: listFilesTool,
            read_file: readFileTool,
            generate_file: generateFileTool,
            edit_file: editFileTool,
            // delegate_task needs a chat session; tasks never have one.
            // @see #387
            ...(mode === 'full' ? { delegate_task: delegateTaskTool } : {}),
          },
        }
      : {}),
  });
  // Register so the call context carries observability for the exporter.
  mastra.addAgent(agent, cacheKey);
  agentCache.set(cacheKey, agent);
  if (agentCache.size > AGENT_CACHE_MAX) {
    const oldest = agentCache.keys().next().value;
    if (oldest !== undefined) agentCache.delete(oldest);
  }
  return agent;
};

/* Multimodal: image_url parts map to Mastra images; Groq rejects images. */
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

/* Single-system-message invariant: leading system messages merge into one. */
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

/* Merged per-call prompt: tool instructions first, then caller system. */
// @see #198
const mergedInstructions = (toolInstructions: string, callerSystem: string | undefined): string =>
  [toolInstructions, callerSystem].filter((part): part is string => Boolean(part)).join('\n\n');

/* Mastra's Fireworks router id is fireworks-ai; app name stays fireworks. */
// @see #232
const MASTRA_PROVIDER_ID: Record<LlmProvider, string> = {
  groq: 'groq',
  deepinfra: 'deepinfra',
  fireworks: 'fireworks-ai',
};

const buildConnector = (provider: LlmProvider): LlmConnector => {
  // Chat rides the full toolset; `toolUse: 'required'` (tasks) rides the lean
  // task agent with toolChoice forced.
  // @see #52 #387
  const modeFor = (options: CompletionOptions): ToolsMode =>
    options.toolUse === 'required' ? 'task' : 'full';
  const instructionsFor = (options: CompletionOptions, system: string | undefined): string =>
    mergedInstructions(modeFor(options) === 'task' ? TASK_INSTRUCTIONS : TOOL_INSTRUCTIONS, system);

  return {
    createCompletion: async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const result = await agentFor(provider, options.model, modeFor(options)).generate(
        mastraMessagesFor(provider, rest),
        {
          ...callOptionsFrom(options, 'full', instructionsFor(options, system)),
          ...(await connectorSearchOptionsFrom(options)),
        },
      );
      // toolResults carries executed calls; Mastra nests fields under payload.
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
      // Usage: turn total across tool steps, else the last step's usage.
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
      const result = await agentFor(provider, options.model, modeFor(options)).stream(
        mastraMessagesFor(provider, rest),
        {
          ...callOptionsFrom(options, 'full', instructionsFor(options, system)),
          ...(await connectorSearchOptionsFrom(options)),
        },
      );
      // Awaiting totalUsage after the loop avoids racing the stream drain.
      // @see #224
      const inner = await toNeutralStream(result.fullStream);
      const streamResult = result as { totalUsage?: Promise<unknown> };
      return (async function* () {
        for await (const chunk of inner) yield chunk;
        const usage = normaliseUsage(await streamResult.totalUsage);
        if (usage) yield { usage };
      })();
    },
    /* Tool-free even with a Brave key, for tool-rejecting models. */
    // @see #41
    createToolFreeCompletion: (async (options: CompletionOptions): Promise<NeutralCompletion> => {
      const { system, rest } = splitLeadingSystem(options.messages);
      const messages = mastraMessagesFor(provider, rest);
      const base = {
        ...callOptionsFrom(options, 'plain', mergedInstructions('', system)),
        maxSteps: 1,
      };
      const { structuredOutput } = options;
      if (structuredOutput) {
        // Validation failure resolves with fallbackValue instead of throwing.
        // @see #368
        const result = await agentFor(provider, options.model, 'plain').generate(messages, {
          ...base,
          structuredOutput: {
            schema: structuredOutput.schema,
            fallbackValue: structuredOutput.fallbackValue,
            errorStrategy: 'fallback' as const,
            ...(structuredOutput.jsonPromptInjection !== undefined
              ? { jsonPromptInjection: structuredOutput.jsonPromptInjection }
              : {}),
          },
        });
        return {
          choices: [
            { message: { content: result.text ?? null }, finishReason: result.finishReason },
          ],
          object: result.object ?? structuredOutput.fallbackValue,
        };
      }
      const result = await agentFor(provider, options.model, 'plain').generate(messages, base);
      // Thread the finish reason so a length stop is observable.
      return {
        choices: [{ message: { content: result.text ?? null }, finishReason: result.finishReason }],
      };
    }) as LlmConnector['createToolFreeCompletion'],
  };
};

export const groqConnector: LlmConnector = buildConnector('groq');
export const deepinfraConnector: LlmConnector = buildConnector('deepinfra');
export const fireworksConnector: LlmConnector = buildConnector('fireworks');
