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
  raceChatCompletion,
  raceChatStream,
  chatRoute,
  type FixedRoutingResult,
} from '../services/chatRace';
import { contextLengthFor, CHAT_MODEL } from '../services/modelDefaults';
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
import {
  classifyAssistantTurn,
  reviewAssistantTurn,
  type HonestyVerdict,
} from '../services/honestyGuardService';
import { zdrHistorySchema } from '../validation';
import { redactForLog } from '../services/logRedaction';
import { decideTurn } from '../services/zdrTurn';
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

// Attached-asset resolution: 'none'/'invalid'/'missing' verdicts.
// @see #34
// Pixel-carrying turns; mirrors buildImageTurn so routing agrees.
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

// File text rides the attachment envelope; the message stays raw text.
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
      // Markdown conversion is the fallback when no fast path exists.
      // @see #67
      textExtracted: asset.textExtracted ?? asset.markdownExtracted ?? null,
    });
  }
};

// Images become content parts via presigned GET; envelope skipped.
// @see #115
const buildImageTurn = async (
  messages: { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[],
  asset: AssetDoc,
): Promise<boolean> => {
  // `ready` matters: a pending upload would 404 the model's fetch.
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

// Collect web_search URLs, deduped; titles kept for the sources block.
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

/* Bookkeeping tools: a turn whose only tool was one gets no confirmation. */
// @see #195 #360
const NON_CONFIRMING_TOOLS = new Set(['current_datetime', 'search_tools']);

// Tool-only turns get a derived confirmation; a real answer always wins.
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

/* 413/prompt-size failures are actionable: say so, not the generic text. */
// @see #77
export const streamingErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (statusCode === 413 || /Request too large/.test(message)) {
    return (
      'Request too large for this deployment’s current rate limit — connected connectors ' +
      'may have added many tools to the request. Try again shortly or disconnect some in /connectors.'
    );
  }
  /* A 429 is actionable — surface a retry suggestion. */
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

// Chip counts: per-tool semantics, not a count-every-array heuristic.
// @see #114
const singleArrayFieldLength = (result: unknown): number | null => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const arrayFields = Object.values(result).filter((value) => Array.isArray(value));
  return arrayFields.length === 1 ? (arrayFields[0] as unknown[]).length : null;
};

type ToolCallEvent = ReturnType<typeof toolCallEvent>;
type ToolResultEvent = ReturnType<typeof toolResultEvent>;

// Unresolved calls stay phase 'call'; resolved ones carry the result.
// @see #196
export type PersistedToolEvent = (ToolCallEvent | ToolResultEvent) & { query?: string };

/* Merge a result into the latest unresolved like-named call; else append. */
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

/* Paragraph-break separator: cap at one blank line after a tool use. */
// @see #262
export const paragraphBreakFor = (contentEnding: string): string => {
  const trailingNewlines = contentEnding.match(/\n*$/)?.[0].length ?? 0;
  return '\n\n'.slice(Math.min(trailingNewlines, 2));
};

// Shared with the task sequencer so both paths build identical chips.
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

// Indices count only prior messages (pre-.save), first message is 0.
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

/* Subtitle is soft and revisable: fire-and-forget after the assistant save. */
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

/* ZDR: the routes keep nothing; continuity is the client's replay. */
// @see #116
const buildZdrMessages = (
  history: { role: 'user' | 'assistant'; content: string }[],
  content: string,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] => [
  ...history,
  { role: 'user', content },
];

/* Newest-first docs; timestamps on user turns, provenance on assistant. */
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

/* Imitation guard: the provenance line must never enter model output. */
// @see #261 #315 #360
export const stripProvenanceLines = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !/^\s*\[tools used: [^\]]*\]\s*$/.test(line))
    .join('\n')
    .trimEnd();

/* Retry note for a flagged prior attempt: not persisted, never shown. */
// @see #371
export const HONESTY_CORRECTION_NOTE =
  '\n\n[Note: your previous reply described tool results that were never executed — no tools ran in that turn. If this task needs tools, call them for real; otherwise state plainly that you have not run anything.]';

/* Retry note: the flagged attempt was discarded, so answer fresh. */
// @see #381
export const HONESTY_RETRY_NOTE =
  '\n\n[Note: an earlier attempt at this reply was discarded before the user saw any of it — it described tool results that were never executed. The user knows nothing about that attempt: do not apologize for it or refer to it. Answer the request fresh — if it needs tools, actually call them; otherwise state plainly that you have not run anything.]';

