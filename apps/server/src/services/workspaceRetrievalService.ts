import mongoose from 'mongoose';
import { Asset } from '../models/Asset';
import { Message } from '../models/Message';
import { Session } from '../models/Session';
import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { WorkspaceEmbedding } from '../models/WorkspaceEmbedding';
import { config } from '../config';
import { VECTOR_INDEX_NAME } from './atlasVectorIndex';
import { embedTexts } from './embeddingService';
import { withTimeout } from './markdownConversion';

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

/*
 * #309: how many extra occurrences each title token contributes to a slice's
 * document stream. The title (a file's filename, a task's instruction line, a
 * chat's session title) carries terms the content cannot supply — "that AGI
 * file" must match `agi-final.md` even when "AGI" appears nowhere in the text.
 * Boost of 2 means a title-only term matches (tf 2) and a term also present in
 * the content is pulled toward the title. Exported/diffable like K1/B.
 */
export const BM25_TITLE_BOOST = 2;

// The doc token stream for one slice: the content plus the title tokens
// repeated `BM25_TITLE_BOOST` times, so tf and length derive from one stream.
const sliceTokens = (slice: WorkspaceSlice): string[] => {
  const titleTokens = tokenize(slice.title);
  return [
    ...tokenize(slice.text),
    ...Array.from({ length: BM25_TITLE_BOOST }, () => titleTokens).flat(),
  ];
};

export const pickTopSlices = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
): { slice: WorkspaceSlice; score: number }[] => {
  const N = slices.length;
  if (N === 0) return [];
  const queryTerms = [...promptWords(prompt)];
  if (queryTerms.length === 0) return [];

  // Tokenise each document once into a term-frequency map plus its token
  // count. Building the maps up front means `df` is a `has` lookup per term
  // (O(total tokens + Q·D)) rather than a re-scan of every document per query
  // term — the full-corpus read makes that difference matter.
  const docs = slices.map((slice) => {
    const tf = new Map<string, number>();
    let length = 0;
    for (const term of sliceTokens(slice)) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
      length += 1;
    }
    return { tf, length };
  });
  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / N;
  // Every document tokenises to nothing (avgdl 0): IDF/length maths divides by
  // zero and no term can overlap, so nothing is rankable.
  if (avgdl === 0) return [];

  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const doc of docs) if (doc.tf.has(term)) count += 1;
    df.set(term, count);
  }

  return (
    slices
      .map((slice, i) => {
        const { tf, length } = docs[i];
        let score = 0;
        for (const term of queryTerms) {
          const freq = tf.get(term);
          if (!freq) continue;
          const termDf = df.get(term) ?? 0;
          const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
          const norm = freq + BM25_K1 * (1 - BM25_B + BM25_B * (length / avgdl));
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
export const renderBlock = (
  prompt: string,
  picked: { slice: WorkspaceSlice }[],
  cap = BLOCK_CAP,
): string => {
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
 * The BM25-only layout wrapper the existing tests and pure callers use. The
 * retrieval read (#294) ranks through `retrieveRankedSlices` instead so it can
 * fuse the vector ranking, then renders with `renderBlock` directly.
 */
export const buildWorkspaceBlock = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  cap = BLOCK_CAP,
): string => renderBlock(prompt, pickTopSlices(prompt, slices, n), cap);

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
  deps: RetrievalDeps = {},
): Promise<WorkspaceSlice[]> => {
  try {
    const slices = await collectWorkspaceSlices(userId, excludeMessageId, excludeAssetId);
    return await rankWorkspaceSlices(prompt, userId, slices, n, deps);
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
  deps: RetrievalDeps = {},
): Promise<string> => {
  try {
    const slices = await collectWorkspaceSlices(userId, excludeMessageId, excludeAssetId);
    const ranked = await rankWorkspaceSlices(prompt, userId, slices, n, deps);
    return renderBlock(
      prompt,
      ranked.map((slice) => ({ slice })),
    );
  } catch (err) {
    console.error('Workspace retrieval error:', err);
    return '';
  }
};

/*
 * #294, task 8: the semantic half of retrieval. Embed the query, then ask
 * Atlas Vector Search for the nearest stored vectors over the same corpus BM25
 * searches. This is the one stage that cannot run in CI: `$vectorSearch` does
 * not exist on local `mongod`/`mongodb-memory-server`, so the driver path is
 * exercised only against Atlas (the #289 live run). Everything around it is
 * injectable, so the degradation contract is unit-tested with fakes.
 *
 * It never throws. A missing key, an unavailable index, a provider error, a
 * timeout, or a malformed response all degrade to `[]` — retrieval then falls
 * back to the BM25 result, never an error on a chat turn.
 */

export interface VectorHit {
  sourceId: string;
  score: number;
}

export interface VectorSearchParams {
  userId: string;
  model: string;
  queryVector: number[];
  limit: number;
  numCandidates: number;
}

export interface VectorSearchDeps {
  // Injectable for tests; default embeds the query against DeepInfra.
  embed?: (texts: string[]) => Promise<number[][]>;
  // Injectable for tests; default runs the Atlas `$vectorSearch` aggregate.
  search?: (params: VectorSearchParams) => Promise<VectorHit[]>;
  timeoutMs?: number;
}

/*
 * Candidate headroom: the vector hits are intersected with the collected slice
 * set downstream (task 10), and orphaned rows (their source deleted) still
 * occupy this window, so over-fetch before filtering. `numCandidates` must be
 * >= `limit` for `$vectorSearch`; both scale together.
 */
export const VECTOR_CANDIDATE_MULTIPLIER = 4;
export const VECTOR_CANDIDATE_FLOOR = 100;

const defaultVectorSearch = async (params: VectorSearchParams): Promise<VectorHit[]> => {
  const rows = await WorkspaceEmbedding.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'vector',
        queryVector: params.queryVector,
        numCandidates: params.numCandidates,
        limit: params.limit,
        // `userId` is stored as an ObjectId and `$vectorSearch` filters compare
        // exactly, so it must be passed as one (a string would silently match
        // nothing). `model` is a plain string.
        filter: { userId: new mongoose.Types.ObjectId(params.userId), model: params.model },
      },
    },
    { $project: { _id: 0, sourceId: 1, score: { $meta: 'vectorSearchScore' } } },
  ]);
  return rows.map((row) => ({ sourceId: String(row.sourceId), score: Number(row.score) }));
};

export const vectorCandidates = async (
  query: string,
  userId: string,
  model: string,
  n = MAX_SLICES,
  deps: VectorSearchDeps = {},
): Promise<VectorHit[]> => {
  const limit = Math.max(n * VECTOR_CANDIDATE_MULTIPLIER, VECTOR_CANDIDATE_FLOOR);
  const numCandidates = Math.max(limit, VECTOR_CANDIDATE_FLOOR);
  try {
    const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts, { kind: 'query' }));
    const search = deps.search ?? defaultVectorSearch;
    // One deadline over the whole stage (embed + ANN query): `embedTexts` sets
    // its own `AbortSignal` at the same `timeoutMs`, so the two fire together
    // and the effective bound is ~`timeoutMs`, not twice it. `withTimeout`
    // rejects the caller but cannot cancel the in-flight work, which is fine —
    // the late result is discarded and retrieval has already degraded to BM25.
    const run = async (): Promise<VectorHit[]> => {
      const [queryVector] = await embed([query]);
      if (!queryVector || queryVector.length === 0) return [];
      return search({ userId, model, queryVector, limit, numCandidates });
    };
    return await withTimeout(run(), deps.timeoutMs ?? config.embeddings.timeoutMs);
  } catch (err) {
    console.error('Workspace vector search degraded to BM25:', err);
    return [];
  }
};

