import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { config } from '../config';

/*
 * #253: workspace memory — retrieval over the user's past work.
 *
 * The epic's unit of memory is a *piece of work*, not an extracted concept
 * (that was #138, superseded). The v1 corpus is addressable *views* over what
 * already exists — `Message` rows joined to their `Session` title, `Asset`
 * rows' extracted text, and (since #298) a task's `TaskEvent` stream — read at
 * retrieval time; nothing is copied into a new store (the ticket's "no eager
 * copies into library-shaped docs").
 *
 * Retrieval is personal-scale and lexical (#251: no vector infra in v1): since
 * #293 it ranks the user's whole non-deleted chat corpus with BM25, over one
 * candidate set assembled at read time (see `collectWorkspaceSlices`). A slice
 * with zero query-term overlap scores zero, so recency alone cannot drag an
 * unrelated slice into the block.
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
 * alone must not surface unrelated slices. Returns terms **with multiplicity**
 * so BM25 can measure document term frequency; `promptWords` wraps it in a
 * `Set` for the callers that only need membership.
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

export const tokenize = (text: string): string[] => {
  const words = text.toLowerCase().replace(/\s+/g, ' ').trim().match(WORD_PATTERN) ?? [];
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word));
};

export const promptWords = (prompt: string): Set<string> => new Set(tokenize(prompt));

// #251/decision: kill switch. Default OFF — a wrong injection pollutes every
// turn, so the block ships opt-in until the gate evals exist (see
// docs/done/plan-253-workspace-memory.md).
export const isWorkspaceMemoryEnabled = (): boolean => config.workspaceMemory.enabled;

// Injection budget (chars), sized so the block leaves room for the library
// index in the same prompt budget (plan decision 4).
export const BLOCK_CAP = 1200;

// Asset/task candidate pools: still bounded (see the corpus-read comment).
const ASSET_POOL = 50;
const TASK_POOL = 50;
const MAX_SLICES = 6;

export type WorkspaceSlice = {
  kind: 'chat' | 'file' | 'task';
  id: string;
  title: string;
  text: string;
  at: Date;
};

/*
 * #293: BM25 ranking, replacing the naive overlap score. Parameters are
 * standard defaults, exported so a future tuning change is a visible diff.
 *
 * score(q, d) = Σ_{t ∈ distinct(q)} idf(t) · (tf(t,d) · (k1 + 1))
 *               / (tf(t,d) + k1 · (1 - b + b · |d| / avgdl))
 * idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))   (non-negative form)
 *
 * `df` counts documents containing a term (set membership); query term
 * frequency is fixed at 1. A query term absent from every document contributes
 * nothing, and a slice with no query term at all scores 0 — so the
 * "recency alone cannot surface an unrelated slice" invariant is preserved.
 * BM25 is corpus-relative (IDF, `avgdl`), so there is no single-document
 * `scoreSlice`; the ranker is pure (no Mongo, no `Date.now()`).
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export const pickTopSlices = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
): { slice: WorkspaceSlice; score: number }[] => {
  const N = slices.length;
  if (N === 0) return [];
  const queryTerms = [...promptWords(prompt)];
  if (queryTerms.length === 0) return [];

  const docs = slices.map((slice) => tokenize(slice.text));
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / N;
  // Every document tokenises to nothing (avgdl 0): IDF/length maths divides by
  // zero and no term can overlap, so nothing is rankable.
  if (avgdl === 0) return [];

  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) if (doc.includes(term)) count += 1;
    df.set(term, count);
  }

  return (
    slices
      .map((slice, i) => {
        const doc = docs[i];
        const tf = new Map<string, number>();
        for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
        let score = 0;
        for (const term of queryTerms) {
          const freq = tf.get(term);
          if (!freq) continue;
          const termDf = df.get(term) ?? 0;
          const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
          const norm = freq + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgdl));
          score += idf * ((freq * (BM25_K1 + 1)) / norm);
        }
        return { slice, score };
      })
      .filter(({ score }) => score > 0)
      // Total order: BM25 desc, then recency (`at` desc), then id asc, so the
      // ranking is deterministic regardless of the engine's sort stability.
      .sort(
        (a, b) =>
          b.score - a.score ||
          new Date(b.slice.at).getTime() - new Date(a.slice.at).getTime() ||
          (a.slice.id < b.slice.id ? -1 : a.slice.id > b.slice.id ? 1 : 0),
      )
      .slice(0, n)
  );
};

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
 * Slice title for a task: the first line of its instruction, collapsed and
 * capped, falling back to a stable placeholder when the instruction is empty
 * (a task whose header seed is blank but whose stream still carries work).
 */
export const TASK_TITLE_CAP = 60;
export const taskTitle = (instruction: string): string => {
  const line = instruction.replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled task';
  return line.length <= TASK_TITLE_CAP ? line : `${line.slice(0, TASK_TITLE_CAP - 1)}…`;
};

