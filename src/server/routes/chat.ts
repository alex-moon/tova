import { isValidObjectId } from 'mongoose';
import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { buildAttachmentEnvelope } from '../services/attachmentEnvelope';
import { isImageContentType } from '../services/assetLimits';
import { spacesWorkspaceStorage } from '../services/workspaceStorage';
import { routeQuery } from '../services/routerService';
import { generateChatTitle } from '../services/titleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { buildSystemContent } from '../services/promptAssembly';
import {
  isEntityInjectionEnabled,
  retrieveKnowledgeBlock,
} from '../services/entityRetrievalService';
import { ensureUserLocation } from '../services/geoLocationService';
import { inferenceService } from '../services/inferenceService';
import { outputTokensFor, promptCharsFrom } from '../services/outputTokenCap';
import type { MessageContentPart, NeutralStreamChunk } from '../services/llmTypes';
import { classifyAndPersistPromptDimensions, isTriviallyNeutral } from '../services/metricsService';
import { computeDeterministicMetrics } from '../services/promptMetrics';
import { generateFollowups } from '../services/followupService';
import {
  extractAndPersistFromTurn,
  isEntityExtractionEnabled,
} from '../services/entityExtractionService';
import { zdrHistorySchema } from '../validation';
import { redactForLog } from '../services/logRedaction';
import { decideTurn } from '../services/zdrTurn';
import { disableModel } from '../services/modelConfigService';
import {
  AllModelsDisabledError,
  isClientAbort,
  isPromptSizeError,
  isRateLimitError,
  MAX_ATTEMPTS,
  withModelFailover,
} from '../services/modelFailover';

const router = express.Router();

const NO_ROUTING_PERMISSION = "You don't have permission to use the model router.";

type AssetDoc = {
  _id: unknown;
  filename: string;
  key: string;
  contentType: string;
  size: number;
  status?: 'pending' | 'ready' | 'failed';
  ephemeral?: boolean;
  textExtracted?: string | null;
  markdownExtracted?: string | null;
};

// Asset attach (issue #34): resolves the attached asset for a turn — 'none'
// when the request sent no assetId, 'invalid' for a malformed reference,
// 'missing' when it points at a different user's asset.
// Turns that will actually carry pixels (#115). Mirrors buildImageTurn's
// conditions (image content type, uploaded-and-confirmed asset, configured
// storage) so routing and message assembly can never disagree: a turn that
// routed vision-only must never silently degrade to the filename envelope.
const turnsWithImage = (asset: AssetDoc | null): boolean =>
  Boolean(
    asset &&
    asset.status === 'ready' &&
    isImageContentType(asset.contentType) &&
    spacesWorkspaceStorage.isConfigured(),
  );

const loadAttachedAsset = async (
  req: AuthRequest,
): Promise<AssetDoc | null | 'invalid' | 'missing'> => {
  const assetIdRaw = req.body?.assetId;
  if (assetIdRaw === undefined || assetIdRaw === null || assetIdRaw === '') return null;
  if (typeof assetIdRaw !== 'string' || !isValidObjectId(assetIdRaw)) return 'invalid';
  const asset = await Asset.findOne({
    _id: assetIdRaw,
    userId: req.user?.id,
  });
  return asset ? (asset as unknown as AssetDoc) : 'missing';
};