/*
 * #294, task 9: reciprocal rank fusion (RRF) of the BM25 and vector rankings.
 *
 * score(d) = w_bm25 / (k + rank_bm25(d)) + w_vec / (k + rank_vec(d))
 *
 * Rank-based, so no score normalisation between BM25 and cosine distance is
 * needed. A document absent from a ranking contributes 0 (no penalty). Only
 * slices present in `slices` are eligible, so a vector hit whose `sourceId` is
 * not in the collected set (an orphaned row) is dropped — the intersection is
 * the correctness invariant that keeps deleted/ephemeral/out-of-pool slices
 * from being surfaced. Pure: no Mongo, no `Date.now()`.
 */
export const RRF_K = 60;
export const RRF_BM25_WEIGHT = 1;
export const RRF_VECTOR_WEIGHT = 1;

export interface RrfWeights {
  bm25: number;
  vector: number;
}

export const rrfFuse = (
  slices: WorkspaceSlice[],
  bm25: { slice: WorkspaceSlice; score: number }[],
  vector: VectorHit[],
  weights: RrfWeights = { bm25: RRF_BM25_WEIGHT, vector: RRF_VECTOR_WEIGHT },
  k = RRF_K,
): WorkspaceSlice[] => {
  const byId = new Map(slices.map((slice) => [slice.id, slice] as const));
  const scores = new Map<string, number>();
  const add = (id: string, weight: number, rank: number): void => {
    scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
  };

  bm25.forEach((hit, i) => {
    if (byId.has(hit.slice.id)) add(hit.slice.id, weights.bm25, i + 1);
  });
  vector.forEach((hit, i) => {
    if (byId.has(hit.sourceId)) add(hit.sourceId, weights.vector, i + 1);
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ slice: byId.get(id) as WorkspaceSlice, score }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.slice.at).getTime() - new Date(a.slice.at).getTime() ||
        (a.slice.id < b.slice.id ? -1 : a.slice.id > b.slice.id ? 1 : 0),
    )
    .map((entry) => entry.slice);
};

/*
 * #294, task 10: the retrieval pipeline. Pure BM25 ranking (#293) fused with
 * the semantic ranking (#294) through `rrfFuse`, intersected with the collected
 * slice set so a vector hit whose source is gone (or was never in the read) is
 * dropped. The vector stage is injectable so the fusion wiring is unit-tested
 * without Mongo or a provider.
 *
 * The vector stage shares the workspace-memory kill switch: with the flag off
 * the result is the #293 BM25 ranking exactly and no embedding call is made
 * ("no behaviour change when off"). With the flag on but no key, index, or
 * provider reachable, `vectorCandidates` degrades to `[]` and the result is
 * again the BM25 ranking — never an error.
 */
export interface RetrievalDeps {
  vectorCandidates?: (
    query: string,
    userId: string,
    model: string,
    n?: number,
    deps?: VectorSearchDeps,
  ) => Promise<VectorHit[]>;
  weights?: RrfWeights;
}

export const rankWorkspaceSlices = async (
  prompt: string,
  userId: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  deps: RetrievalDeps = {},
): Promise<WorkspaceSlice[]> => {
  if (slices.length === 0) return [];
  const bm25 = pickTopSlices(prompt, slices, n);
  const vector = isWorkspaceMemoryEnabled()
    ? await (deps.vectorCandidates ?? vectorCandidates)(prompt, userId, config.embeddings.model, n)
    : [];
  return rrfFuse(slices, bm25, vector, deps.weights).slice(0, n);
};