/* Appends the retry note to the turn's newest user message. */
// @see #381
export const appendHonestyRetryNote = (
  messages: { role: string; content: string | MessageContentPart[] }[],
): void => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') m.content += HONESTY_RETRY_NOTE;
    else m.content = [...m.content, { type: 'text', text: HONESTY_RETRY_NOTE }];
    return;
  }
};

export const messagesFromPersistedHistory = (
  history: {
    role: string;
    content: string;
    timestamp?: Date;
    tools?: { phase?: string; name?: string }[];
    honesty?: { flagged?: boolean | null } | null;
  }[],
  timezone?: string | null,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] => {
  // Newest assistant only: older flags had their correction chance.
  // @see #371
  const flaggedNewest = history.find((m) => m.role === 'assistant')?.honesty?.flagged === true;
  return history.reverse().map((m, i, arr) => {
    const header =
      m.role === 'user' && m.timestamp
        ? `${timestampHeader(m.timestamp, history[i - 1]?.timestamp, timezone)}\n`
        : '';
    const provenance = m.role === 'assistant' ? toolProvenanceLine(m.tools) : '';
    // The correction rides on the newest user message: this turn.
    const correction =
      flaggedNewest && m.role === 'user' && i === arr.length - 1 ? HONESTY_CORRECTION_NOTE : '';
    return {
      role: m.role as 'user' | 'assistant',
      content: header + (m.content as string) + provenance + correction,
    };
  });
};

/* Newest-kept window for 1M-token rosters; failover bounds outliers. */
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

// Throwaway attachments: row and object go once consumed; safe cleanup.
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

// Persist the user turn with metrics; neutral prompts record 'trivial'.
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

  // Record last-message time for sidebar order; awaited to avoid lag.
  // @see #226
  await Session.updateOne({ _id: sessionId }, { $set: { lastMessageAt: userMessage.timestamp } });

  // Embed the saved turn for retrieval: fire-and-forget, flag-gated.
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

/* Workspace read: unconditional on text turns, never throws, self-excluded. */
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

/* Drain completed tasks into context; marked notified only after persist. */
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
  // Outside try so the catch can erase a throwaway attachment.
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

    // Abort the provider call if the client disconnects pre-response.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    /* Retention shape: reject / replay / persist, one decision. */
    // @see #144 #116
    const accountIncognito = Boolean(userDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito cannot continue a saved chat: reject before reads.
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
      // ZDR: nothing is written; continuity is the replayed history.
      // @see #116
      const zdrHistory = parseZdrHistory(req.body.history);
      if (!zdrHistory.ok) {
        // The turn is rejected pre-consumption; nothing outlives it.
        // @see #116
        await cleanupIfEphemeral();
        return res.status(400).json({ message: 'Invalid chat history' });
      }
      await ensureUserLocation(userDoc, req.ip);
      /* ZDR turns may read the workspace but never write. */
      // @see #253
      const zdrWorkspaceBlock = await workspaceBlockFor(content, userId as string);

      /* ZDR continuity is the client replay; prompt assembled once. */
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
      // ZDR turns never carry image parts; the race picks the provider.
      const raced = await raceChatCompletion({
        messages: zdrMessages(),
        userId,
        abortSignal: abortController.signal,
      });
      const routingResult: FixedRoutingResult = raced.routing;
      const chatCompletion = raced.completion;
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

    // SessionId paths are loaded above; new chats are never incognito.
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

    // Image turns route vision-first only when storage is configured.
    // @see #115
    const hasImage = turnsWithImage(attachedAsset);

    // History window includes the saved turn; reversed to oldest-first.
    // @see #360
    const history = windowedHistory(
      await Message.find({ sessionId: session._id })
        .sort({ timestamp: -1 })
        .limit(HISTORY_MAX_MESSAGES),
    );
    // Geolocation awaited so the prompt can include the country.
    // @see #50
    await ensureUserLocation(userDoc, req.ip);
    /* Workspace block retrieved unconditionally; image turns skip it. */
    // @see #253 #310
    const workspaceBlock = await workspaceBlockFor(content, userId as string, {
      skipWorkspace: hasImage,
      excludeMessageId: String(userMessage._id),
      excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
    });
    // Retrieval outcome rides trace metadata for the admin Traces tab.
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
          honesty?: { flagged?: boolean | null } | null;
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

    /* Fixed model, hedged across its known backends. */
    // @see #387
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
    const raced = await raceChatCompletion({
      messages: turnMessages,
      max_tokens: outputTokensFor(contextLengthFor(CHAT_MODEL), promptCharsFrom(turnMessages)),
      userId,
      abortSignal: abortController.signal,
      // Tool-execution session so generate_file can stamp provenance.
      // @see #252
      sessionId: String(session!._id),
      trace: { sessionId: String(session!._id), metadata: workspaceMetadata },
    });
    const routingResult: FixedRoutingResult = raced.routing;
    const chatCompletion = raced.completion;

    // Empty responses persist as '' (fail-visibility); UI shows a hint.
    // @see #4
    const rawAssistantContent = chatCompletion.choices[0]?.message?.content ?? '';
    const toolResults = chatCompletion.toolResults ?? [];
    // Tool-only turns end with a synthesized confirmation, not silence.
    // @see #195 #360
    const assistantContent = stripProvenanceLines(
      rawAssistantContent.trim()
        ? rawAssistantContent
        : (confirmationForToolResults(toolResults) ?? rawAssistantContent),
    );

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

    // Honesty guard: fire-and-forget; zero tools + claim shape = flagged.
    // @see #371
    if (assistantContent.trim() && toolEvents.length === 0) {
      void reviewAssistantTurn(
        String(assistantMessage._id),
        assistantContent,
        [],
        String(session!._id),
      );
    }

    // Mark drained tasks notified; failures are swallowed (at-least-once).
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
    // ZDR failures still erase throwaway attachments; no-op otherwise.
    // @see #116
    await cleanupEphemeralAsset(attachedAsset);
    res.status(500).json({
      message: 'Error processing chat',
      detail: streamingErrorMessage(err),
    });
  }
});