// Attached file text goes in through the structured attachment envelope
// (services/attachmentEnvelope.ts): untrusted-data rule first, then the
// <user_content> block. Stored/persisted user message stays the raw user
// text so the UI and metrics are unaffected.
const appendAssetBlock = (
  messages: { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[],
  asset: AssetDoc | null,
): void => {
  const last = messages[messages.length - 1];
  if (asset && last?.role === 'user') {
    last.content += buildAttachmentEnvelope({
      filename: asset.filename,
      contentType: asset.contentType,
      size: asset.size,
      // Issue #67: markdown conversion is the fallback source when no fast-
      // path extraction exists (txt/md/csv keep winning).
      textExtracted: asset.textExtracted ?? asset.markdownExtracted ?? null,
    });
  }
};

// Issue #115: image attachments become real content parts on the current
// user turn instead of the filename-only envelope. The image rides in as a
// presigned Spaces GET URL (same mechanism `GET /assets/:id/url` serves);
// the <user_content> envelope is deliberately skipped for images — its
// "text" is binary noise. Returns true when the pixels flow this turn.
// Without storage configured the pre-#115 degradation holds: envelope with
// `text_extracted="false"`, no image part, no vision routing.
const buildImageTurn = async (
  messages: { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[],
  asset: AssetDoc,
): Promise<boolean> => {
  // `ready` matters: a pending upload has no object in Spaces yet, so the
  // presigned GET would 404 inside the model's fetch and fail the turn.
  if (
    !isImageContentType(asset.contentType) ||
    asset.status !== 'ready' ||
    !spacesWorkspaceStorage.isConfigured()
  ) {
    return false;
  }
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return false;
  const url = await spacesWorkspaceStorage.presignGetByKey(asset.key);
  last.content = [
    { type: 'text', text: typeof last.content === 'string' ? last.content : '' },
    { type: 'image_url', image_url: { url } },
  ];
  return true;
};

// Provenance extraction (issue #16): web_search tool results arrive as
// { results: { title, snippet, url }[] }; URLs are collected incrementally
// deduplicated across all tool runs of the turn. Malformed entries are
// skipped, never fatal — the search enriches the turn but must not fail it.
// Per-source page titles are captured alongside the URL (issue #33) so the
// client's sources block can label links with real titles.

const collectSourcesInto = (
  sourceList: string[],
  toolResult: unknown,
  titles?: Map<string, string>,
): string[] => {
  const items = Array.isArray((toolResult as { results?: unknown })?.results)
    ? (toolResult as { results: unknown[] }).results
    : [];
  for (const item of items) {
    const entry = item as { url?: unknown; title?: unknown } | null;
    const url = entry?.url;
    if (typeof url === 'string' && url !== '' && !sourceList.includes(url)) {
      sourceList.push(url);
      if (titles && typeof entry?.title === 'string' && entry.title) {
        titles.set(url, entry.title);
      }
    }
  }
  return sourceList;
};

// Tool outcome summaries for the SSE 'tool' events (issue #33),
// provider-neutral: any tool name flows through; only the label for
// first-party `web_search` is hard-known here.
const toolLabelFrom = (name: string): string =>
  name === 'web_search'
    ? 'Searched the web'
    : name === 'fetch_url'
      ? 'Fetched the page'
      : name === 'list_files'
        ? 'Listed your files'
        : name === 'read_file'
          ? 'Read a file'
          : name === 'generate_file'
            ? 'Created a file'
            : name || 'Tool run';

/*
 * Tools that are internal bookkeeping, not user-facing "work". A turn whose
 * only tool was one of these must not synthesize a confirmation ("I checked
 * the time.") — see plan #195. A turn with these plus any real tool still
 * confirms, but only for the real tool.
 */
const NON_CONFIRMING_TOOLS = new Set(['current_datetime']);

// Completed-tool confirmation (issue #195): when a turn ran at least one
// user-facing tool but produced no assistant text — the Mastra-documented
// "run ends on a tool call" case, e.g. `maxSteps` exhausting on tool rounds —
// this derives a short natural-language sentence naming what happened. It is
// only ever consulted when the model's own text is empty/whitespace, so a real
// answer always wins byte-for-byte.
export const confirmationForToolResults = (
  results: Array<{ name: string; result: unknown }>,
): string | null => {
  const phrases: string[] = [];
  for (const { name, result } of results) {
    if (NON_CONFIRMING_TOOLS.has(name)) continue;
    let phrase: string;
    if (name === 'generate_file') {
      const filename = (result as { file?: { filename?: unknown } } | null)?.file?.filename;
      phrase =
        typeof filename === 'string' && filename !== ''
          ? `Created ${filename}.`
          : 'Created the file.';
    } else if (name === 'web_search') {
      phrase = 'Searched the web.';
    } else if (name === 'fetch_url') {
      phrase = 'Fetched the page.';
    } else if (name === 'list_files') {
      phrase = 'Listed your files.';
    } else if (name === 'read_file') {
      phrase = 'Read the file.';
    } else {
      phrase = 'Finished the task.';
    }
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  if (phrases.length === 0) return null;
  if (phrases.length <= 3) return phrases.join(' ');
  return `${phrases.slice(0, 3).join(' ')} And more.`;
};

const toolCallEvent = (call: NonNullable<NeutralStreamChunk['toolCall']>) => ({
  phase: 'call' as const,
  name: call.name,
  label: toolLabelFrom(call.name),
  ...(typeof call.args?.query === 'string' && call.args.query ? { query: call.args.query } : {}),
});

/*
 * Stream error surfacing (#77): the generic message hides whether the
 * failure is actionable. A 413 / "Request too large" from the provider is a
 * prompt-size problem — user-connected MCP toolsets (#77) are the most
 * likely cause — so the surfaced message says so instead of the blank
 * 'Error streaming from model'.
 */
export const streamingErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  // #168: when every model cooled off after failures, the message itself is
  // the end-user text — pass it through verbatim.
  if (err instanceof AllModelsDisabledError) return message;
  if (statusCode === 413 || /Request too large/.test(message)) {
    return (
      'Request too large for this deployment’s current rate limit — connected MCP servers ' +
      'may have added many tools to the request. Try again shortly or remove MCP servers in settings.'
    );
  }
  /*
   * #117: a 429 (or its Groq-style message body that Mastra rethrows without a
   * status code) is actionable — the suggestion is simply to retry — so it is
   * surfaced as such instead of the generic streaming message.
   */
  if (
    statusCode === 429 ||
    /rate[ _-]?limit/i.test(message) ||
    /(tokens per minute|requests per minute)/i.test(message) ||
    /\bTPM\b|\bRPM\b/.test(message)
  ) {
    return 'Rate limited by the model provider — please retry in a moment.';
  }
  return 'Error streaming from model';
};

const domainsFrom = (urls: string[]): string[] => {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // malformed URL: skip silently
    }
  }
  return [...hosts].slice(0, 5);
};

// Result chip counts (#114): per-tool counting semantics instead of a
// universal "count every array" heuristic — the universal one produced
// misleading "0 results" on tools without a results list.
//   web_search: count of results, domains from URL-bearing entries.
//   list_files: count of matched files (empty files + error = degraded, no count).
//   anything else (user-connected MCP etc.): a meaningful count only when the
//   top-level result has exactly one array-valued field; otherwise no count
//   and status 'ok' — absence of a count is not absence of success.
const singleArrayFieldLength = (result: unknown): number | null => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const arrayFields = Object.values(result).filter((value) => Array.isArray(value));
  return arrayFields.length === 1 ? (arrayFields[0] as unknown[]).length : null;
};

