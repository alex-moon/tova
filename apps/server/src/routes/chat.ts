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

/*
 * Paragraph-break separator (#262): when text resumes after a tool use, the
 * gap between the two text runs must render as a paragraph break. Top the
 * already-streamed content up to exactly one blank line — nothing when it
 * already ends in one, a single `\n` when it ends in a lone newline, else a
 * full `\n\n`. Pure so the boundary cases are unit-testable.
 */
export const paragraphBreakFor = (contentEnding: string): string => {
  const trailingNewlines = contentEnding.match(/\n*$/)?.[0].length ?? 0;
  return '\n\n'.slice(Math.min(trailingNewlines, 2));
};

// Exported (#254) so the task sequencer builds the same #196 tool chips the
// chat path persists — one chip vocabulary for both streams. The optional
// `args` lets a caller that has only the executed result (the non-streaming
// sequencer step, which never sees a separate `toolCall` event) recover the
// call's `query`, exactly as `toolCallEvent` derives it from a call's args.
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

// Session indices count only prior messages (computed before .save()), so a
// session's first message gets index 0. Count-based indices are racy under
// concurrent turns in one session; accepted in the plan
// (docs/done/plan-17-prompt-metrics.md) since metrics are analytical.
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

/*
 * #261: every persisted turn is prefixed with a `[timestamp]` header so the
 * model can see when each turn happened and how long passed between them. The
 * header is emitted at prompt-assembly time from the stored `Message.timestamp`
 * (always UTC in the DB) and never persisted into `content` itself; `timezone`
 * only shapes the rendered stamp. The docs arrive newest-first (the caller's
 * `sort({ timestamp: -1 })`); after reversing them the previous turn's
 * timestamp is the one immediately before.
 */
const messagesFromPersistedHistory = (
  history: { role: string; content: string; timestamp?: Date }[],
  timezone?: string | null,
): { role: 'system' | 'user' | 'assistant'; content: string | MessageContentPart[] }[] =>
  history.reverse().map((m, i) => {
    const header = m.timestamp
      ? `${timestampHeader(m.timestamp, history[i - 1]?.timestamp, timezone)}\n`
      : '';
    return {
      role: m.role as 'user' | 'assistant',
      content: header + (m.content as string),
    };
  });

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
// fire-and-forget classification call back (docs/done/plan-17-prompt-metrics.md
// tasks 6 and 9). The gate is computed once and reused for both purposes.
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

  // #226: record the session's most recent message time so the session list
  // orders by activity, not creation. Using the message's own timestamp (not
  // `new Date()`) keeps the stored value consistent with the message it
  // represents. Awaited so the sidebar order cannot lag the turn.
  await Session.updateOne({ _id: sessionId }, { $set: { lastMessageAt: userMessage.timestamp } });

  // #294: embed the saved turn for semantic retrieval. Fire-and-forget and
  // gated by the workspace-memory flag inside the helper, so with memory off
  // this is a no-op (no provider call) and a failure never affects the turn.
  // This helper is only reached on non-ZDR paths, so incognito turns are never
  // embedded — asserted in chat.zdr.test.ts.
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

/*
 * #253: the workspace-memory read. #310 retired the aux gate — retrieval runs
 * unconditionally on every text turn that reaches here (the relevance bar is
 * #305's rerank-and-cut, not an aux vote). Never throws — memory must not
 * degrade a chat turn.
 *
 * `skipWorkspace` (image turns) suppresses the read entirely.
 *
 * `excludeMessageId` drops the just-saved current turn from the workspace
 * corpus (the routes run retrieval after persisting it, so without it the turn
 * could be retrieved and injected back as its own "past work").
 * `excludeAssetId` drops the current turn's attached file for the same reason:
 * it is not past work, and its text already rides the `<user_content>` envelope.
 */
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

