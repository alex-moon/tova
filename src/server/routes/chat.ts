import { isValidObjectId } from 'mongoose';
import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { buildAttachmentEnvelope } from '../services/attachmentEnvelope';
import { routeQuery } from '../services/routerService';
import { generateChatTitle } from '../services/titleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { buildSystemContent } from '../services/promptAssembly';
import { ensureUserLocation } from '../services/geoLocationService';
import { inferenceService } from '../services/inferenceService';
import type { NeutralStreamChunk } from '../services/llmTypes';
import { classifyAndPersistPromptDimensions, isTriviallyNeutral } from '../services/metricsService';
import { computeDeterministicMetrics } from '../services/promptMetrics';
import { generateFollowups } from '../services/followupService';

const router = express.Router();

const NO_ROUTING_PERMISSION = "You don't have permission to use the model router.";

type AssetDoc = {
  _id: unknown;
  filename: string;
  contentType: string;
  size: number;
  textExtracted?: string | null;
  markdownExtracted?: string | null;
};

// Asset attach (issue #34): resolves the attached asset for a turn — 'none'
// when the request sent no assetId, 'invalid' for a malformed reference,
// 'missing' when it points at a different user's asset.
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
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
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

const toolResultEvent = (result: { name: string; result: unknown }) => {
  const items = Array.isArray((result.result as { results?: unknown })?.results)
    ? (result.result as { results: unknown[] }).results
    : [];
  const urls = items
    .map((item) => (item as { url?: unknown } | null)?.url)
    .filter((url): url is string => typeof url === 'string' && url !== '');
  return {
    phase: 'result' as const,
    name: result.name,
    label: toolLabelFrom(result.name),
    status: urls.length > 0 ? ('ok' as const) : ('empty' as const),
    resultCount: urls.length,
    ...(urls.length > 0 ? { domains: domainsFrom(urls) } : {}),
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
    const attachedAsset = attachResult;

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
      String(session._id),
      content,
      attachedAsset,
    );

    // Feedback aggregation happens under the band captured at route time, so
    // it must be computed before the router sees the turn (decision 4).
    const routingBand = buildRoutingBand(userMessage.metrics);

    // Abort the provider call when the client disconnects before the JSON
    // response lands. Symmetric with the streaming route's 6c wiring.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    // Determine model
    const routingResult = await routeQuery(content, undefined, undefined, { band: routingBand });

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
      }));
    const userDoc = await User.findById(userId);
    // Coarse geolocation (#50): awaited so this turn's prompt can include the
    // country; cheap when cached (fresh/cooldown returns immediately) and the
    // service itself never throws, so chat cannot block hard on it.
    if (userDoc) await ensureUserLocation(userDoc, req.ip);
    messages.unshift({ role: 'system', content: buildSystemContent(userDoc) });
    appendAssetBlock(messages, attachedAsset);

    const chatCompletion = await inferenceService.createCompletion({
      messages,
      model: routingResult.model,
      provider: routingResult.provider,
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
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitles.length > 0 ? { sourceTitles } : {}),
      metrics: await buildMessageMetrics(String(session._id), assistantContent),
    });
    await assistantMessage.save();

    res.json({
      sessionId: session._id,
      message: assistantMessage,
      routing: routingResult,
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ message: 'Error processing chat' });
  }
});

// Chat streaming endpoint (SSE)
router.post('/stream', authenticate, async (req: AuthRequest, res) => {
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
    const attachedAsset = attachResult;

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
      String(session._id),
      content,
      attachedAsset,
    );

    // Feedback aggregation happens under the band captured at route time, so
    // it must be computed before the router sees the turn (decision 4).
    const routingBand = buildRoutingBand(userMessage.metrics);

    // Determine model
    const routingResult = await routeQuery(content, undefined, undefined, { band: routingBand });

    // Get chat history for context
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = history
      .reverse()
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
      }));
    const streamUserDoc = await User.findById(userId);
    // Same geo wiring as the non-streaming route (#50): awaited so the
    // streamed prompt is deterministic, cheap when cached.
    if (streamUserDoc) await ensureUserLocation(streamUserDoc, req.ip);
    messages.unshift({ role: 'system', content: buildSystemContent(streamUserDoc) });
    appendAssetBlock(messages, attachedAsset);

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
      sessionId: session._id,
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
      console.error('Groq streaming error:', err);
      sendEvent('error', { message: streamingErrorMessage(err) });
      sendEvent('done', { complete: false });
      res.end();
      return;
    }

    // Save assistant message. A provider stream that yields no (or only
    // empty) deltas still persists a turn with content: '' — the empty
    // response stays visible as '(no content returned)' in the UI (#4 J).
    const sourceTitleList = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));
    const assistantMessage = new Message({
      sessionId: session._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      routingBand,
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
      metrics: await buildMessageMetrics(String(session._id), assistantContent),
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