type ToolCallEvent = ReturnType<typeof toolCallEvent>;
type ToolResultEvent = ReturnType<typeof toolResultEvent>;

// Persisted tool entry (#196): a call that has not yet seen its result stays
// phase 'call' (the live throbber), while a resolved entry carries the result
// summary plus the query copied from the call so the chip's expanded detail
// has something to show.
export type PersistedToolEvent = (ToolCallEvent | ToolResultEvent) & { query?: string };

/*
 * Reconcile a tool event onto the running per-turn list (#196, decision D1).
 * A result merges into the most recent still-unresolved call of the same
 * name, flipping it to 'result' and carrying the call's query forward. A
 * result with no matching open call (e.g. a second web_search result) is
 * appended as its own entry rather than dropped; once an entry has flipped
 * to 'result' it is no longer a merge target, so a like-named second result
 * becomes a standalone entry. Mutates and returns the list for convenience.
 */
export const reconcileToolEvent = <T extends PersistedToolEvent>(
  list: T[],
  ev: PersistedToolEvent,
): T[] => {
  if (ev.phase === 'result') {
    for (let i = list.length - 1; i >= 0; i--) {
      const candidate = list[i];
      if (candidate.phase === 'call' && candidate.name === ev.name) {
        list[i] = {
          ...ev,
          ...(candidate.query ? { query: candidate.query } : {}),
        } as T;
        return list;
      }
    }
  }
  list.push(ev as T);
  return list;
};

const toolResultEvent = (result: { name: string; result: unknown }) => {
  const base = {
    phase: 'result' as const,
    name: result.name,
    label: toolLabelFrom(result.name),
  };
  if (result.name === 'web_search' || result.name === 'fetch_url') {
    const items = Array.isArray((result.result as { results?: unknown })?.results)
      ? (result.result as { results: unknown[] }).results
      : [];
    const urls = items
      .map((item) => (item as { url?: unknown } | null)?.url)
      .filter((url): url is string => typeof url === 'string' && url !== '');
    const hasResults = Array.isArray((result.result as { results?: unknown })?.results);
    return {
      ...base,
      status: urls.length > 0 ? ('ok' as const) : ('empty' as const),
      ...(hasResults ? { resultCount: items.length } : {}),
      ...(urls.length > 0 ? { domains: domainsFrom(urls) } : {}),
    };
  }
  if (result.name === 'generate_file') {
    const payload = result.result as { file?: { filename?: unknown }; error?: unknown } | null;
    const filename = payload?.file?.filename;
    if (payload && typeof payload.error === 'string') {
      return { ...base, status: 'empty' as const };
    }
    return {
      ...base,
      status: 'ok' as const,
      ...(typeof filename === 'string' && filename !== '' ? { filename } : {}),
    };
  }
  if (result.name === 'list_files') {
    const payload = result.result as { files?: unknown; error?: unknown } | null;
    const files = Array.isArray(payload?.files) ? (payload?.files as unknown[]) : null;
    if (payload && typeof payload.error === 'string' && (!files || files.length === 0)) {
      // Degraded: empty files + error → no count (issue #114 plan task 1).
      return { ...base, status: 'empty' as const };
    }
    const count = files?.length ?? 0;
    return {
      ...base,
      status: count > 0 ? ('ok' as const) : ('empty' as const),
      resultCount: count,
    };
  }
  const count = singleArrayFieldLength(result.result);
  return {
    ...base,
    status: 'ok' as const,
    ...(count !== null ? { resultCount: count } : {}),
  };
};

// Feedback aggregation key (issue #18): deterministic prompt features of the
// user turn, captured at route time — not LLM flags, which are classified
// fire-and-forget only after routing (plan decisions 4 and 6, Q2).
const buildRoutingBand = (
  metrics:
    | {
        lengthBucket?: 'short' | 'medium' | 'long' | null;
        codeIndicators?: { fences?: number | null } | null;
      }
    | null
    | undefined,
): string =>
  `${metrics?.lengthBucket ?? 'unknown'}|${(metrics?.codeIndicators?.fences ?? 0) > 0 ? 'code' : 'prose'}`;

// Session indices count only prior messages (computed before .save()), so a
// session's first message gets index 0. Count-based indices are racy under
// concurrent turns in one session; accepted in the plan
// (docs/plan-17-prompt-metrics.md) since metrics are analytical.
const buildMessageMetrics = async (
  sessionId: string,
  content: string,
): Promise<Record<string, unknown>> => {
  const priorCount = await Message.countDocuments({ sessionId });
  return {
    ...computeDeterministicMetrics(content),
    sessionMessageIndex: priorCount,
  };
};

const createSessionWithUser = async (
  userId: string,
  content: string,
  { incognito = false }: { incognito?: boolean } = {},
) => {
  const title = await generateChatTitle(content);
  return Session.create({ userId, title, incognito });
};

/*
 * Zero-data retention (#116): with the account setting on, the chat routes
 * keep nothing — no Session row, no Message rows, no fire-and-forget
 * classification, no title generation. Continuity within an ephemeral chat is
 * the client's replay: a bounded, validated `history` array rides each turn
 * and is assembled below, mirroring what a persisted session's
 * `Message.find({ sessionId })` would return.
 */
const buildZdrMessages = (
  history: { role: 'user' | 'assistant'; content: string }[],
  content: string,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] => [
  ...history,
  { role: 'user', content },
];

const messagesFromPersistedHistory = (
  history: { role: string; content: string }[],
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] =>
  history.reverse().map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content as string,
  }));