/*
 * #255 (F4): read completed background tasks into this turn's context — the
 * chat route is the chat stream's only writer, so the worker never writes it
 * itself (single writer per stream). The notification is a *queued write*: it
 * waits for the next user turn and never lands mid-turn. The final answer is the
 * task's last non-empty assistant step.
 *
 * This function only *reads*: it returns the block to inject and the ids it
 * covered, but never marks them. The caller marks them via `markNotified` once
 * the turn's assistant message has actually persisted. Marking at read time
 * would consume a completion on a turn that then failed (provider error, abort,
 * geo block) — the user would never see it. Marking after persistence trades a
 * wider exactly-once race window (two concurrent turns on one session could both
 * surface the same task) for never losing a completion; a chat turn per session
 * is user-driven and single-flight on the client, so the loss bug is the one
 * worth avoiding.
 *
 * Returns an empty block when nothing is pending — the common case — so the turn
 * is byte-identical when no background work finished.
 */
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
      await ensureUserLocation(userDoc, req.ip);
      /*
       * #253: matching the streaming route and plan decision 6, a ZDR turn MAY
       * read the workspace (read-only) — it writes nothing, so it is absent from
       * the corpus by construction.
       */
      const zdrWorkspaceBlock = await workspaceBlockFor(content, userId as string);

      /*
       * ZDR continuity is the client replay; the prompt is assembled once and
       * raced (#232).
       */
      const zdrMessages = (): ReturnType<typeof buildZdrMessages> => {
        const turnMessages = buildZdrMessages(zdrHistory.value, content);
        turnMessages.unshift({
          role: 'system',
          content: buildSystemContent(userDoc, true, userDoc.settings?.timezone, zdrWorkspaceBlock),
        });
        appendAssetBlock(turnMessages, attachedAsset);
        return turnMessages;
      };
      // ZDR turns never carry image parts (no buildImageTurn on this path), so
      // image gating is moot: race the full text roster. An empty roster (no
      // model could be picked) is surfaced as the all-disabled error.
      const zdrPrePick = await pickRosterRoute(false);
      if (!zdrPrePick) throw new AllModelsDisabledError();
      const raced = await routeAndComplete(
        {
          messages: zdrMessages(),
          userId,
          abortSignal: abortController.signal,
        },
        false,
      );
      const routingResult: RosterRoutingResult = raced.routing;
      const chatCompletion = raced.outcome.result.completion;
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
      userId as string,
      String(session!._id),
      content,
      attachedAsset,
    );

    // Image turns (#115) route vision-first only when the
    // presign path is actually available; otherwise the turn degrades to the
    // legacy text envelope and normal routing applies.
    const hasImage = turnsWithImage(attachedAsset);

    // Get chat history for context — the window includes the just-saved
    // current turn, reversing to oldest-first for the prompt.
    const history = await Message.find({ sessionId: session._id })
      .sort({ timestamp: -1 })
      .limit(10);
    // Coarse geolocation (#50): awaited so this turn's prompt can include the
    // country; cheap when cached (fresh/cooldown returns immediately) and the
    // service itself never throws, so chat cannot block hard on it.
    await ensureUserLocation(userDoc, req.ip);
    /*
     * #253/#310: the workspace-memory block is retrieved unconditionally — no
     * aux vote. Image turns skip the read (text-only for memory).
     */
    const workspaceBlock = await workspaceBlockFor(content, userId as string, {
      skipWorkspace: hasImage,
      excludeMessageId: String(userMessage._id),
      excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
    });
    // #308: the retrieval outcome + hit count ride the main call's trace
    // metadata so the admin Traces tab can show them per turn.
    const workspaceMetadata = workspaceTraceMetadata(
      workspaceGateFrom(workspaceBlock, hasImage),
      workspaceBlock,
    );
    const withSystemAndAsset = async (systemContent: string) => {
      const next = messagesFromPersistedHistory(
        history as { role: string; content: string; timestamp?: Date }[],
        userDoc.settings?.timezone,
      );
      next.unshift({ role: 'system', content: systemContent });
      if (attachedAsset) {
        const imageAttached = hasImage ? await buildImageTurn(next, attachedAsset) : false;
        if (!imageAttached) appendAssetBlock(next, attachedAsset);
      }
      return next;
    };

    /*
     * #232: the turn races the fixed roster. Racing selects the model
     * internally, so the prompt is assembled once (#310: the workspace block is
     * retrieved unconditionally) and the budget is sized against the pre-race
     * pick's window. The winner re-shapes routing for persistence. An empty
     * roster (no model could be picked) is surfaced as the all-disabled error.
     */
    const rosterPrePick = await pickRosterRoute(hasImage);
    if (!rosterPrePick) throw new AllModelsDisabledError();
    // #255: completed background tasks ride this turn's context (queued write).
    // The ids are marked notified only after the assistant message persists, so
    // a failed turn does not consume the notification.
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
    const raced = await routeAndComplete(
      {
        messages: turnMessages,
        max_tokens: outputTokensFor(rosterPrePick.contextLength, promptCharsFrom(turnMessages)),
        userId,
        abortSignal: abortController.signal,
        // #252: tool-execution session (distinct from the trace) so
        // generate_file can stamp provenance on the file it produces.
        sessionId: String(session!._id),
        trace: { sessionId: String(session!._id), metadata: workspaceMetadata },
      },
      hasImage,
    );
    const routingResult: RosterRoutingResult = raced.routing;
    const chatCompletion = raced.outcome.result.completion;

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
      ...(chatCompletion.usage ? { usage: chatCompletion.usage } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(sourceTitles.length > 0 ? { sourceTitles } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();

    // #255 (F4): the completion notification has now landed in the chat stream
    // (this turn's assistant message persisted), so mark the drained tasks
    // notified. Doing it here, not at read time, means a turn that throws before
    // this point leaves the completion pending for the next turn. A failure to
    // mark is swallowed: the turn already succeeded, and an unmarked completion
    // simply re-surfaces next turn (at-least-once).
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

    let routingResult: RosterRoutingResult;
    let messages: {
      role: 'system' | 'user' | 'assistant';
      content: string | MessageContentPart[];
    }[];

    // Image turns (#115): gate on both the content type and a configured
    // presign path; the image part replaces the filename envelope this turn.
    const hasImage = turnsWithImage(attachedAsset);

    /*
     * #232: the primary model comes from the weighted roster pick (no guard
     * classifier). The actual race runs after the messages are assembled (the
     * race needs the full prompt); this pick only supplies the `contextLength`
     * for the output budget and the pre-race `meta` routing. An empty roster
     * (no model could be picked) is surfaced as the all-disabled error.
     */
    const rosterRoute = await pickRosterRoute(hasImage);
    if (!rosterRoute) throw new AllModelsDisabledError();

    await ensureUserLocation(streamUserDoc, req.ip);
    /*
     * #253/#310: the workspace-memory block is retrieved unconditionally — no
     * aux vote. ZDR turns may still READ the workspace (read-only, matching
     * plan task 8); they never write corpus items, so they are absent from the
     * corpus by construction. Image turns skip the read (text-only for memory).
     */
    let streamWorkspaceBlock = '';
    // #255 (F4): completed background tasks for this session, drained into the
    // persisted turn's context below (empty on ZDR — a ZDR turn cannot create a
    // task, D7, so it has nothing to drain). The ids are marked notified only
    // once the persisted assistant message lands, so a failed stream does not
    // consume the notification.
    let streamTaskBlock = '';
    let streamTaskIds: TaskDocument['_id'][] = [];
    if (zdr) {
      // Continuity comes from the client replay (#116); nothing is read back.
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

      // Get chat history — the window includes the just-saved current turn,
      // reversing to oldest-first for the prompt.
      const history = await Message.find({ sessionId: session!._id })
        .sort({ timestamp: -1 })
        .limit(10);

      streamWorkspaceBlock = await workspaceBlockFor(content, userId as string, {
        skipWorkspace: hasImage,
        excludeMessageId: String(userMessage._id),
        excludeAssetId: attachedAsset ? String(attachedAsset._id) : undefined,
      });
      // #255: drain completed origin tasks (queued write) into this turn.
      const streamTaskCompletion = await taskCompletionBlockFor(
        userId as string,
        String(session!._id),
      );
      streamTaskBlock = streamTaskCompletion.block;
      streamTaskIds = streamTaskCompletion.taskIds;

      // Same image-turn gating as the non-streaming route (#115).
      routingResult = rosterRoute;
      messages = messagesFromPersistedHistory(
        history as { role: string; content: string; timestamp?: Date }[],
        streamUserDoc.settings?.timezone,
      );
    }

    messages.unshift({
      role: 'system',
      // #261: persisted turns carry per-message timestamps (no date line); ZDR
      // turns are untimestamped and keep the date line as their only clock.
      // Either way the date line / stamps render in the user's local zone when
      // known (storage stays UTC).
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

    // #195: every executed tool of the turn, in order, so a turn that ends
    // with no assistant text can still be confirmed.
    const toolResults: { name: string; result: unknown }[] = [];

    // Reconciled tool events for this turn (#196). Raw SSE 'tool' frames keep
    // firing unchanged; this array is the deduped, persisted companion that
    // the 'done' message and a later refresh read from.
    const toolEvents: PersistedToolEvent[] = [];

    // #224: token usage for the turn, surfaced by the connector as a single
    // trailing `usage` chunk. Absent when the provider reported nothing.
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    // Abort the provider call when the client disconnects mid-stream. 'close'
    // also fires after a normal end, so only abort when the response did not
    // finish cleanly.
    const abortController = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      sendEvent('meta', {
        // ZDR (#116): no sessionId is minted — nothing the replay could
        // point at exists.
        ...(zdr ? {} : { sessionId: session!._id }),
        routing: routingResult,
      });

      /*
       * #232: `routeAndStream` hedges the weighted primary's providers, aborts
       * the loser, and does its own roster fallback (retrying the next model
       * on total failure). The winner's model/provider replace the pre-race
       * pick for persistence.
       */
      const raced = await routeAndStream(
        {
          messages,
          // #104: budget sized against the picked model's window.
          max_tokens: outputTokensFor(routingResult.contextLength, promptCharsFrom(messages)),
          userId,
          abortSignal: abortController.signal,
          // #224: attach the chat session to this turn's trace (ZDR turns have
          // no session — nothing durable can be joined). #308: the workspace
          // retrieval outcome + hit count ride the trace metadata.
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
          // #252: the tool-execution session rides outside the trace guard for
          // the same reason (ZDR turns have no durable session to attribute to).
          ...(zdr ? {} : { sessionId: String(session!._id) }),
        },
        hasImage,
      );
      routingResult = raced.routing;
      const stream = raced.outcome.result.stream;

      // #262: a tool use between two text runs must render as a paragraph
      // break, not run-on prose. `toolRanSinceText` is armed whenever a tool
      // chunk arrives after text has streamed; the next text delta consumes it
      // by prepending a blank line. Text→tool→text then persists and renders as
      // two paragraphs, while a search-first turn (tool before any text) adds
      // nothing and a tool-ending turn leaves no trailing break.
      let toolRanSinceText = false;
      for await (const chunk of stream) {
        // #224: the connector may emit one trailing usage chunk; capture it
        // and continue without forwarding it as a delta/tool event.
        if (chunk.usage) {
          usage = chunk.usage;
          continue;
        }
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
        // Arm the break on any tool chunk that follows already-streamed text.
        if ((chunk.toolCall || chunk.toolResult) && assistantContent.length > 0) {
          toolRanSinceText = true;
        }
        const delta = chunk.delta;
        if (delta) {
          // Consume the pending break (#262), topping up to exactly one blank
          // line so the two text runs render as separate paragraphs.
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
      // #196: persist the reconciled tool summaries so chips survive a refresh.
      ...(toolEvents.length > 0 ? { tools: toolEvents } : {}),
      metrics: await buildMessageMetrics(String(session!._id), assistantContent),
    });
    await assistantMessage.save();

    // #255 (F4): the notification landed with this persisted turn — mark the
    // drained tasks notified now, not at read time, so a stream that errored
    // before this point leaves the completion pending for the next turn. A
    // marking failure is swallowed (the turn already succeeded; an unmarked
    // completion re-surfaces next turn).
    await markNotified(streamTaskIds).catch((err) =>
      console.error('Task mark-notified error:', redactForLog(err)),
    );

    // Follow-up suggestions (issue #33): generated with the cheap guard
    // model, reusing the title/classification service pattern. Skipped for
    // trivially neutral prompts and empty turns so the 'trivial' skip gate
    // stays consistent; the client falls back to static placeholders when
    // the field is absent.
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
    // #226: order by most recent message. Null lastMessageAt (never-messaged
    // sessions) sorts last under a descending sort; createdAt breaks ties
    // among those nulls (and among equal timestamps) by creation order.
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
