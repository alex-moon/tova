import { isValidObjectId } from 'mongoose';
import express from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Session } from '../models/Session';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { Asset } from '../models/Asset';
import { buildAttachmentEnvelope } from '../services/attachmentEnvelope';
import { isImageContentType } from '../services/asset/assetLimits';
import { spacesWorkspaceStorage } from '../services/workspace/workspaceStorage';
import {
  raceChatCompletion,
  raceChatStream,
  chatRoute,
  type FixedRoutingResult,
} from '../services/chatRace';
import { contextLengthFor, CHAT_MODEL } from '../services/model/modelDefaults';
import { generateChatTitle } from '../services/titleService';
import { reviseSessionSubtitle, type SubtitleTurn } from '../services/subtitleService';
import { hasPermission, ROUTING_PERMISSION } from '../services/userService';
import { buildSystemContent, timestampHeader } from '../services/promptAssembly';
import { ensureUserLocation } from '../services/geoLocationService';
import { outputTokensFor, promptCharsFrom } from '../services/outputTokenCap';
import type { MessageContentPart } from '../services/llmTypes';
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
import {
  reconcileToolEvent,
  toolCallEvent,
  toolResultEvent,
  type PersistedToolEvent,
} from '../services/toolChips';
export {
  reconcileToolEvent,
  toolResultEvent,
  type PersistedToolEvent,
} from '../services/toolChips';
import { decideTurn } from '../services/zdrTurn';
import { workspaceGateFrom, workspaceTraceMetadata } from '../services/workspaceTraceFacts';
import {
  isWorkspaceMemoryEnabled,
  retrieveWorkspaceBlock,
} from '../services/workspace/workspaceRetrievalService';
import { enqueueWorkspaceEmbedding } from '../services/workspace/workspaceEmbeddingIngest';
import { TaskEvent } from '../models/TaskEvent';
import type { TaskDocument } from '../models/Task';
import {
  completionNotificationLine,
  markNotified,
  pendingCompletionsFor,
} from '../services/task/taskNotificationService';

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
  // Guard the content union: only a raw-text turn takes the envelope.
  // @see #391
  if (asset && last?.role === 'user' && typeof last.content === 'string') {
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

// Provider-neutral tool outcome summaries for the SSE 'tool' events live in
// services/toolChips (shared with the task sequencer). @see #33 #398

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

/* Paragraph-break separator: cap at one blank line after a tool use. */
// @see #262
export const paragraphBreakFor = (contentEnding: string): string => {
  const trailingNewlines = contentEnding.match(/\n*$/)?.[0].length ?? 0;
  return '\n\n'.slice(Math.min(trailingNewlines, 2));
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
  const [newest, ...rest] = docs;
  if (!newest) return [];
  // The current turn always rides: truncated when it alone busts the budget.
  // @see #391
  const newestContent = newest.content ?? '';
  const kept: T[] =
    newestContent.length > HISTORY_MAX_CHARS
      ? [{ ...newest, content: newestContent.slice(0, HISTORY_MAX_CHARS) }]
      : [newest];
  let used = Math.min(newestContent.length, HISTORY_MAX_CHARS);
  for (const doc of rest) {
    used += (doc.content ?? '').length;
    if (used > HISTORY_MAX_CHARS) break;
    kept.push(doc);
  }
  return kept.slice(0, HISTORY_MAX_MESSAGES);
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

type TurnMessages = {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}[];

/* SSE keep-alive: proxies time out silently between headers and first token. */
// @see #391
const SSE_PING_MS = 15_000;

// Sources paired with their titles when the search returned them.
// @see #16 #33
const sourceTitlesFrom = (sources: string[], titles: Map<string, string>) =>
  sources
    .filter((url) => titles.has(url))
    .map((url) => ({ url, title: titles.get(url) as string }));

/* Shared turn preamble: validate, resolve retention shape, parse ZDR history. */
// @see #391 #144 #116
const prepareTurn = async (req: AuthRequest) => {
  const { sessionId, content } = req.body;
  const userId = req.user?.id;

  if (!content) {
    return { ok: false as const, error: { status: 400, message: 'Content is required' } };
  }

  if (!(await hasPermission(userId as string, ROUTING_PERMISSION))) {
    return { ok: false as const, error: { status: 403, message: NO_ROUTING_PERMISSION } };
  }

  const attachResult = await loadAttachedAsset(req);
  if (attachResult === 'invalid') {
    return { ok: false as const, error: { status: 400, message: 'Invalid asset reference' } };
  }
  if (attachResult === 'missing') {
    return { ok: false as const, error: { status: 404, message: 'Asset not found' } };
  }
  const attachedAsset = attachResult;

  try {
    const userDoc = await User.findById(userId);
    if (!userDoc) {
      return { ok: false as const, error: { status: 404, message: 'User not found' } };
    }

    /* Retention shape: stored flag for sessionId turns, intent otherwise. */
    // @see #144 #116
    const accountIncognito = Boolean(userDoc.settings?.zdr);
    const bodyIntent: boolean | undefined =
      typeof req.body.zdr === 'boolean' ? req.body.zdr : undefined;
    let session;
    let turnDecision: ReturnType<typeof decideTurn>;
    if (sessionId) {
      if (accountIncognito) {
        // Incognito cannot continue a saved chat: reject before reads.
        // @see #116 #144
        turnDecision = decideTurn({ incognito: true, sessionId });
      } else {
        if (!isValidObjectId(sessionId)) {
          await cleanupEphemeralAsset(attachedAsset);
          return { ok: false as const, error: { status: 400, message: 'Invalid session id' } };
        }
        session = await Session.findOne({ _id: sessionId, userId, deletedAt: null });
        if (!session) {
          return { ok: false as const, error: { status: 404, message: 'Session not found' } };
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
      return {
        ok: false as const,
        error: {
          status: 409,
          message:
            'Zero-data-retention is on — new turns are never stored, so they cannot continue a saved chat. Start a new chat instead.',
        },
      };
    }
    // Narrow once: the cleanup closure reads the fields as consts.
    const { persistWithHistoryReplay, requireEphemeralCleanup } = turnDecision;
    const cleanupIfEphemeral = async () => {
      if (!requireEphemeralCleanup) return;
      await cleanupEphemeralAsset(attachedAsset);
    };

    let zdrHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    if (persistWithHistoryReplay) {
      // ZDR: nothing is written; continuity is the replayed history.
      // @see #116
      const parsedHistory = parseZdrHistory(req.body.history);
      if (!parsedHistory.ok) {
        // The turn is rejected pre-consumption; nothing outlives it.
        // @see #116
        await cleanupIfEphemeral();
        return { ok: false as const, error: { status: 400, message: 'Invalid chat history' } };
      }
      zdrHistory = parsedHistory.value;
    }

    return {
      ok: true as const,
      userDoc,
      attachedAsset,
      session: session ?? null,
      turnDecision,
      zdrHistory,
      cleanupIfEphemeral,
    };
  } catch (err) {
    // A throw after asset adoption must still erase a throwaway attachment.
    // @see #116
    await cleanupEphemeralAsset(attachedAsset);
    throw err;
  }
};

type PreparedTurn = Extract<Awaited<ReturnType<typeof prepareTurn>>, { ok: true }>;

/* ZDR prompt: client-replayed history, system block, asset; nothing persisted. */
// @see #116 #391
const buildZdrTurnPrompt = async (
  prepared: PreparedTurn,
  userId: string,
  ip: string | undefined,
  content: string,
): Promise<TurnMessages> => {
  // Geolocation awaited so the prompt can include the country.
  // @see #50
  await ensureUserLocation(prepared.userDoc, ip);
  /* ZDR turns may read the workspace but never write. */
  // @see #253
  const workspaceBlock = await workspaceBlockFor(content, userId);
  const messages = buildZdrMessages(prepared.zdrHistory, content);
  messages.unshift({
    role: 'system',
    // ZDR keeps the bare date line as its only clock.
    // @see #261
    content: buildSystemContent(
      prepared.userDoc,
      true,
      prepared.userDoc.settings?.timezone,
      workspaceBlock,
    ),
  });
  if (prepared.attachedAsset) {
    const imageAttached = turnsWithImage(prepared.attachedAsset)
      ? await buildImageTurn(messages, prepared.attachedAsset)
      : false;
    if (!imageAttached) appendAssetBlock(messages, prepared.attachedAsset);
  }
  return messages;
};

/* Persisted-turn prompt: save the user turn, window history, assemble. */
// @see #360 #253 #255 #391
const buildPersistedTurnPrompt = async (
  prepared: PreparedTurn,
  userId: string,
  ip: string | undefined,
  content: string,
) => {
  const { userDoc, attachedAsset } = prepared;
  let session = prepared.session;
  // SessionId paths are loaded in prepareTurn; new chats are never incognito.
  // @see #116
  if (!session) {
    session = await createSessionWithUser(userId, content, { incognito: false });
  }
  const sessionId = String(session._id);
  const userMessage = await saveUserMessageWithMetrics(userId, sessionId, content, attachedAsset);

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
  await ensureUserLocation(userDoc, ip);
  /* Workspace block retrieved unconditionally; image turns skip it. */
  // @see #253 #310
  const workspaceBlock = await workspaceBlockFor(content, userId, {
    skipWorkspace: hasImage,
    excludeMessageId: String(userMessage._id),
    excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
  });
  // Drain completed origin tasks (queued write) into this turn.
  // @see #255
  const taskCompletion = await taskCompletionBlockFor(userId, sessionId);

  const messages = messagesFromPersistedHistory(
    history as {
      role: string;
      content: string;
      timestamp?: Date;
      tools?: { phase?: string; name?: string }[];
      honesty?: { flagged?: boolean | null } | null;
    }[],
    userDoc.settings?.timezone,
  );
  messages.unshift({
    role: 'system',
    // Persisted turns carry per-message timestamps.
    // @see #261
    content: buildSystemContent(
      userDoc,
      false,
      userDoc.settings?.timezone,
      workspaceBlock,
      taskCompletion.block,
    ),
  });
  if (attachedAsset) {
    const imageAttached = hasImage ? await buildImageTurn(messages, attachedAsset) : false;
    if (!imageAttached) appendAssetBlock(messages, attachedAsset);
  }
  return {
    sessionId,
    messages,
    taskIds: taskCompletion.taskIds,
    // Retrieval outcome rides trace metadata for the admin Traces tab.
    // @see #308
    trace: {
      sessionId,
      metadata: workspaceTraceMetadata(workspaceGateFrom(workspaceBlock, hasImage), workspaceBlock),
    },
  };
};

/* Shared assistant save: metrics, task notification, subtitle revision. */
// @see #196 #255 #359 #391
const persistAssistantTurn = async (input: {
  sessionId: string;
  content: string;
  routing: FixedRoutingResult;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  sources: string[];
  sourceTitles: { url: string; title: string }[];
  toolEvents: PersistedToolEvent[];
  honesty?: Pick<HonestyVerdict, 'flagged' | 'reason'> | null;
  taskIds: TaskDocument['_id'][];
}) => {
  const assistantMessage = new Message({
    sessionId: input.sessionId,
    role: 'assistant',
    content: input.content,
    modelName: input.routing.model,
    provider: input.routing.provider,
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.sources.length > 0 ? { sources: input.sources } : {}),
    ...(input.sourceTitles.length > 0 ? { sourceTitles: input.sourceTitles } : {}),
    // Persist the reconciled tool summaries so chips survive a refresh.
    // @see #196
    ...(input.toolEvents.length > 0 ? { tools: input.toolEvents } : {}),
    // The in-loop verdict lands in the same save as the turn.
    // @see #381
    ...(input.honesty ? { honesty: { ...input.honesty, checkedAt: new Date() } } : {}),
    metrics: await buildMessageMetrics(input.sessionId, input.content),
  });
  await assistantMessage.save();

  // Mark drained tasks notified; failures are swallowed (at-least-once).
  // @see #255
  await markNotified(input.taskIds).catch((err) =>
    console.error('Task mark-notified error:', redactForLog(err)),
  );
  void maybeReviseSubtitle(input.sessionId);
  return assistantMessage;
};

// Chat endpoint (non-streaming, preserved for compatibility)
router.post('/', authenticate, async (req: AuthRequest, res) => {
  // Outside try so the catch can erase a throwaway attachment.
  // @see #116
  let attachedAsset: AssetDoc | null = null;
  try {
    const { content } = req.body;
    const userId = req.user?.id;

    const prepared = await prepareTurn(req);
    if (!prepared.ok) {
      return res.status(prepared.error.status).json({ message: prepared.error.message });
    }
    attachedAsset = prepared.attachedAsset;
    const { cleanupIfEphemeral } = prepared;

    // Abort the provider call if the client disconnects pre-response.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    if (prepared.turnDecision.persistWithHistoryReplay) {
      // ZDR: nothing is written; continuity is the replayed history.
      // @see #116
      const messages = await buildZdrTurnPrompt(prepared, userId as string, req.ip, content);
      const raced = await raceChatCompletion({
        messages,
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

    // Fixed model, hedged across its known backends.
    // @see #387
    const built = await buildPersistedTurnPrompt(prepared, userId as string, req.ip, content);
    const raced = await raceChatCompletion({
      messages: built.messages,
      max_tokens: outputTokensFor(contextLengthFor(CHAT_MODEL), promptCharsFrom(built.messages)),
      userId,
      abortSignal: abortController.signal,
      // Tool-execution session so generate_file can stamp provenance.
      // @see #252
      sessionId: built.sessionId,
      trace: built.trace,
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
    const sourceTitles = sourceTitlesFrom(sources, titles);

    // Reconciled tool chips for the persisted turn.
    // @see #196 #360
    const toolEvents: PersistedToolEvent[] = [];
    for (const r of toolResults) reconcileToolEvent(toolEvents, toolResultEvent(r));

    // Save assistant message
    const assistantMessage = await persistAssistantTurn({
      sessionId: built.sessionId,
      content: assistantContent,
      routing: routingResult,
      usage: chatCompletion.usage,
      sources,
      sourceTitles,
      toolEvents,
      taskIds: built.taskIds,
    });

    // Honesty guard: fire-and-forget; zero tools + claim shape = flagged.
    // @see #371
    if (assistantContent.trim() && toolEvents.length === 0) {
      void reviewAssistantTurn(String(assistantMessage._id), assistantContent, [], built.sessionId);
    }

    res.json({
      sessionId: built.sessionId,
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
    const { content } = req.body;
    const userId = req.user?.id;

    const prepared = await prepareTurn(req);
    if (!prepared.ok) {
      return res.status(prepared.error.status).json({ message: prepared.error.message });
    }
    attachedAsset = prepared.attachedAsset;
    const zdr = prepared.turnDecision.persistWithHistoryReplay;

    let routingResult: FixedRoutingResult = chatRoute();
    let messages: TurnMessages;
    // Drained tasks ride the persisted turn; notified once the save lands.
    // @see #255
    let streamTaskIds: TaskDocument['_id'][] = [];
    let streamSessionId: string | undefined;
    let streamTrace: { sessionId: string; metadata: Record<string, unknown> } | undefined;
    if (zdr) {
      // Continuity comes from the client replay; nothing is read back.
      // @see #116
      messages = await buildZdrTurnPrompt(prepared, userId as string, req.ip, content);
    } else {
      const built = await buildPersistedTurnPrompt(prepared, userId as string, req.ip, content);
      messages = built.messages;
      streamSessionId = built.sessionId;
      streamTaskIds = built.taskIds;
      streamTrace = built.trace;
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

        // Keep-alive while the race runs: proxies time out silently otherwise.
        // @see #391
        const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
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
          ...(zdr ? {} : { trace: streamTrace }),
          // The tool session rides outside the trace guard (no ZDR row).
          // @see #252
          ...(zdr ? {} : { sessionId: streamSessionId }),
        }).finally(() => clearInterval(ping));
        routingResult = raced.routing;
        // Meta follows the race: name the backend that serves the turn.
        // @see #391
        sendEvent('meta', {
          // ZDR: no sessionId is minted; nothing to point at.
          // @see #116
          ...(zdr ? {} : { sessionId: streamSessionId }),
          routing: routingResult,
        });
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
          honestyVerdict = await classifyAssistantTurn(
            assistantContent,
            [],
            streamSessionId as string,
          );
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
      // The user turn is already persisted: failed turns still adopt their
      // session, or a client retry mints a duplicate. @see #391
      if (streamSessionId) sendEvent('meta', { sessionId: streamSessionId });
      sendEvent('error', { message: streamingErrorMessage(err) });
      sendEvent('done', { complete: false });
      await cleanupEphemeralAsset(attachedAsset);
      res.end();
      return;
    }

    // Empty streams persist '' (fail-visibility); ZDR saves nothing.
    // @see #4 #116
    const sourceTitleList = sourceTitlesFrom(sources, titles);
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

    const assistantMessage = await persistAssistantTurn({
      sessionId: streamSessionId as string,
      content: assistantContent,
      routing: routingResult,
      usage,
      sources,
      sourceTitles: sourceTitleList,
      toolEvents,
      honesty: honestyVerdict
        ? { flagged: honestyVerdict.flagged, reason: honestyVerdict.reason }
        : null,
      taskIds: streamTaskIds,
    });

    // Suggestions from the cheap model; skipped for trivial turns.
    // @see #33
    if (!isTriviallyNeutral(content) && assistantContent) {
      const suggestions = await generateFollowups(
        content,
        assistantContent,
        streamSessionId as string,
      );
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
    // Malformed ids are a 404, never a CastError 500. @see #396
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Session not found' });
    }
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Session not found' });
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Session not found' });
    }
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