/*
 * #169 phase 2: the guard classifier's conversation context — prior turns
 * only, oldest first, never the just-saved current message (it rides
 * separately as the query). The persisted find is newest-first and INCLUDES
 * the current turn, so it is dropped by id and the tail reversed. DB
 * `Message.content` is always a string, so the guard's text-only history
 * needs no part-flattening here.
 */
const guardHistoryFromDocs = (
  docs: { _id: unknown; role: string; content: string }[],
  currentMessageId: unknown,
): { role: 'user' | 'assistant'; content: string }[] =>
  docs
    .filter((m) => String(m._id) !== String(currentMessageId))
    .reverse()
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

// Throwaway chat attachments (#116): as soon as the turn that consumed them
// completes, the row and its Spaces object go. Never throws — cleanup must
// not turn a finished answer into an error.
const cleanupEphemeralAsset = async (asset: AssetDoc | null | 'invalid' | 'missing') => {
  if (!asset || asset === 'invalid' || asset === 'missing' || !asset.ephemeral) return;
  try {
    await Asset.deleteOne({ _id: asset._id });
    await spacesWorkspaceStorage.deleteByKey(asset.key);
  } catch (err) {
    console.error('Ephemeral asset cleanup error:', redactForLog(err));
  }
};

const parseZdrHistory = (
  history: unknown,
): { ok: true; value: { role: 'user' | 'assistant'; content: string }[] } | { ok: false } => {
  const parsed = zdrHistorySchema.safeParse(history ?? []);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
};

// Persist the user turn with its metrics. Trivially neutral prompts record
// llmSkipReason 'trivial' so the skip gate is distinguishable in the DB from
// failed ('parse'/'error') classification; non-trivial prompts get a
// fire-and-forget classification call back (docs/plan-17-prompt-metrics.md
// tasks 6 and 9). The gate is computed once and reused for both purposes.
const saveUserMessageWithMetrics = async (
  sessionId: string,
  content: string,
  asset?: { _id: unknown } | null,
) => {
  const triviallyNeutral = isTriviallyNeutral(content);
  const userMessage = new Message({
    sessionId,
    role: 'user',
    content,
    ...(asset ? { assetId: asset._id } : {}),
    metrics: {
      ...(await buildMessageMetrics(sessionId, content)),
      ...(triviallyNeutral ? { llmSkipReason: 'trivial' as const } : {}),
    },
  });
  await userMessage.save();

  if (!triviallyNeutral) {
    classifyAndPersistPromptDimensions(String(userMessage._id), content).catch((err) =>
      console.error('Prompt classification error:', redactForLog(err)),
    );
  }
  return userMessage;
};

/*
 * Entity-graph retrieval (#138, plan task 4): read-only, bounded "what we
 * know about you" block for the system prompt, only when
 * ENTITY_GRAPH_PROMPT_INJECTION is set. Never throws — graph enrichment,
 * like extraction, must not degrade a chat turn.
 */
const knowledgeBlockFor = async (prompt: string, userId: string): Promise<string> => {
  if (!isEntityInjectionEnabled()) return '';
  try {
    return await retrieveKnowledgeBlock(prompt, userId);
  } catch (err) {
    console.error('Entity graph retrieval error:', redactForLog(err));
    return '';
  }
};