// Chat streaming endpoint (SSE)
router.post('/stream', authenticate, async (req: AuthRequest, res) => {
  // Outside try so the catch can erase a throwaway attachment.
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
    /* Retention shape: stored flag for sessionId turns, intent otherwise. */
    // @see #144 #116
    const accountIncognito = Boolean(streamUserDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito cannot continue a saved chat: reject before reads.
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
      // ZDR: no session is created and saved chats cannot be continued.
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

    // Fixed model; the provider named here is the primary backend until the
    // race crowns the winner that actually serves the turn.
    // @see #387
    let routingResult: FixedRoutingResult = chatRoute();
    let messages: {
      role: 'system' | 'user' | 'assistant';
      content: string | MessageContentPart[];
    }[];

    // Image turns: gate on content type AND a configured presign path.
    // @see #115
    const hasImage = turnsWithImage(attachedAsset);

    await ensureUserLocation(streamUserDoc, req.ip);
    /* Workspace block read unconditionally; ZDR read-only, images skip. */
    // @see #253 #310
    let streamWorkspaceBlock = '';
    // Drained tasks ride the persisted turn; notified once the save lands.
    // @see #255
    let streamTaskBlock = '';
    let streamTaskIds: TaskDocument['_id'][] = [];
    if (zdr) {
      // Continuity comes from the client replay; nothing is read back.
      // @see #116
      messages = buildZdrMessages(zdrHistory, content);
      streamWorkspaceBlock = await workspaceBlockFor(content, userId as string);
    } else {
      // Save user message
      const userMessage = await saveUserMessageWithMetrics(
        userId as string,
        String(session!._id),
        content,
        attachedAsset,
      );

      // History window includes the saved turn; reversed to oldest-first.
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
      messages = messagesFromPersistedHistory(
        history as {
          role: string;
          content: string;
          timestamp?: Date;
          tools?: { phase?: string; name?: string }[];
          honesty?: { flagged?: boolean | null } | null;
        }[],
        streamUserDoc.settings?.timezone,
      );
    }

    messages.unshift({
      role: 'system',
      // Persisted turns carry per-message timestamps; ZDR keeps the date.
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

    // Every executed tool in order, so a text-less turn can confirm.
    // @see #195
    const toolResults: { name: string; result: unknown }[] = [];

    // Reconciled tool events: the persisted companion of the 'done' msg.
    // @see #196
    const toolEvents: PersistedToolEvent[] = [];

    // Token usage, surfaced by the connector as one trailing chunk.
    // @see #224
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    // Abort on client disconnect; 'close' also fires after normal end.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    // Attempt state resets between retries so nothing leaks across.
    // @see #381
    const resetAttemptState = () => {
      assistantContent = '';
      sources = [];
      titles.clear();
      toolResults.length = 0;
      toolEvents.length = 0;
      usage = undefined;
    };

    /* Honesty auto-retry: one restart; a flagged attempt is wiped. */
    // @see #381
    const HONESTY_MAX_ATTEMPTS = 2;
    let attempt = 0;
    let honestyVerdict: HonestyVerdict | null = null;

    try {
      while (true) {
        attempt += 1;
        if (attempt > 1) {
          resetAttemptState();
          sendEvent('honesty', {
            flagged: true,
            reason: honestyVerdict?.reason ?? null,
            retrying: true,
          });
          appendHonestyRetryNote(messages);
        }
        sendEvent('meta', {
          // ZDR: no sessionId is minted; nothing to point at.
          // @see #116
          ...(zdr ? {} : { sessionId: session!._id }),
          routing: routingResult,
        });

        /* Hedged race keeps the first token's stream; TTFT rides the reason. */
        // @see #387
        const raced = await raceChatStream({
          messages,
          // Budget sized against the fixed model's window.
          // @see #104
          max_tokens: outputTokensFor(contextLengthFor(CHAT_MODEL), promptCharsFrom(messages)),
          userId,
          abortSignal: abortController.signal,
          // Attach the session to the trace; ZDR turns have none.
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
          // The tool session rides outside the trace guard (no ZDR row).
          // @see #252
          ...(zdr ? {} : { sessionId: String(session!._id) }),
        });
        routingResult = raced.routing;
        const stream = raced.stream;

        /* Tool between text runs: render as a paragraph break. */
        // @see #262
        let toolRanSinceText = false;
        for await (const chunk of stream) {
          // Capture the trailing usage chunk without forwarding it.
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
          // Arm the break on a tool chunk after streamed text.
          if ((chunk.toolCall || chunk.toolResult) && assistantContent.length > 0) {
            toolRanSinceText = true;
          }
          const delta = chunk.delta;
          if (delta) {
            // Top up to exactly one blank line between text runs.
            // @see #262
            const emitted = (toolRanSinceText ? paragraphBreakFor(assistantContent) : '') + delta;
            toolRanSinceText = false;
            assistantContent += emitted;
            sendEvent('delta', { content: emitted });
          }
        }

        // Tool-only turns emit a confirmation delta; errored turns don't.
        // @see #195
        if (!assistantContent.trim()) {
          const confirmation = confirmationForToolResults(toolResults);
          if (confirmation) {
            assistantContent = confirmation;
            sendEvent('delta', { content: confirmation });
          }
        }
        // Provenance markers scrubbed pre-persist; history stays clean.
        // @see #360
        assistantContent = stripProvenanceLines(assistantContent);

        if (zdr) break;

        // Guard pre-persist: flagged mid attempts restart before `done`.
        // @see #371 #381
        if (assistantContent.trim() && toolEvents.length === 0) {
          honestyVerdict = await classifyAssistantTurn(assistantContent, [], String(session!._id));
          if (honestyVerdict?.flagged && attempt < HONESTY_MAX_ATTEMPTS) continue;
        } else {
          honestyVerdict = null;
        }
        break;
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

    // Empty streams persist '' (fail-visibility); ZDR saves nothing.
    // @see #4 #116
    const sourceTitleList = sources
      .filter((url) => titles.has(url))
      .map((url) => ({ url, title: titles.get(url) as string }));
    if (zdr) {
      // ZDR `done` payloads carry no tool summaries; nothing written.
      // @see #196
      if (!isTriviallyNeutral(content) && assistantContent) {
        // Suggestions are generated and delivered, never written.
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
      // The in-loop verdict lands in the same save as the turn.
      // @see #381
      ...(honestyVerdict
        ? {
            honesty: {
              flagged: honestyVerdict.flagged,
              reason: honestyVerdict.reason,
              checkedAt: new Date(),
            },
          }
        : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();
    void maybeReviseSubtitle(String(session!._id));

    // Mark drained tasks notified; failures are swallowed (at-least-once).
    // @see #255
    await markNotified(streamTaskIds).catch((err) =>
      console.error('Task mark-notified error:', redactForLog(err)),
    );

    // Suggestions from the cheap model; skipped for trivial turns.
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

    // Only an exhausted retry reaches the user as a flag.
    // @see #371 #381
    if (honestyVerdict?.flagged) {
      sendEvent('honesty', { flagged: true, reason: honestyVerdict.reason });
    }
    res.end();
  } catch (err) {
    console.error('Chat stream error:', redactForLog(err));
    // ZDR stream failures still erase throwaway attachments.
    // @see #116
    await cleanupEphemeralAsset(attachedAsset);
    if (!res.headersSent) {
      res.status(500).json({
        message: 'Error processing chat',
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

// Rename: the title is user-owned from the first rename on.
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
    // Order by last message; null sorts last, createdAt breaks ties.
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