/*
 * Layout: one bullet per slice, hard character cap, empty-on-nothing so an
 * empty block never shifts an otherwise identical prompt. Chat slices carry
 * their session title + date; file slices carry their filename; task slices
 * carry a title derived from the task instruction.
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
    const label =
      slice.kind === 'chat'
        ? `chat "${slice.title}"`
        : slice.kind === 'task'
          ? `task "${slice.title}"`
          : `file "${slice.title}"`;
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
 * The corpus read: the user's whole non-deleted chat history (joined to session
 * titles), extracted-asset text, and task streams, assembled into
 * prompt-independent `WorkspaceSlice[]`. Pure data — scoring and layout happen
 * in the callers, so the #289 hit-rate eval can match on slice IDs while the
 * chat path only ever wants the rendered block.
 *
 * #293: the chat corpus is no longer a recency-bounded pool. A bounded window
 * made an old relevant chat unreachable by construction — no amount of scoring
 * fixes a candidate that was never fetched — so all of the user's non-deleted
 * sessions and their `role:'user'` messages are read. The bound is now the
 * user's own corpus (personal scale), not recency; the message read no longer
 * sorts, because BM25 ignores insertion order and the read is bounded by the
 * corpus. Assets and tasks keep explicit caps (their "old item unreachable"
 * defect is tracked separately, not this ticket's stated failure).
 *
 * Ownership is resolved session-first: `messages` is keyed by `sessionId`, not
 * by `userId`, so the user's sessions are the join key. Fetching the sessions
 * first (indexed by `{ userId, deletedAt, lastMessageAt }`) then filtering
 * messages by `sessionId` keeps the corpus owned by construction — a global
 * `Message.find({ role: 'user' })` would be dominated by other users' recent
 * turns and could starve this user's own history out.
 * Tasks are owned directly (`Task.userId`) and read the same pool-first way.
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
 * (the assets page) exclude them for the same reason. Tasks need no such
 * filter: ZDR users get no tasks (D7).
 *
 * #298: a task contributes one slice whose text is its `user`/`assistant`
 * `TaskEvent` content in `seq` order (`system` notices are visible-only, never
 * model context, and are skipped). The header `instruction` names the slice but
 * is not folded into the text — it is also the first `user` event, so including
 * it would duplicate it.
 */
export const collectWorkspaceSlices = async (
  userId: string,
  excludeMessageId?: string,
  excludeAssetId?: string,
): Promise<WorkspaceSlice[]> => {
  const uid = new mongoose.Types.ObjectId(userId);
  const sessions = await Session.find({ userId: uid, deletedAt: null }).select('title').lean();

  const titleById = new Map(sessions.map((s) => [String(s._id), s.title as string] as const));
  const sessionIds = sessions.map((s) => s._id as mongoose.Types.ObjectId);

  const [messages, assets, tasks] = await Promise.all([
    // An empty `$in` yields no rows, so a user with files but no chats still
    // gets file retrieval (the asset read does not depend on sessions).
    Message.find({
      role: 'user',
      sessionId: { $in: sessionIds },
      _id: { $ne: excludeMessageId ?? null },
    })
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
    Task.find({ userId: uid })
      .sort({ updatedAt: -1 })
      .limit(TASK_POOL)
      .select('instruction createdAt updatedAt')
      .lean(),
  ]);

  const taskIds = tasks.map((t) => t._id as mongoose.Types.ObjectId);
  const taskEvents = taskIds.length
    ? await TaskEvent.find({
        taskId: { $in: taskIds },
        role: { $in: ['user', 'assistant'] },
      })
        .sort({ seq: 1 })
        .select('taskId content')
        .lean()
    : [];
  const eventsByTask = new Map<string, string[]>();
  for (const event of taskEvents) {
    const text = (event.content as string) ?? '';
    if (!text.trim()) continue;
    const key = String(event.taskId);
    const bucket = eventsByTask.get(key);
    if (bucket) bucket.push(text);
    else eventsByTask.set(key, [text]);
  }

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
  for (const t of tasks) {
    const text = (eventsByTask.get(String(t._id)) ?? []).join('\n');
    if (!text.trim()) continue;
    slices.push({
      kind: 'task',
      id: String(t._id),
      title: taskTitle(t.instruction as string),
      text,
      at: (t.updatedAt as Date) ?? (t.createdAt as Date) ?? new Date(0),
    });
  }
  return slices;
};

/*
 * The top-ranked slices for a prompt, with their IDs (#289: hit-rate matches on
 * the slice ID, which the rendered block does not carry). Never throws — an eval
 * or a chat turn must degrade to "nothing", not an error.
 */
export const retrieveWorkspaceSlices = async (
  prompt: string,
  userId: string,
  n = MAX_SLICES,
  excludeMessageId?: string,
  excludeAssetId?: string,
): Promise<WorkspaceSlice[]> => {
  try {
    const slices = await collectWorkspaceSlices(userId, excludeMessageId, excludeAssetId);
    return pickTopSlices(prompt, slices, n).map((picked) => picked.slice);
  } catch (err) {
    console.error('Workspace retrieval error:', err);
    return [];
  }
};

/*
 * The rendered `<user:workspace>` block for a prompt. Empty when nothing
 * overlaps. Never throws — memory must not degrade a chat turn.
 */
export const retrieveWorkspaceBlock = async (
  prompt: string,
  userId: string,
  n = MAX_SLICES,
  excludeMessageId?: string,
  excludeAssetId?: string,
): Promise<string> => {
  try {
    const slices = await collectWorkspaceSlices(userId, excludeMessageId, excludeAssetId);
    return buildWorkspaceBlock(prompt, slices, n);
  } catch (err) {
    console.error('Workspace retrieval error:', err);
    return '';
  }
};