// Chat endpoint (non-streaming, preserved for compatibility)
router.post('/', authenticate, async (req: AuthRequest, res) => {
  // Held outside try so the catch can erase a throwaway attachment on any
  // failure path (#116). Null until the asset is loaded.
  let attachedAsset: AssetDoc | null = null;
  try {
    const { sessionId, content } = req.body;
    const userId = req.user?.id;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    if (!(await hasPermission(userId as string, ROUTING_PERMISSION))) {
      return res.status(403).json({ message: NO_ROUTING_PERMISSION });
    }

    const attachResult = await loadAttachedAsset(req);
    if (attachResult === 'invalid') {
      return res.status(400).json({ message: 'Invalid asset reference' });
    }
    if (attachResult === 'missing') {
      return res.status(404).json({ message: 'Asset not found' });
    }
    attachedAsset = attachResult;

    const userDoc = await User.findById(userId);
    if (!userDoc) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Abort the provider call when the client disconnects before the response
    // lands. Shared by the ZDR and persisted paths; symmetric with the
    // streaming route's wiring.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    /*
     * One decision owns the turn's retention shape (#144, services/zdrTurn.ts):
     * reject / suppress-persistence + replay / persist normally. The flag is
     * the effective per-chat incognito state: for a new chat it comes from the
     * request's `zdr` intent (the chat toggle next to attach) or the account's
     * 'incognito by default'; for a sessionId turn it comes from the stored
     * session flag. The bridged account setting still rejects continuation
     * before the read (frozen #116 ordering — see the reject below).
     */
    const accountIncognito = Boolean(userDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito accounts cannot continue a saved chat (#116/#144): the
        // reject fires before any session read.
        turnDecision = decideTurn({ incognito: true, sessionId });
      } else {
        if (!isValidObjectId(sessionId)) {
          await cleanupEphemeralAsset(attachedAsset);
          return res.status(400).json({ message: 'Invalid session id' });
        }
        session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
        if (!session) {
          return res.status(404).json({ message: 'Session not found' });
        }
        turnDecision = decideTurn({ incognito: Boolean(session.incognito), sessionId });
      }
    } else {
      turnDecision = decideTurn({
        incognito: bodyIntent ?? accountIncognito,
        sessionId: undefined,
      });
    }
    if (turnDecision.reject) {
      await cleanupEphemeralAsset(attachedAsset);
      return res.status(409).json({
        message:
          'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
      });
    }
    const cleanupIfEphemeral = async () => {
      if (!turnDecision.requireEphemeralCleanup) return;
      await cleanupEphemeralAsset(attachedAsset);
    };

    if (turnDecision.persistWithHistoryReplay) {
      // Zero-data retention (#116): nothing about the turn is written — no
      // Session row, no Message rows, no classification, no title. The
      // conversation continuity is the client's replayed `history` payload
      // (validation-gated).
      const zdrHistory = parseZdrHistory(req.body.history);
      if (!zdrHistory.ok) {
        // The turn is rejected before it consumes anything, so the throwaway
        // attachment does not outlive the request either (#116).
        await cleanupIfEphemeral();
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      const messages = buildZdrMessages(zdrHistory.value, content);
      await ensureUserLocation(userDoc, req.ip);
      // Plan task 8: ZDR/incognito turns DO retrieve the graph read-only
      // (Alex, 2026-09-21) — but they write nothing, and this branch an early
      // return before any persistence does exactly that. Extraction below
      // never runs for ZDR.
      const zdrEntityBlock = await knowledgeBlockFor(content, userId as string);
      messages.unshift({
        role: 'system',
        content: buildSystemContent(userDoc, zdrEntityBlock),
      });
      appendAssetBlock(messages, attachedAsset);

      const zdrRoutingBand = buildRoutingBand(computeDeterministicMetrics(content));
      const { routing: routingResult, completion: chatCompletion } = await withModelFailover(
        // #169 phase 2: the guard classifies with the replayed context —
        // prior-turns-only by construction of buildZdrMessages.
        () =>
          routeQuery(content, undefined, undefined, {
            band: zdrRoutingBand,
            history: zdrHistory.value,
          }),
        (r) =>
          inferenceService.createCompletion({
            messages,
            model: r.model,
            provider: r.provider,
            userId,
            abortSignal: abortController.signal,
          }),
      );
      const zdrAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
      // #195: a tool-only ZDR turn still ends with a short confirmation.
      const zdrConfirmation = zdrAssistantContent.trim()
        ? null
        : confirmationForToolResults(chatCompletion.toolResults ?? []);
      const zdrFinalContent = zdrAssistantContent.trim()
        ? zdrAssistantContent
        : (zdrConfirmation ?? zdrAssistantContent);
      await cleanupIfEphemeral();
      return res.json({
        routing: routingResult,
        message: {
          role: 'assistant',
          content: zdrFinalContent,
          modelName: routingResult.model,
        },
      });
    }

    // On the sessionId path the session is already loaded above (the decision
    // needs the stored flag first). New persisted chats — the only way to get
    // here — are never incognito: an incognito turn returns in the replay
    // branch above without touching Session, so the flag is pinned to false
    // explicitly (a persisted incognito session would contradict the
    // write-nothing promise this ticket keeps).
    if (!session) {
      session = await createSessionWithUser(userId as string, content, {
        incognito: false,
      });
    }
    // Save user message
    const userMessage = await saveUserMessageWithMetrics(
      String(session!._id),
      content,
      attachedAsset,
    );

    // Feedback aggregation happens under the band captured at route time, so
    // it must be computed before the router sees the turn (decision 4).
    const routingBand = buildRoutingBand(userMessage.metrics);

    // Image turns (#115) route vision-first only when the
    // presign path is actually available; otherwise the turn degrades to the
    // legacy text envelope and normal routing applies. Routing happens inside
    // the failover wrapper below so a failed endpoint can be disabled and
    // re-routed against the fresh pools (#168).
    const hasImage = turnsWithImage(attachedAsset);

    // Get chat history for context. #169 phase 2: the guard classifies the
    // turn with this context too — the window includes the just-saved
    // current turn, which is dropped for the guard (it rides as the query).
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const guardHistory = guardHistoryFromDocs(
      history as unknown as { _id: unknown; role: string; content: string }[],
      userMessage._id,
    );
    const messages = messagesFromPersistedHistory(history as { role: string; content: string }[]);
    // Coarse geolocation (#50): awaited so this turn's prompt can include the
    // country; cheap when cached (fresh/cooldown returns immediately) and the
    // service itself never throws, so chat cannot block hard on it.
    await ensureUserLocation(userDoc, req.ip);
    const entityBlock = await knowledgeBlockFor(content, userId as string);
    messages.unshift({
      role: 'system',
      content: buildSystemContent(userDoc, entityBlock),
    });
    if (attachedAsset) {
      const imageAttached = hasImage ? await buildImageTurn(messages, attachedAsset) : false;
      if (!imageAttached) appendAssetBlock(messages, attachedAsset);
    }

    const { routing: routingResult, completion: chatCompletion } = await withModelFailover(
      () =>
        routeQuery(content, undefined, undefined, {
          band: routingBand,
          hasImage,
          history: guardHistory,
        }),
      (r) =>
        inferenceService.createCompletion({
          messages,
          model: r.model,
          provider: r.provider,
          // #104: always send an output-token budget so the provider cannot
          // default it to the model's whole context window.
          max_tokens: outputTokensFor(r.contextLength, promptCharsFrom(messages)),
          userId,
          abortSignal: abortController.signal,
        }),
    );

    // Empty provider responses persist as '' (fail-visibility, #4 J); the
    // UI presents the '(no content returned)' placeholder.
    const rawAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
    const toolResults = chatCompletion.toolResults ?? [];
    // #195: a tool-only turn ends with a synthesized confirmation instead of
    // silence (the model's own text, when present, is untouched).
    const assistantContent = rawAssistantContent.trim()
      ? rawAssistantContent
      : (confirmationForToolResults(toolResults) ?? rawAssistantContent);

    // Sources from any web_search the agent chose to run (issue #16),
    // persisted only when non-empty. Titles ride along (#33).
    let sources: string[] = [];
    const titles = new Map<string, string>();
    for (const r of toolResults) {
      collectSourcesInto(sources, r.result, titles);
    }
    const sourceTitles = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));

    // Save assistant message
    const assistantMessage = new Message({
      sessionId: session!._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      provider: routingResult.provider,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitles.length > 0 ? { sourceTitles } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();

    // Entity graph extraction (#138): one extra LLM call after the turn is
    // served, fire-and-forget like title generation. Never runs for ZDR
    // chats (handled above), and only when ENTITY_GRAPH_ENABLED is set —
    // extraction is enrichment, so failures log and everything else
    // continues from here.
    if (isEntityExtractionEnabled()) {
      extractAndPersistFromTurn({
        userId: String(userDoc!._id),
        sessionId: String(session!._id),
        messageId: String(assistantMessage._id),
        userText: content,
        assistantText: assistantContent,
      }).catch((err) => console.error('Entity extraction error:', redactForLog(err)));
    }

    res.json({
      sessionId: session!._id,
      message: assistantMessage,
      routing: routingResult,
    });
  } catch (err) {
    console.error('Chat error:', redactForLog(err));
    // A ZDR turn that fails mid-flight (routing, provider, geo, metrics) still
    // erases its throwaway attachment — cleanup is a no-op for durable
    // assets, so the persisted path is untouched (#116).
    await cleanupEphemeralAsset(attachedAsset);
    // #168: every model cooled off after failures → the friendly message
    // becomes the primary error text.
    const allDisabled = err instanceof AllModelsDisabledError;
    res.status(allDisabled ? 503 : 500).json({
      message: allDisabled ? streamingErrorMessage(err) : 'Error processing chat',
      detail: streamingErrorMessage(err),
    });
  }
});

// Chat streaming endpoint (SSE)
router.post('/stream', authenticate, async (req: AuthRequest, res) => {
  // Held outside try so the catch can erase a throwaway attachment on any
  // failure path (#116); Safe: cleanup is a no-op for durable assets.
  let attachedAsset: AssetDoc | null = null;
  try {
    const { sessionId, content } = req.body;
    const userId = req.user?.id;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    if (!(await hasPermission(userId as string, ROUTING_PERMISSION))) {
      return res.status(403).json({ message: NO_ROUTING_PERMISSION });
    }

    const attachResult = await loadAttachedAsset(req);
    if (attachResult === 'invalid') {
      return res.status(400).json({ message: 'Invalid asset reference' });
    }
    if (attachResult === 'missing') {
      return res.status(404).json({ message: 'Asset not found' });
    }
    attachedAsset = attachResult;

    const streamUserDoc = await User.findById(userId);
    if (!streamUserDoc) {
      return res.status(404).json({ message: 'User not found' });
    }
    /*
     * One decision owns the turn's retention shape (#144, services/zdrTurn.ts),
     * mirroring the non-streaming route: the per-chat flag comes from the
     * request's `zdr` intent (new chat) or the account's 'incognito by
     * default'; a sessionId turn decides off the stored session flag. The
     * bridged account setting still rejects continuation before the read.
     */
    const accountIncognito = Boolean(streamUserDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito accounts cannot continue a saved chat (#116/#144): the
        // reject fires before any session read.
        turnDecision = decideTurn({ incognito: true, sessionId });
      } else {
        if (!isValidObjectId(sessionId)) {
          await cleanupEphemeralAsset(attachedAsset);
          return res.status(400).json({ message: 'Invalid session id' });
        }
        session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
        if (!session) {
          return res.status(404).json({ message: 'Session not found' });
        }
        turnDecision = decideTurn({ incognito: Boolean(session.incognito), sessionId });
      }
    } else {
      turnDecision = decideTurn({
        incognito: bodyIntent ?? accountIncognito,
        sessionId: undefined,
      });
    }
    if (turnDecision.reject) {
      await cleanupEphemeralAsset(attachedAsset);
      return res.status(409).json({
        message:
          'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
      });
    }
    const cleanupIfEphemeral = async () => {
      if (!turnDecision.requireEphemeralCleanup) return;
      await cleanupEphemeralAsset(attachedAsset);
    };
    const zdr = turnDecision.persistWithHistoryReplay;

    let zdrHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    if (zdr) {
      // Zero-data retention (#116): see the non-streaming route's rationale —
      // no session is created, and saved chats cannot be continued.
      const parsedHistory = parseZdrHistory(req.body.history);
      if (!parsedHistory.ok) {
        await cleanupIfEphemeral();
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      zdrHistory = parsedHistory.value;
    } else if (!sessionId) {
      session = await createSessionWithUser(userId as string, content, { incognito: false });
    }

    let routingBand: string;
    let routingResult;
    let messages: {
      role: 'system' | 'user' | 'assistant';
      content: string | MessageContentPart[];
    }[];
    // #169 phase 2: the guard classifier's conversation context — prior
    // turns only, computed once per turn and reused by the failover
    // re-route below so a retry never re-derives it.
    let guardHistory: { role: 'user' | 'assistant'; content: string }[] = [];

    // Image turns (#115): gate on both the content type and a configured
    // presign path; the image part replaces the filename envelope this turn.
    const hasImage = turnsWithImage(attachedAsset);

    await ensureUserLocation(streamUserDoc, req.ip);
    if (zdr) {
      // Continuity comes from the client replay (#116); nothing is read back.
      routingBand = buildRoutingBand(computeDeterministicMetrics(content));
      messages = buildZdrMessages(zdrHistory, content);
      // #169 phase 2: the replay is prior-turns-only by construction —
      // exactly the guard's context contract.
      guardHistory = zdrHistory;
      routingResult = await routeQuery(content, undefined, undefined, {
        band: routingBand,
        hasImage,
        history: guardHistory,
      });
    } else {
      // Save user message
      const userMessage = await saveUserMessageWithMetrics(
        String(session!._id),
        content,
        attachedAsset,
      );

      // Feedback aggregation happens under the band captured at route time,
      // so it must be computed before the router sees the turn (decision 4).
      routingBand = buildRoutingBand(userMessage.metrics);

      // Get chat history BEFORE routing (#169 phase 2): the guard
      // classifies the turn with this context — the window includes the
      // just-saved current turn, which is dropped for the guard (it rides
      // as the query).
      const history = await Message.find({ sessionId: session!._id })
        .sort({ timestamp: -1 })
        .limit(10);
      guardHistory = guardHistoryFromDocs(
        history as unknown as { _id: unknown; role: string; content: string }[],
        userMessage._id,
      );

      // Determine model. Same image-turn gating as the non-streaming route (#115).
      routingResult = await routeQuery(content, undefined, undefined, {
        band: routingBand,
        hasImage,
        history: guardHistory,
      });
      messages = messagesFromPersistedHistory(history as { role: string; content: string }[]);
    }

    const streamEntityBlock = await knowledgeBlockFor(content, userId as string);
    messages.unshift({
      role: 'system',
      content: buildSystemContent(streamUserDoc, streamEntityBlock),
    });
    if (attachedAsset) {
      const imageAttached = hasImage ? await buildImageTurn(messages, attachedAsset) : false;
      if (!imageAttached) appendAssetBlock(messages, attachedAsset);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let assistantContent = '';
    let sources: string[] = [];
    const titles = new Map<string, string>();

    // #195: every executed tool of the turn, in order, so a turn that ends
    // with no assistant text can still be confirmed.
    const toolResults: { name: string; result: unknown }[] = [];

    // Reconciled tool events for this turn (#196). Raw SSE 'tool' frames keep
    // firing unchanged; this array is the deduped, persisted companion that
    // the 'done' message and a later refresh read from.
    const toolEvents: PersistedToolEvent[] = [];

    // Abort the provider call when the client disconnects mid-stream. 'close'
    // also fires after a normal end, so only abort when the response did not
    // finish cleanly.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      // #168 failover loop: an endpoint failure (non-abort, non-prompt-size)
      // with no streamed content yet disables the model, re-routes against
      // the fresh pools and re-emits 'meta'. The attempts are naturally
      // bounded — each failure removes the routed model from every pool, so
      // the pool drains and routing eventually fails — but the explicit cap
      // keeps pathological cases loud instead of putting an unbounded loop
      // on the request path.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          sendEvent('meta', {
            // ZDR (#116): no sessionId is minted — nothing the replay could
            // point at exists.
            ...(zdr ? {} : { sessionId: session!._id }),
            routing: routingResult,
          });

          const stream = await inferenceService.createStreamingCompletion({
            messages,
            model: routingResult.model,
            provider: routingResult.provider,
            // #104: always send an output-token budget so the provider cannot
            // default it to the model's whole context window.
            max_tokens: outputTokensFor(routingResult.contextLength, promptCharsFrom(messages)),
            userId,
            abortSignal: abortController.signal,
          });

          for await (const chunk of stream) {
            // Tool feedback (issue #33): structured events replace the single
            // prose status hint — the call event names the tool + query, the
            // result event carries a compact outcome summary.
            if (chunk.toolCall) {
              const ev = toolCallEvent(chunk.toolCall);
              reconcileToolEvent(toolEvents, ev);
              sendEvent('tool', ev);
            }
            if (chunk.toolResult) {
              const ev = toolResultEvent(chunk.toolResult);
              reconcileToolEvent(toolEvents, ev);
              sendEvent('tool', ev);
              collectSourcesInto(sources, chunk.toolResult.result, titles);
              toolResults.push(chunk.toolResult);
            }
            const delta = chunk.delta;
            if (delta) {
              assistantContent += delta;
              sendEvent('delta', { content: delta });
            }
          }
          break;
        } catch (err) {
          if (
            // no deltas yet — mid-stream failures are reported, not retried
            assistantContent === '' &&
            !isClientAbort(err) &&
            !isPromptSizeError(err) &&
            // #168 (decision 2026-09-26): 429 is back-off territory, a
            // separate mechanism — never a cool-off or a pool-draining retry.
            !isRateLimitError(err) &&
            attempt < MAX_ATTEMPTS
          ) {
            const disabled = await disableModel(routingResult.provider, routingResult.model);
            if (!disabled) {
              // Cool-off write failed: the pool is unchanged, so re-routing
              // would re-pick the same broken endpoint — fail the turn with
              // the original error.
              throw err;
            }
            try {
              routingResult = await routeQuery(content, undefined, undefined, {
                band: routingBand,
                hasImage,
                history: guardHistory,
              });
            } catch {
              throw new AllModelsDisabledError();
            }
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error(
        'Streaming error for %s/%s:',
        routingResult.provider,
        routingResult.model,
        redactForLog(err),
      );
      sendEvent('error', { message: streamingErrorMessage(err) });
      sendEvent('done', { complete: false });
      await cleanupEphemeralAsset(attachedAsset);
      res.end();
      return;
    }

    // #195: if the turn ran a user-facing tool but streamed no assistant
    // text — the Mastra-documented "run ends on a tool call" case, e.g. the
    // step cap landing on a tool round — emit a short confirmation as a
    // normal `delta` so the client renders it exactly like model text. A
    // turn that errored above returned already and is never confirmed.
    if (!assistantContent.trim()) {
      const confirmation = confirmationForToolResults(toolResults);
      if (confirmation) {
        assistantContent = confirmation;
        sendEvent('delta', { content: confirmation });
      }
    }

    // Save assistant message. A provider stream that yields no (or only
    // empty) deltas still persists a turn with content: '' — the empty
    // response stays visible as '(no content returned)' in the UI (#4 J).
    // ZDR turns (#116) save nothing: the answer rides the 'done' event only,
    // and the ephemeral attachment, if any, is erased with it.
    const sourceTitleList = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));
    if (zdr) {
      // #196 (D6): reconciled tool summaries are deliberately not attached to
      // ZDR `done` payloads — the turn is not stored, matching the existing
      // "nothing is written" contract. Live 'tool' frames still stream.
      if (!isTriviallyNeutral(content) && assistantContent) {
        // Suggestions are still generated (cheap guard model) — they are
        // delivered without ever being written anywhere.
        const suggestions = await generateFollowups(content, assistantContent);
        sendEvent('done', {
          complete: true,
          message: {
            role: 'assistant',
            content: assistantContent,
            modelName: routingResult.model,
            routingBand,
            ...(suggestions.length > 0 ? { suggestions } : {}),
          },
          ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
        });
        await cleanupEphemeralAsset(attachedAsset);
        res.end();
        return;
      }
      sendEvent('done', {
        complete: true,
        message: {
          role: 'assistant',
          content: assistantContent,
          modelName: routingResult.model,
          routingBand,
        },
        ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
      });
      await cleanupEphemeralAsset(attachedAsset);
      res.end();
      return;
    }

    const assistantMessage = new Message({
      sessionId: session!._id,
      role: 'assistant',
      provider: routingResult.provider,
      content: assistantContent,
      modelName: routingResult.model,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
      // #196: persist the reconciled tool summaries so chips survive a refresh.
      ...(toolEvents.length > 0 ? { tools: toolEvents } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();

    if (isEntityExtractionEnabled()) {
      extractAndPersistFromTurn({
        userId: String(streamUserDoc!._id),
        sessionId: String(session!._id),
        messageId: String(assistantMessage._id),
        userText: content,
        assistantText: assistantContent,
      }).catch((err) => console.error('Entity extraction error:', redactForLog(err)));
    }

    // Follow-up suggestions (issue #33): generated with the cheap guard
    // model, reusing the title/classification service pattern. Skipped for
    // trivially neutral prompts and empty turns so the 'trivial' skip gate
    // stays consistent; the client falls back to static placeholders when
    // the field is absent.
    if (!isTriviallyNeutral(content) && assistantContent) {
      const suggestions = await generateFollowups(content, assistantContent);
      if (suggestions.length > 0) {
        assistantMessage.suggestions = suggestions;
        await assistantMessage.save();
      }
    }

    sendEvent('done', {
      complete: true,
      message: assistantMessage,
      ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
    });
    res.end();
  } catch (err) {
    console.error('Chat stream error:', redactForLog(err));
    // A ZDR turn that fails before or during streaming still erases its
    // throwaway attachment (#116); no-op for durable assets.
    await cleanupEphemeralAsset(attachedAsset);
    if (!res.headersSent) {
      // #168: every model cooled off before the stream opened (the
      // pre-stream routeQuery throws) → the friendly message is the
      // primary text, mirroring the non-streaming route. The client
      // surfaces it on 503 like it does the 403 geo message.
      const allDisabled = err instanceof AllModelsDisabledError;
      res.status(allDisabled ? 503 : 500).json({
        message: allDisabled ? streamingErrorMessage(err) : 'Error processing chat',
        detail: streamingErrorMessage(err),
      });
    } else {
      res.end();
    }
  }
});

// Soft-delete a session
router.delete('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const updated = await Session.findOneAndUpdate(
      { _id: req.params.id, userId: req.user?.id, deletedAt: null },
      { deletedAt: new Date() },
    );
    if (!updated) {
      return res.status(404).json({ message: 'Session not found' });
    }
    res.json({ success: true });
  } catch (_err) {
    res.status(500).json({ message: 'Error deleting session' });
  }
});

// Get all sessions for user
router.get('/sessions', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const sessions = await Session.find({ userId, deletedAt: null }).sort({ updatedAt: -1 });
    res.json(sessions);
  } catch (_err) {
    res.status(500).json({ message: 'Error fetching sessions' });
  }
});

// Get messages for a session
router.get('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const session = await Session.findOne({ _id: req.params.id, userId, deletedAt: null });
    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    const messages = await Message.find({ sessionId: session._id }).sort({
      timestamp: 1,
    });
    res.json({ session, messages });
  } catch (_err) {
    res.status(500).json({ message: 'Error fetching session messages' });
  }
});

export default router;
