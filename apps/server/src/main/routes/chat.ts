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
import {
  pickRosterRoute,
  routeAndComplete,
  routeAndStream,
  type RosterRoutingResult,
} from '../services/racingService';
import { generateChatTitle } from '../services/titleService';
import { reviseSessionSubtitle, type SubtitleTurn } from '../services/subtitleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { buildSystemContent, timestampHeader } from '../services/promptAssembly';
import { ensureUserLocation } from '../services/geoLocationService';
import { outputTokensFor, promptCharsFrom } from '../services/outputTokenCap';
import type { MessageContentPart, NeutralStreamChunk } from '../services/llmTypes';
import { classifyAndPersistPromptDimensions, isTriviallyNeutral } from '../services/metricsService';
import { computeDeterministicMetrics } from '../services/promptMetrics';
import { generateFollowups } from '../services/followupService';
import { zdrHistorySchema } from '../validation';
import { redactForLog } from '../services/logRedaction';
import { decideTurn } from '../services/zdrTurn';
import { AllModelsDisabledError } from '../services/modelConfigService';
import { workspaceGateFrom, workspaceTraceMetadata } from '../services/workspaceTraceFacts';
import {
  isWorkspaceMemoryEnabled,
  retrieveWorkspaceBlock,
} from '../services/workspaceRetrievalService';
import { enqueueWorkspaceEmbedding } from '../services/workspaceEmbeddingIngest';
import { TaskEvent } from '../models/TaskEvent';
import type { TaskDocument } from '../models/Task';
import {
  completionNotificationLine,
  markNotified,
  pendingCompletionsFor,
} from '../services/taskNotificationService';

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

// Resolves the attached asset for a turn: 'none' when absent, 'invalid' for a malformed reference, 'missing' for another user's asset.
// @see #34
// Turns that will actually carry pixels; mirrors buildImageTurn's conditions so routing and message assembly can never disagree.
// @see #115
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

// Attached file text rides the structured attachment envelope; the persisted user message stays raw text so UI and metrics are unaffected.
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
      // Markdown conversion is the fallback source when no fast-path extraction exists.
      // @see #67
      textExtracted: asset.textExtracted ?? asset.markdownExtracted ?? null,
    });
  }
};

// Image attachments become real content parts via a presigned Spaces GET URL; the envelope is skipped for images; without storage the pre-#115 degradation holds.
// @see #115
const buildImageTurn = async (
  messages: { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[],
  asset: AssetDoc,
): Promise<boolean> => {
  // `ready` matters: a pending upload has no object in Spaces yet, so the presigned GET would 404 inside the model's fetch.
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

// Collect web_search result URLs incrementally deduplicated; malformed entries are never fatal; per-source titles captured for the client's sources block.
// @see #16 #33

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

// Provider-neutral tool outcome summaries for the SSE 'tool' events.
// @see #33
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
            : name === 'edit_file'
              ? 'Updated a file'
              : name === 'search_tools'
                ? 'Searched connected tools'
                : name || 'Tool run';

/* Internal bookkeeping tools: a turn whose only tool was one of these must not synthesize a confirmation. */
// @see #195 #360
const NON_CONFIRMING_TOOLS = new Set(['current_datetime', 'search_tools']);

// Completed-tool confirmation: when a turn ran a user-facing tool but produced no text, derive a short sentence; a real answer always wins byte-for-byte.
// @see #195
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
    } else if (name === 'edit_file') {
      const filename = (result as { file?: { filename?: unknown } } | null)?.file?.filename;
      phrase =
        typeof filename === 'string' && filename !== ''
          ? `Updated ${filename}.`
          : 'Updated the file.';
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

/* Stream error surfacing: a 413/prompt-size failure is actionable (connected toolsets bloat the request), so say so instead of the generic message. */
// @see #77
export const streamingErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  // When every model cooled off after failures, the message itself is the end-user text — pass it through verbatim.
  // @see #168
  if (err instanceof AllModelsDisabledError) return message;
  if (statusCode === 413 || /Request too large/.test(message)) {
    return (
      'Request too large for this deployment’s current rate limit — connected connectors ' +
      'may have added many tools to the request. Try again shortly or disconnect some in /connectors.'
    );
  }
  /* A 429 (or its message body, rethrown without a status code) is actionable — surface a retry suggestion. */
  // @see #117
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
      // Malformed URL: skip silently.
    }
  }
  return [...hosts].slice(0, 5);
};

