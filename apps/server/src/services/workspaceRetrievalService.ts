import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { config } from '../config';

/*
 * #253: workspace memory — retrieval over the user's past work.
 *
 * The epic's unit of memory is a *piece of work*, not an extracted concept
 * (that was #138, superseded). The v1 corpus is addressable *views* over what
 * already exists — `Message` rows joined to their `Session` title, and `Asset`
 * rows' extracted text — read at retrieval time; nothing is copied into a new
 * store (the ticket's "no eager copies into library-shaped docs").
 *
 * Retrieval is personal-scale and lexical (#251: no vector infra in v1):
 * keyword-overlap scoring over a recent bounded candidate pool, recency as a
 * tiebreak only. An overlap of zero scores zero, so recency alone cannot drag
 * an unrelated slice into the block.
 *
 * The gate (does a turn deserve retrieval at all?) lives in
 * `enrichmentService.ts`; this module is pure retrieval + layout so scoring
 * is unit-testable without Mongo.
 */

/*
 * Keyword tokeniser for lexical scoring (moved here from the retired
 * `entityRetrievalService`, #256). Lowercase, split on non-word characters,
 * drop single characters and stopwords that carry no linking signal — "the
 * hotel" still matches a slice mentioning "hotel" via `hotel`, but 'the'
 * alone must not surface unrelated slices.
 */
const WORD_PATTERN = /[a-z0-9']+/g;

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'near',
  'at',
  'is',
  'it',
  'my',
  'me',
  'you',
  'we',
  'i',
  'be',
  'are',
  'was',
]);

export const promptWords = (prompt: string): Set<string> => {
  const words = prompt.toLowerCase().replace(/\s+/g, ' ').trim().match(WORD_PATTERN) ?? [];
  return new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)));
};

// #251/decision: kill switch. Default OFF — a wrong injection pollutes every
// turn, so the block ships opt-in until the gate evals exist (see
// docs/plan-253-workspace-memory.md).
export const isWorkspaceMemoryEnabled = (): boolean => config.workspaceMemory.enabled;

// Injection budget (chars), sized so the block leaves room for the library
// index in the same prompt budget (plan decision 4).
export const BLOCK_CAP = 1200;

// Candidate pool sizes: bounded so cost is flat regardless of history length.
const MESSAGE_POOL = 200;
const ASSET_POOL = 50;
const MAX_SLICES = 6;

export type WorkspaceSlice = {
  kind: 'chat' | 'file';
  id: string;
  title: string;
  text: string;
  at: Date;
};

/*
 * Deterministic score = keyword overlap × 10 + a small recency nudge, with a
 * hard floor at zero overlap (recency never lifts an irrelevant slice in).
 * The recency nudge is scaled so it can only reorder equals, not outrank a
 * slice with strictly more overlap.
 */
export const scoreSlice = (prompt: string, slice: { text: string; at: Date }): number => {
  const words = promptWords(prompt);
  if (words.size === 0) return 0;
  const sliceWords = promptWords(slice.text);
  let overlap = 0;
  for (const word of words) if (sliceWords.has(word)) overlap += 1;
  if (overlap === 0) return 0;
  const ageDays = Math.max(0, Date.now() - new Date(slice.at).getTime()) / 86400000;
  return overlap * 10 + Math.max(0, 5 - ageDays);
};

