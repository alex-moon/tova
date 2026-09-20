import { isValidObjectId } from 'mongoose';
import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { buildAttachmentEnvelope } from '../services/attachmentEnvelope';
import { isImageContentType } from '../services/assetLimits';
import { isStorageConfigured, presignGetUrl } from '../services/storageService';
import { routeQuery } from '../services/routerService';
import { generateChatTitle } from '../services/titleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { buildSystemContent } from '../services/promptAssembly';
import { ensureUserLocation } from '../services/geoLocationService';
import { deleteObject } from '../services/storageService';
import { inferenceService } from '../services/inferenceService';
import { outputTokensFor, promptCharsFrom } from '../services/outputTokenCap';
import type { MessageContentPart, NeutralStreamChunk } from '../services/llmTypes';
import { classifyAndPersistPromptDimensions, isTriviallyNeutral } from '../services/metricsService';
import { computeDeterministicMetrics } from '../services/promptMetrics';
import { generateFollowups } from '../services/followupService';
import { zdrHistorySchema } from '../validation';

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
    isStorageConfigured(),
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
    !isStorageConfigured()
  ) {
    return false;
  }
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return false;
  const url = await presignGetUrl(asset.key);
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
          : name || 'Tool run';

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

const createSessionWithUser = async (userId: string, content: string) => {
  const title = await generateChatTitle(content);
  return Session.create({ userId, title });
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

// Throwaway chat attachments (#116): as soon as the turn that consumed them
// completes, the row and its Spaces object go. Never throws — cleanup must
// not turn a finished answer into an error.
const cleanupEphemeralAsset = async (asset: AssetDoc | null | 'invalid' | 'missing') => {
  if (!asset || asset === 'invalid' || asset === 'missing' || !asset.ephemeral) return;
  try {
    await Asset.deleteOne({ _id: asset._id });
    await deleteObject(asset.key);
  } catch (err) {
    console.error('Ephemeral asset cleanup error:', err);
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
      console.error('Prompt classification error:', err),
    );
  }
  return userMessage;
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

    if (userDoc.settings?.zdr) {
      // Zero-data retention (#116): nothing about the turn is written — no
      // Session row, no Message rows, no classification, no title. The
      // conversation continuity is the client's replayed `history` payload
      // (validation-gated). A ZDR turn must not continue a persisted chat:
      // writing there would contradict the retention promise.
      if (sessionId) {
        await cleanupEphemeralAsset(attachedAsset);
        return res.status(409).json({
          message:
            'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
        });
      }
      const zdrHistory = parseZdrHistory(req.body.history);
      if (!zdrHistory.ok) {
        // The turn is rejected before it consumes anything, so the throwaway
        // attachment does not outlive the request either (#116).
        await cleanupEphemeralAsset(attachedAsset);
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      const messages = buildZdrMessages(zdrHistory.value, content);
      await ensureUserLocation(userDoc, req.ip);
      messages.unshift({ role: 'system', content: buildSystemContent(userDoc) });
      appendAssetBlock(messages, attachedAsset);

      const routingResult = await routeQuery(content, undefined, undefined, {
        band: buildRoutingBand(computeDeterministicMetrics(content)),
      });
      const chatCompletion = await inferenceService.createCompletion({
        messages,
        model: routingResult.model,
        provider: routingResult.provider,
        userId,
        abortSignal: abortController.signal,
      });
      const zdrAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
      await cleanupEphemeralAsset(attachedAsset);
      return res.json({
        routing: routingResult,
        message: {
          role: 'assistant',
          content: zdrAssistantContent,
          modelName: routingResult.model,
        },
      });
    }

    let session;
    if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = await createSessionWithUser(userId as string, content);
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

    // Determine model. Image turns (#115) route vision-first only when the
    // presign path is actually available; otherwise the turn degrades to the
    // legacy text envelope and normal routing applies.
    const hasImage = turnsWithImage(attachedAsset);
    const routingResult = await routeQuery(content, undefined, undefined, {
      band: routingBand,
      hasImage,
    });

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages = messagesFromPersistedHistory(history as { role: string; content: string }[]);
    // Coarse geolocation (#50): awaited so this turn's prompt can include the
    // country; cheap when cached (fresh/cooldown returns immediately) and the
    // service itself never throws, so chat cannot block hard on it.
    await ensureUserLocation(userDoc, req.ip);
    messages.unshift({ role: 'system', content: buildSystemContent(userDoc) });
    if (attachedAsset) {
      const imageAttached = hasImage ? await buildImageTurn(messages, attachedAsset) : false;
      if (!imageAttached) appendAssetBlock(messages, attachedAsset);
    }

    const chatCompletion = await inferenceService.createCompletion({
      messages,
      model: routingResult.model,
      provider: routingResult.provider,
      // #104: always send an output-token budget so the provider cannot
      // default it to the model's whole context window.
      max_tokens: outputTokensFor(routingResult.contextLength, promptCharsFrom(messages)),
      userId,
      abortSignal: abortController.signal,
    });

    // Empty provider responses persist as '' (fail-visibility, #4 J); the
    // UI presents the '(no content returned)' placeholder.
    const assistantContent = chatCompletion.choices[0]?.message?.content ?? '';

    // Sources from any web_search the agent chose to run (issue #16),
    // persisted only when non-empty. Titles ride along (#33).
    let sources: string[] = [];
    const titles = new Map<string, string>();
    for (const r of chatCompletion.toolResults ?? []) {
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

    res.json({
      sessionId: session!._id,
      message: assistantMessage,
      routing: routingResult,
    });
  } catch (err) {
    console.error('Chat error:', err);
    // A ZDR turn that fails mid-flight (routing, provider, geo, metrics) still
    // erases its throwaway attachment — cleanup is a no-op for durable
    // assets, so the persisted path is untouched (#116).
    await cleanupEphemeralAsset(attachedAsset);
    res.status(500).json({ message: 'Error processing chat' });
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
    const zdr = Boolean(streamUserDoc.settings?.zdr);

    let session;
    let zdrHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    if (zdr) {
      // Zero-data retention (#116): see the non-streaming route's rationale —
      // no session is created, and saved chats cannot be continued.
      if (sessionId) {
        await cleanupEphemeralAsset(attachedAsset);
        return res.status(409).json({
          message:
            'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
        });
      }
      const parsedHistory = parseZdrHistory(req.body.history);
      if (!parsedHistory.ok) {
        await cleanupEphemeralAsset(attachedAsset);
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      zdrHistory = parsedHistory.value;
    } else if (sessionId) {
      session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
    } else {
      session = await createSessionWithUser(userId as string, content);
    }

    let routingBand: string;
    let routingResult;
    let messages: {
      role: 'system' | 'user' | 'assistant';
      content: string | MessageContentPart[];
    }[];

    // Image turns (#115): gate on both the content type and a configured
    // presign path; the image part replaces the filename envelope this turn.
    const hasImage = turnsWithImage(attachedAsset);

    await ensureUserLocation(streamUserDoc, req.ip);
    if (zdr) {
      // Continuity comes from the client replay (#116); nothing is read back.
      routingBand = buildRoutingBand(computeDeterministicMetrics(content));
      messages = buildZdrMessages(zdrHistory, content);
      routingResult = await routeQuery(content, undefined, undefined, {
        band: routingBand,
        hasImage,
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

      // Determine model. Same image-turn gating as the non-streaming route (#115).
      routingResult = await routeQuery(content, undefined, undefined, {
        band: routingBand,
        hasImage,
      });

      // Get chat history for context
      const history = await Message.find({ sessionId: session!._id })
        .sort({ timestamp: -1 })
        .limit(10);
      messages = messagesFromPersistedHistory(history as { role: string; content: string }[]);
    }

    messages.unshift({ role: 'system', content: buildSystemContent(streamUserDoc) });
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

    sendEvent('meta', {
      // ZDR (#116): no sessionId is minted — nothing the replay could point
      // at exists.
      ...(zdr ? {} : { sessionId: session!._id }),
      routing: routingResult,
    });

    let assistantContent = '';
    let sources: string[] = [];
    const titles = new Map<string, string>();

    // Abort the provider call when the client disconnects mid-stream. 'close'
    // also fires after a normal end, so only abort when the response did not
    // finish cleanly.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
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
          sendEvent('tool', toolCallEvent(chunk.toolCall));
        }
        if (chunk.toolResult) {
          sendEvent('tool', toolResultEvent(chunk.toolResult));
          collectSourcesInto(sources, chunk.toolResult.result, titles);
        }
        const delta = chunk.delta;
        if (delta) {
          assistantContent += delta;
          sendEvent('delta', { content: delta });
        }
      }
    } catch (err) {
      console.error('Streaming error for %s/%s:', routingResult.provider, routingResult.model, err);
      sendEvent('error', { message: streamingErrorMessage(err) });
      sendEvent('done', { complete: false });
      await cleanupEphemeralAsset(attachedAsset);
      res.end();
      return;
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
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();

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
    console.error('Chat stream error:', err);
    // A ZDR turn that fails before or during streaming still erases its
    // throwaway attachment (#116); no-op for durable assets.
    await cleanupEphemeralAsset(attachedAsset);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error processing chat' });
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