// Result chip counts: per-tool counting semantics instead of a universal count-every-array heuristic; no count is not absence of success.
// @see #114
const singleArrayFieldLength = (result: unknown): number | null => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const arrayFields = Object.values(result).filter((value) => Array.isArray(value));
  return arrayFields.length === 1 ? (arrayFields[0] as unknown[]).length : null;
};

type ToolCallEvent = ReturnType<typeof toolCallEvent>;
type ToolResultEvent = ReturnType<typeof toolResultEvent>;

// Persisted tool entry: an unresolved call stays phase 'call' (the live throbber); a resolved entry carries the result plus the query copied from the call.
// @see #196
export type PersistedToolEvent = (ToolCallEvent | ToolResultEvent) & { query?: string };

/* Reconcile a tool event onto the running per-turn list: a result merges into the most recent unresolved like-named call; unmatched results append; mutates and returns the list. */
// @see #196
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

/* Paragraph-break separator: top streamed content up to exactly one blank line when text resumes after a tool use; pure for unit tests. */
// @see #262
export const paragraphBreakFor = (contentEnding: string): string => {
  const trailingNewlines = contentEnding.match(/\n*$/)?.[0].length ?? 0;
  return '\n\n'.slice(Math.min(trailingNewlines, 2));
};

// Exported so the task sequencer builds the same tool chips the chat path persists; optional `args` recovers the call's query from the result alone.
// @see #254 #196
export const toolResultEvent = (result: {
  name: string;
  result: unknown;
  args?: Record<string, unknown>;
}) => {
  const base = {
    phase: 'result' as const,
    name: result.name,
    label: toolLabelFrom(result.name),
    ...(typeof result.args?.query === 'string' && result.args.query
      ? { query: result.args.query }
      : {}),
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
  if (result.name === 'edit_file') {
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
      // Degraded: empty files + error → no count.
      // @see #114
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

// Session indices count only prior messages (computed before .save()), so a session's first message gets index 0; count-based indices are racy but accepted for analytical metrics.
// @see #17
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

/* The subtitle is a soft, revisable signal — never worth turn latency: fire-and-forget after the assistant save; first after turn 2, then every 6th. */
// @see #359
const SUBTITLE_FIRST_TURN = 2;
const SUBTITLE_EVERY_TURNS = 6;
const SUBTITLE_INPUT_TURNS = 3;

const maybeReviseSubtitle = async (sessionId: string): Promise<void> => {
  try {
    const turns = await Message.countDocuments({ sessionId, role: 'assistant' });
    if (turns !== SUBTITLE_FIRST_TURN && turns % SUBTITLE_EVERY_TURNS !== 0) return;
    const [session, recent] = await Promise.all([
      Session.findById(sessionId).select({ subtitle: 1 }).lean(),
      Message.find({ sessionId })
        .sort({ timestamp: -1 })
        .limit(SUBTITLE_INPUT_TURNS)
        .select({ role: 1, content: 1 })
        .lean<{ role: 'user' | 'assistant'; content: string }[]>(),
    ]);
    const current = (session?.subtitle ?? null) as string | null;
    const next = await reviseSessionSubtitle(current, recent.slice().reverse() as SubtitleTurn[]);
    if (next && next !== current) {
      await Session.updateOne({ _id: sessionId }, { $set: { subtitle: next } });
    }
  } catch (err) {
    console.error('Subtitle revision error:', redactForLog(err));
  }
};

/* Zero-data retention: the routes keep nothing; continuity within an ephemeral chat is the client's bounded, validated history replay. */
// @see #116
const buildZdrMessages = (
  history: { role: 'user' | 'assistant'; content: string }[],
  content: string,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] => [
  ...history,
  { role: 'user', content },
];

/* Newest-first docs; prompt-only timestamp header on user turns; provenance line on assistant turns. */
// @see #261 #315 #360
export const toolProvenanceLine = (
  tools: { phase?: string; name?: string }[] | undefined,
): string => {
  if (!Array.isArray(tools)) return '';
  const counts = new Map<string, number>();
  for (const t of tools) {
    if (t?.phase !== 'result' || typeof t.name !== 'string' || !t.name) continue;
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  const summary = [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ');
  return `\n\n[tools used: ${summary}]`;
};

export const messagesFromPersistedHistory = (
  history: {
    role: string;
    content: string;
    timestamp?: Date;
    tools?: { phase?: string; name?: string }[];
  }[],
  timezone?: string | null,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] =>
  history.reverse().map((m, i) => {
    const header =
      m.role === 'user' && m.timestamp
        ? `${timestampHeader(m.timestamp, history[i - 1]?.timestamp, timezone)}\n`
        : '';
    const provenance = m.role === 'assistant' ? toolProvenanceLine(m.tools) : '';
    return {
      role: m.role as 'user' | 'assistant',
      content: header + (m.content as string) + provenance,
    };
  });

/* Newest-kept history window for the 1M-token roster windows; the 413/failover path bounds outliers. */
// @see #360
export const HISTORY_MAX_MESSAGES = 200;
export const HISTORY_MAX_CHARS = 400_000;
export const windowedHistory = <T extends { content?: string | null }>(docs: T[]): T[] => {
  let used = 0;
  let count = 0;
  for (const doc of docs) {
    used += (doc.content ?? '').length;
    if (used > HISTORY_MAX_CHARS) break;
    count += 1;
  }
  return docs.slice(0, Math.min(count, HISTORY_MAX_MESSAGES));
};

// Throwaway chat attachments: the row and its Spaces object go once consumed; cleanup never throws.
// @see #116
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

// Persist the user turn with its metrics; trivially neutral prompts record llmSkipReason 'trivial' so skips are distinguishable from failures; the gate is computed once.
const saveUserMessageWithMetrics = async (
  userId: string,
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

  // Record the session's most recent message time so the list orders by activity; awaited so sidebar order cannot lag the turn.
  // @see #226
  await Session.updateOne({ _id: sessionId }, { $set: { lastMessageAt: userMessage.timestamp } });

  // Embed the saved turn for semantic retrieval: fire-and-forget, flag-gated, never affects the turn; only reached on non-ZDR paths.
  // @see #294
  enqueueWorkspaceEmbedding({
    userId,
    kind: 'chat',
    sourceId: String(userMessage._id),
    source: { kind: 'chat', content },
  });

  if (!triviallyNeutral) {
    classifyAndPersistPromptDimensions(String(userMessage._id), content, sessionId).catch((err) =>
      console.error('Prompt classification error:', redactForLog(err)),
    );
  }
  return userMessage;
};

/* The workspace-memory read: unconditional on text turns (the relevance bar is the rerank, not an aux vote), never throws; excludes the current turn/asset so the turn can't be its own "past work". */
// @see #253 #310 #305
const workspaceBlockFor = async (
  prompt: string,
  userId: string,
  opts: {
    skipWorkspace?: boolean;
    excludeMessageId?: string;
    excludeAssetId?: string;
  } = {},
): Promise<string> => {
  if (opts.skipWorkspace || !isWorkspaceMemoryEnabled()) return '';
  return retrieveWorkspaceBlock(
    prompt,
    userId,
    undefined,
    opts.excludeMessageId,
    opts.excludeAssetId,
  );
};

/* Read completed background tasks into the turn's context as a queued write; reads only — the caller marks notified after the assistant message persists, preferring a wider exactly-once race over losing a completion. */
// @see #255
const taskCompletionBlockFor = async (
  userId: string,
  sessionId: string,
): Promise<{ block: string; taskIds: TaskDocument['_id'][] }> => {
  try {
    const pending = await pendingCompletionsFor(userId, sessionId);
    if (pending.length === 0) return { block: '', taskIds: [] };
    const lines: string[] = [];
    for (const task of pending) {
      const lastStep = await TaskEvent.findOne({
        taskId: task._id,
        role: 'assistant',
        content: { $ne: '' },
      }).sort({ seq: -1 });
      lines.push(completionNotificationLine(task, lastStep?.content ?? ''));
    }
    return { block: lines.join('\n'), taskIds: pending.map((t) => t._id) };
  } catch (err) {
    console.error('Task completion drain error:', redactForLog(err));
    return { block: '', taskIds: [] };
  }
};

// Chat endpoint (non-streaming, preserved for compatibility)
router.post('/', authenticate, async (req: AuthRequest, res) => {
  // Held outside try so the catch can erase a throwaway attachment on any failure path.
  // @see #116
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

    // Abort the provider call when the client disconnects before the response lands.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    /* One decision owns the turn's retention shape: reject / replay / persist; the effective per-chat flag comes from the stored session or the request intent. */
    // @see #144 #116
    const accountIncognito = Boolean(userDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito accounts cannot continue a saved chat: the reject fires before any session read.
        // @see #116 #144
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
      // Zero-data retention: nothing about the turn is written; continuity is the client's replayed history payload.
      // @see #116
      const zdrHistory = parseZdrHistory(req.body.history);
      if (!zdrHistory.ok) {
        // The turn is rejected before it consumes anything, so the throwaway attachment does not outlive the request.
        // @see #116
        await cleanupIfEphemeral();
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      await ensureUserLocation(userDoc, req.ip);
      /* A ZDR turn may read the workspace (read-only) — it writes nothing, so it is absent from the corpus by construction. */
      // @see #253
      const zdrWorkspaceBlock = await workspaceBlockFor(content, userId as string);

      /* ZDR continuity is the client replay; the prompt is assembled once and raced. */
      // @see #232
      const zdrMessages = (): ReturnType<typeof buildZdrMessages> => {
        const turnMessages = buildZdrMessages(zdrHistory.value, content);
        turnMessages.unshift({
          role: 'system',
          content: buildSystemContent(userDoc, true, userDoc.settings?.timezone, zdrWorkspaceBlock),
        });
        appendAssetBlock(turnMessages, attachedAsset);
        return turnMessages;
      };
      // ZDR turns never carry image parts; an empty roster surfaces as the all-disabled error.
      const zdrPrePick = await pickRosterRoute();
      if (!zdrPrePick) throw new AllModelsDisabledError();
      const raced = await routeAndComplete({
        messages: zdrMessages(),
        userId,
        abortSignal: abortController.signal,
      });
      const routingResult: RosterRoutingResult = raced.routing;
      const chatCompletion = raced.outcome.result.completion;
      const zdrAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
      // A tool-only ZDR turn still ends with a short confirmation.
      // @see #195
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

    // On the sessionId path the session is already loaded above; new persisted chats are never incognito (an incognito turn returns in the replay branch), so the flag is pinned false explicitly.
    // @see #116
    if (!session) {
      session = await createSessionWithUser(userId as string, content, {
        incognito: false,
      });
    }
    // Save user message
    const userMessage = await saveUserMessageWithMetrics(
      userId as string,
      String(session!._id),
      content,
      attachedAsset,
    );

    // Image turns route vision-first only when storage is available; otherwise the turn degrades to the legacy text envelope.
    // @see #115
    const hasImage = turnsWithImage(attachedAsset);

    // Get chat history for context — the window includes the just-saved current turn, reversing to oldest-first for the prompt.
    // @see #360
    const history = windowedHistory(
      await Message.find({ sessionId: session._id })
        .sort({ timestamp: -1 })
        .limit(HISTORY_MAX_MESSAGES),
    );
    // Coarse geolocation: awaited so this turn's prompt can include the country; the service never throws.
    // @see #50
    await ensureUserLocation(userDoc, req.ip);
    /* The workspace-memory block is retrieved unconditionally — no aux vote; image turns skip the read. */
    // @see #253 #310
    const workspaceBlock = await workspaceBlockFor(content, userId as string, {
      skipWorkspace: hasImage,
      excludeMessageId: String(userMessage._id),
      excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
    });
    // The retrieval outcome + hit count ride the main call's trace metadata so the admin Traces tab can show them per turn.
    // @see #308
    const workspaceMetadata = workspaceTraceMetadata(
      workspaceGateFrom(workspaceBlock, hasImage),
      workspaceBlock,
    );
    const withSystemAndAsset = async (systemContent: string) => {
      const next = messagesFromPersistedHistory(
        history as {
          role: string;
          content: string;
          timestamp?: Date;
          tools?: { phase?: string; name?: string }[];
        }[],
        userDoc.settings?.timezone,
      );
      next.unshift({ role: 'system', content: systemContent });
      if (attachedAsset) {
        const imageAttached = hasImage ? await buildImageTurn(next, attachedAsset) : false;
        if (!imageAttached) appendAssetBlock(next, attachedAsset);
      }
      return next;
    };

    /* The turn races the fixed roster; the prompt is assembled once and the budget sized against the pre-race pick's window; an empty roster surfaces as the all-disabled error. */
    // @see #232 #310
    const rosterPrePick = await pickRosterRoute();
    if (!rosterPrePick) throw new AllModelsDisabledError();
    // Completed background tasks ride this turn's context (queued write); marked notified only after the assistant message persists.
    // @see #255
    const taskCompletion = await taskCompletionBlockFor(userId as string, String(session!._id));
    const turnMessages = await withSystemAndAsset(
      buildSystemContent(
        userDoc,
        false,
        userDoc.settings?.timezone,
        workspaceBlock,
        taskCompletion.block,
      ),
    );
    const raced = await routeAndComplete({
      messages: turnMessages,
      max_tokens: outputTokensFor(rosterPrePick.contextLength, promptCharsFrom(turnMessages)),
      userId,
      abortSignal: abortController.signal,
      // Tool-execution session (distinct from the trace) so generate_file can stamp provenance.
      // @see #252
      sessionId: String(session!._id),
      trace: { sessionId: String(session!._id), metadata: workspaceMetadata },
    });
    const routingResult: RosterRoutingResult = raced.routing;
    const chatCompletion = raced.outcome.result.completion;

    // Empty provider responses persist as '' (fail-visibility); the UI shows the placeholder.
    // @see #4
    const rawAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
    const toolResults = chatCompletion.toolResults ?? [];
    // A tool-only turn ends with a synthesized confirmation instead of silence.
    // @see #195
    const assistantContent = rawAssistantContent.trim()
      ? rawAssistantContent
      : (confirmationForToolResults(toolResults) ?? rawAssistantContent);

    // Sources from any web_search, persisted only when non-empty.
    // @see #16 #33
    let sources: string[] = [];
    const titles = new Map<string, string>();
    for (const r of toolResults) {
      collectSourcesInto(sources, r.result, titles);
    }
    const sourceTitles = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));

    // Reconciled tool chips for the persisted turn.
    // @see #196 #360
    const toolEvents: PersistedToolEvent[] = [];
    for (const r of toolResults) reconcileToolEvent(toolEvents, toolResultEvent(r));

    // Save assistant message
    const assistantMessage = new Message({
      sessionId: session!._id,
      role: 'assistant',
      content: assistantContent,
      modelName: routingResult.model,
      provider: routingResult.provider,
      ...(chatCompletion.usage ? { usage: chatCompletion.usage } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitles.length > 0 ? { sourceTitles } : {}),
      ...(toolEvents.length > 0 ? { tools: toolEvents } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();
    void maybeReviseSubtitle(String(session!._id));

    // The completion notification has landed in the chat stream, so mark the drained tasks notified; a failure is swallowed (at-least-once re-surface next turn).
    // @see #255
    await markNotified(taskCompletion.taskIds).catch((err) =>
      console.error('Task mark-notified error:', redactForLog(err)),
    );

    res.json({
      sessionId: session!._id,
      message: assistantMessage,
      routing: routingResult,
    });
  } catch (err) {
    console.error('Chat error:', redactForLog(err));
    // A ZDR turn failing mid-flight still erases its throwaway attachment; cleanup is a no-op for durable assets.
    // @see #116
    await cleanupEphemeralAsset(attachedAsset);
    // Every model cooled off after failures → the friendly message becomes the primary error text.
    // @see #168
    const allDisabled = err instanceof AllModelsDisabledError;
    res.status(allDisabled ? 503 : 500).json({
      message: allDisabled ? streamingErrorMessage(err) : 'Error processing chat',
      detail: streamingErrorMessage(err),
    });
  }
});

// Chat streaming endpoint (SSE)
router.post('/stream', authenticate, async (req: AuthRequest, res) => {
  // Held outside try so the catch can erase a throwaway attachment on any failure path; cleanup is a no-op for durable assets.
  // @see #116
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
    /* One decision owns the turn's retention shape, mirroring the non-streaming route: stored session flag for sessionId turns, request intent otherwise. */
    // @see #144 #116
    const accountIncognito = Boolean(streamUserDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito accounts cannot continue a saved chat: the reject fires before any session read.
        // @see #116 #144
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
      // Zero-data retention: see the non-streaming route's rationale — no session is created, and saved chats cannot be continued.
      // @see #116
      const parsedHistory = parseZdrHistory(req.body.history);
      if (!parsedHistory.ok) {
        await cleanupIfEphemeral();
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      zdrHistory = parsedHistory.value;
    } else if (!sessionId) {
      session = await createSessionWithUser(userId as string, content, { incognito: false });
    }

    let routingResult: RosterRoutingResult;
    let messages: {
      role: 'system' | 'user' | 'assistant';
      content: string | MessageContentPart[];
    }[];

    // Image turns: gate on both the content type and a configured presign path; the image part replaces the filename envelope.
    // @see #115
    const hasImage = turnsWithImage(attachedAsset);

    /* The pre-race pick supplies the contextLength for the output budget and the pre-race `meta`; the flat race decides the winner from live TTFT. */
    // @see #232 #316
    const rosterRoute = await pickRosterRoute();
    if (!rosterRoute) throw new AllModelsDisabledError();

    await ensureUserLocation(streamUserDoc, req.ip);
    /* The workspace-memory block is retrieved unconditionally — no aux vote; ZDR turns may read (read-only) but never write; image turns skip the read. */
    // @see #253 #310
    let streamWorkspaceBlock = '';
    // Completed background tasks for this session, drained into the persisted turn's context (empty on ZDR); marked notified only once the assistant message lands.
    // @see #255
    let streamTaskBlock = '';
    let streamTaskIds: TaskDocument['_id'][] = [];
    if (zdr) {
      // Continuity comes from the client replay; nothing is read back.
      // @see #116
      messages = buildZdrMessages(zdrHistory, content);
      routingResult = rosterRoute;
      streamWorkspaceBlock = await workspaceBlockFor(content, userId as string);
    } else {
      // Save user message
      const userMessage = await saveUserMessageWithMetrics(
        userId as string,
        String(session!._id),
        content,
        attachedAsset,
      );

      // Get chat history — the window includes the just-saved current turn, reversing to oldest-first for the prompt.
      // @see #360
      const history = windowedHistory(
        await Message.find({ sessionId: session!._id })
          .sort({ timestamp: -1 })
          .limit(HISTORY_MAX_MESSAGES),
      );

      streamWorkspaceBlock = await workspaceBlockFor(content, userId as string, {
        skipWorkspace: hasImage,
        excludeMessageId: String(userMessage._id),
        excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
      });
      // Drain completed origin tasks (queued write) into this turn.
      // @see #255
      const streamTaskCompletion = await taskCompletionBlockFor(
        userId as string,
        String(session!._id),
      );
      streamTaskBlock = streamTaskCompletion.block;
      streamTaskIds = streamTaskCompletion.taskIds;

      // Same image-turn gating as the non-streaming route.
      // @see #115
      routingResult = rosterRoute;
      messages = messagesFromPersistedHistory(
        history as {
          role: string;
          content: string;
          timestamp?: Date;
          tools?: { phase?: string; name?: string }[];
        }[],
        streamUserDoc.settings?.timezone,
      );
    }

    messages.unshift({
      role: 'system',
      // Persisted turns carry per-message timestamps (no date line); ZDR turns are untimestamped and keep the date line as their only clock.
      // @see #261
      content: buildSystemContent(
        streamUserDoc,
        zdr,
        streamUserDoc.settings?.timezone,
        streamWorkspaceBlock,
        streamTaskBlock,
      ),
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

    // Every executed tool of the turn, in order, so a text-less turn can still be confirmed.
    // @see #195
    const toolResults: { name: string; result: unknown }[] = [];

    // Reconciled tool events for this turn: the deduped, persisted companion the 'done' message and a refresh read from.
    // @see #196
    const toolEvents: PersistedToolEvent[] = [];

    // Token usage for the turn, surfaced by the connector as a single trailing `usage` chunk.
    // @see #224
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    // Abort the provider call when the client disconnects mid-stream; 'close' also fires after a normal end, so only abort when unfinished.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      sendEvent('meta', {
        // ZDR: no sessionId is minted — nothing the replay could point at exists.
        // @see #116
        ...(zdr ? {} : { sessionId: session!._id }),
        routing: routingResult,
      });

      /* The flat race fires every live combo and keeps the first token's stream; losers record TTFT and abort; the winner replaces the pre-race pick for persistence. */
      // @see #232 #316
      const raced = await routeAndStream({
        messages,
        // Budget sized against the picked model's window.
        // @see #104
        max_tokens: outputTokensFor(routingResult.contextLength, promptCharsFrom(messages)),
        userId,
        abortSignal: abortController.signal,
        // Attach the chat session to this turn's trace (ZDR turns have no session to join); the workspace retrieval outcome rides the trace metadata.
        // @see #224 #308
        ...(zdr
          ? {}
          : {
              trace: {
                sessionId: String(session!._id),
                metadata: workspaceTraceMetadata(
                  workspaceGateFrom(streamWorkspaceBlock, hasImage),
                  streamWorkspaceBlock,
                ),
              },
            }),
        // The tool-execution session rides outside the trace guard (ZDR turns have no durable session to attribute to).
        // @see #252
        ...(zdr ? {} : { sessionId: String(session!._id) }),
      });
      routingResult = raced.routing;
      const stream = raced.outcome.result.stream;

      /* A tool use between two text runs must render as a paragraph break: arm on tool-after-text, consume on the next delta. */
      // @see #262
      let toolRanSinceText = false;
      for await (const chunk of stream) {
        // The connector may emit one trailing usage chunk; capture it without forwarding it as a delta/tool event.
        // @see #224
        if (chunk.usage) {
          usage = chunk.usage;
          continue;
        }
        // Structured tool events replace the single prose status hint.
        // @see #33
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
        // Arm the break on any tool chunk that follows already-streamed text.
        if ((chunk.toolCall || chunk.toolResult) && assistantContent.length > 0) {
          toolRanSinceText = true;
        }
        const delta = chunk.delta;
        if (delta) {
          // Consume the pending break, topping up to exactly one blank line so the two text runs render as separate paragraphs.
          // @see #262
          const emitted = (toolRanSinceText ? paragraphBreakFor(assistantContent) : '') + delta;
          toolRanSinceText = false;
          assistantContent += emitted;
          sendEvent('delta', { content: emitted });
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

    // A tool-only turn emits a short confirmation as a normal `delta`; an errored turn returned already and is never confirmed.
    // @see #195
    if (!assistantContent.trim()) {
      const confirmation = confirmationForToolResults(toolResults);
      if (confirmation) {
        assistantContent = confirmation;
        sendEvent('delta', { content: confirmation });
      }
    }

    // Save assistant message. An empty stream still persists content: '' (fail-visibility); ZDR turns save nothing.
    // @see #4 #116
    const sourceTitleList = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));
    if (zdr) {
      // Reconciled tool summaries are deliberately not attached to ZDR `done` payloads — nothing is written; live 'tool' frames still stream.
      // @see #196
      if (!isTriviallyNeutral(content) && assistantContent) {
        // Suggestions are still generated and delivered without ever being written anywhere.
        const suggestions = await generateFollowups(content, assistantContent);
        sendEvent('done', {
          complete: true,
          message: {
            role: 'assistant',
            content: assistantContent,
            modelName: routingResult.model,
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
      ...(usage ? { usage } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitleList.length > 0 ? { sourceTitles: sourceTitleList } : {}),
      // Persist the reconciled tool summaries so chips survive a refresh.
      // @see #196
      ...(toolEvents.length > 0 ? { tools: toolEvents } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();
    void maybeReviseSubtitle(String(session!._id));

    // The notification landed with this persisted turn — mark drained tasks notified now; a marking failure is swallowed (at-least-once).
    // @see #255
    await markNotified(streamTaskIds).catch((err) =>
      console.error('Task mark-notified error:', redactForLog(err)),
    );

    // Follow-up suggestions from the cheap model; skipped for trivially neutral prompts and empty turns so the 'trivial' skip gate stays consistent.
    // @see #33
    if (!isTriviallyNeutral(content) && assistantContent) {
      const suggestions = await generateFollowups(content, assistantContent, String(session!._id));
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
    // A ZDR turn failing before or during streaming still erases its throwaway attachment; no-op for durable assets.
    // @see #116
    await cleanupEphemeralAsset(attachedAsset);
    if (!res.headersSent) {
      // Every model cooled off before the stream opened → the friendly message is the primary text; the client surfaces it on 503.
      // @see #168
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

// Rename a chat: the title is user-owned from the first rename on (`titleSource: 'user'`) — no auto-overwrite once touched.
// @see #359
router.patch('/sessions/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 120) {
      return res.status(400).json({ message: 'Title must be 1-120 characters' });
    }
    const session = await Session.findOneAndUpdate(
      { _id: req.params.id, userId: req.user?.id, deletedAt: null },
      { title, titleSource: 'user' },
      { new: true },
    );
    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }
    res.json(session);
  } catch (_err) {
    res.status(500).json({ message: 'Error renaming session' });
  }
});

// Get all sessions for user
router.get('/sessions', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    // Order by most recent message; null lastMessageAt sorts last, createdAt breaks ties.
    // @see #226
    const sessions = await Session.find({ userId, deletedAt: null }).sort({
      lastMessageAt: -1,
      createdAt: -1,
    });
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