export const pickTopSlices = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
): { slice: WorkspaceSlice; score: number }[] =>
  slices
    .map((slice) => ({ slice, score: scoreSlice(prompt, slice) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);

/*
 * A bounded snippet centred on where the prompt actually matched, so the model
 * sees the region that caused the retrieval rather than the head of the source
 * (a lease's pets clause may sit thousands of characters into the document; the
 * head-160 window would show the title page and nothing that supports the
 * answer). Falls back to the head when the match is at the very start, and is
 * always `<= cap` characters so the block-cap accounting below stays exact.
 */
export const matchSnippet = (text: string, prompt: string, cap = 160): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= cap) return line;
  const words = [...promptWords(prompt)];
  const lower = line.toLowerCase();
  let at = -1;
  for (const word of words) {
    const idx = lower.indexOf(word);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  // Reserve room for a leading and/or trailing ellipsis.
  const body = cap - 2;
  if (at <= 0) return `${line.slice(0, body)}…`;
  const start = Math.max(0, Math.min(at - Math.floor(body / 3), line.length - body));
  const head = start > 0 ? '…' : '';
  const tail = start + body < line.length ? '…' : '';
  return `${head}${line.slice(start, start + body)}${tail}`;
};

/*
 * Layout: one bullet per slice, hard character cap, empty-on-nothing so an
 * empty block never shifts an otherwise identical prompt. Chat slices carry
 * their session title + date; file slices carry their filename.
 */
export const buildWorkspaceBlock = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  cap = BLOCK_CAP,
): string => {
  const picked = pickTopSlices(prompt, slices, n);
  if (picked.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const { slice } of picked) {
    const date = new Date(slice.at).toISOString().slice(0, 10);
    const label = slice.kind === 'chat' ? `chat "${slice.title}"` : `file "${slice.title}"`;
    const line = `- ${label} (${date}) — ${matchSnippet(slice.text, prompt)}`;
    // Count the joining newline too, so the rendered block stays within `cap`
    // rather than exceeding it by up to n-1 separators.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > cap) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
};

/*
 * Mongo-backed retrieval: a recent bounded pool of the user's messages (joined
 * to their session titles) and extracted-asset text, scored against the prompt.
 * Empty block when nothing overlaps. Never throws — memory must not degrade a
 * chat turn.
 *
 * Ownership is resolved session-first: `messages` is keyed by `sessionId`, not
 * by `userId`, so the user's sessions are the join key. Fetching the sessions
 * first (bounded, indexed by `{ userId, deletedAt, lastMessageAt }`) then
 * filtering messages by `sessionId` keeps the pool owned by construction — a
 * global `Message.find({ role: 'user' })` would be dominated by other users'
 * recent turns and could starve this user's own history out of the window.
 *
 * `excludeMessageId` drops the just-saved current turn (the routes run
 * retrieval after persisting it) so the turn is never retrieved and injected
 * back as its own "past work". `excludeAssetId` does the same for the file
 * attached to the current turn: an attachment under discussion is not past
 * work, and its contents already ride the `<user_content>` envelope (or the
 * file-library index), so re-listing it as a retrieved slice would only
 * duplicate it.
 *
 * Ephemeral assets (ZDR chat-composer uploads, `ephemeral: true`) are filtered
 * out of the corpus entirely, matching decision 6 / the epic invariant that
 * incognito artifacts never become workspace items — the durable-library reads
 * (the assets page) exclude them for the same reason.
 */
export const retrieveWorkspaceBlock = async (
  prompt: string,
  userId: string,
  n = MAX_SLICES,
  excludeMessageId?: string,
  excludeAssetId?: string,
): Promise<string> => {
  try {
    const uid = new mongoose.Types.ObjectId(userId);
    const sessions = await Session.find({ userId: uid, deletedAt: null })
      .sort({ lastMessageAt: -1 })
      .limit(MESSAGE_POOL)
      .select('title')
      .lean();

    const titleById = new Map(sessions.map((s) => [String(s._id), s.title as string] as const));
    const sessionIds = sessions.map((s) => s._id as mongoose.Types.ObjectId);

    const [messages, assets] = await Promise.all([
      // An empty `$in` yields no rows, so a user with files but no chats still
      // gets file retrieval (the asset read does not depend on sessions).
      Message.find({
        role: 'user',
        sessionId: { $in: sessionIds },
        _id: { $ne: excludeMessageId ?? null },
      })
        .sort({ timestamp: -1 })
        .limit(MESSAGE_POOL)
        .select('sessionId content timestamp')
        .lean(),
      Asset.find({
        userId: uid,
        status: 'ready',
        ephemeral: { $ne: true },
        _id: { $ne: excludeAssetId ?? null },
        $or: [{ textExtracted: { $ne: null } }, { markdownExtracted: { $ne: null } }],
      })
        .sort({ _id: -1 })
        .limit(ASSET_POOL)
        .select('filename textExtracted markdownExtracted createdAt')
        .lean(),
    ]);

    const slices: WorkspaceSlice[] = [];
    for (const m of messages) {
      const sid = String(m.sessionId);
      const text = (m.content as string) ?? '';
      if (!text.trim()) continue;
      slices.push({
        kind: 'chat',
        id: String(m._id),
        title: titleById.get(sid) ?? 'Untitled chat',
        text,
        at: m.timestamp as Date,
      });
    }
    for (const a of assets) {
      const text = ((a.markdownExtracted as string) || (a.textExtracted as string) || '').trim();
      if (!text) continue;
      slices.push({
        kind: 'file',
        id: String(a._id),
        title: a.filename as string,
        text,
        at: (a.createdAt as Date) ?? new Date(0),
      });
    }

    return buildWorkspaceBlock(prompt, slices, n);
  } catch (err) {
    console.error('Workspace retrieval error:', err);
    return '';
  }
};
