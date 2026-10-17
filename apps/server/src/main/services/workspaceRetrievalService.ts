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
import { rerankQuery } from './rerankerService';
import { withTimeout } from './markdownConversion';

/* Workspace memory — retrieval over the user's past work: addressable views over existing rows (no eager copies), BM25-ranked at personal scale over one read-time candidate set; pure retrieval + layout, no gate. */
// @see #253 #138 #251 #298 #293

/* Keyword tokeniser for lexical scoring: lowercase, split on non-word chars, drop single characters and stopwords; returns terms with multiplicity for BM25. */
// @see #256
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

// Kill switch, default OFF: a wrong injection pollutes every turn, so the block ships opt-in until the gate evals exist.
// @see #251
export const isWorkspaceMemoryEnabled = (): boolean => config.workspaceMemory.enabled;

// Injection budget (chars), sized so the block leaves room for the library index in the same prompt budget.
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

/* BM25 ranking, replacing the naive overlap score; standard parameters exported so a tuning change is a visible diff; corpus-relative and pure (no Mongo, no Date.now()). */
// @see #293
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/* Extra occurrences each title token contributes to a slice's document stream — the title carries terms the content cannot supply; exported/diffable like K1/B. */
// @see #309
export const BM25_TITLE_BOOST = 2;

// The doc token stream for one slice: content plus title tokens repeated `BM25_TITLE_BOOST` times, so tf and length derive from one stream.
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

  // Tokenise each document once into a term-frequency map plus its token count, so `df` is a `has` lookup per term rather than a re-scan per query term.
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
  // Every document tokenises to nothing (avgdl 0): the maths divides by zero and no term can overlap.
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
      // Total order: BM25 desc, then recency, then id asc — deterministic regardless of sort stability.
      .sort(
        (a, b) =>
          b.score - a.score ||
          new Date(b.slice.at).getTime() - new Date(a.slice.at).getTime() ||
          (a.slice.id < b.slice.id ? -1 : a.slice.id > b.slice.id ? 1 : 0),
      )
      .slice(0, n)
  );
};

/* A bounded snippet centred on where the prompt actually matched, so the model sees the region that caused the retrieval, not the head of the source; always <= cap so block accounting stays exact. */
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

/* Slice title for a task: the first instruction line, collapsed and capped, with a stable placeholder when empty. */
export const TASK_TITLE_CAP = 60;
export const taskTitle = (instruction: string): string => {
  const line = instruction.replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled task';
  return line.length <= TASK_TITLE_CAP ? line : `${line.slice(0, TASK_TITLE_CAP - 1)}…`;
};

/* Layout: one bullet per slice under a hard character cap, empty-on-nothing so an empty block never shifts an otherwise identical prompt. */
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
    // Count the joining newline too, so the rendered block stays within `cap`.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > cap) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
};

/* The BM25-only layout wrapper for pure callers; the retrieval read ranks through retrieveRankedSlices instead so it can fuse the vector ranking. */
// @see #294
export const buildWorkspaceBlock = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  cap = BLOCK_CAP,
): string => renderBlock(prompt, pickTopSlices(prompt, slices, n), cap);

/* The corpus read: the user's whole non-deleted chat history (joined to session titles), asset text and task streams, as prompt-independent slices; pure data so scoring/layout happen in callers. The chat corpus is NOT recency-bounded (a bounded window made old relevant chats unreachable by construction); ownership is resolved session-first so other users' turns cannot starve this user's history. Excludes the current turn/attachment and ephemeral assets; tasks contribute one slice per stream in seq order (system notices skipped; the instruction header is not folded — it duplicates the first event). */
// @see #293 #298
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
    // An empty `$in` yields no rows, so a user with files but no chats still gets file retrieval.
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

/* The top-ranked slices for a prompt, with their IDs (hit-rate matches on the slice ID); never throws — an eval or chat turn degrades to "nothing", not an error. */
// @see #289
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

/* The rendered `<user:workspace>` block for a prompt; empty when nothing overlaps; never throws. */
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

/* The semantic half of retrieval: embed the query, then Atlas Vector Search over the same corpus BM25 searches; Atlas-only stage, everything injectable; never throws — every failure degrades to [] and BM25. */
// @see #294 #289

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
  // Injectable for tests.
  embed?: (texts: string[]) => Promise<number[][]>;
  // Injectable for tests; default runs the Atlas `$vectorSearch` aggregate.
  search?: (params: VectorSearchParams) => Promise<VectorHit[]>;
  timeoutMs?: number;
}

/* Candidate headroom: vector hits are intersected with the collected set downstream, and orphaned rows still occupy the window — over-fetch before filtering; numCandidates must be >= limit. */
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
        // `userId` is an ObjectId and `$vectorSearch` filters compare exactly, so a string would silently match nothing.
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
    // One deadline over the whole stage (embed + ANN query): both set their own `AbortSignal` at the same `timeoutMs`, so the effective bound is ~`timeoutMs`, not twice it; the late result is discarded.
    // @see #294
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

/* Reciprocal rank fusion of the BM25 and vector rankings; rank-based so no score normalisation is needed; the intersection with the collected set is the correctness invariant (orphans dropped); pure. */
// @see #294
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

/* The retrieval pipeline: BM25 fused with the semantic ranking through rrfFuse, intersected with the collected set; the vector stage shares the kill switch — flag off means exactly the BM25 ranking and no embedding call; degradation always falls back to BM25, never an error. */
// @see #294 #293
export interface RetrievalDeps {
  vectorCandidates?: (
    query: string,
    userId: string,
    model: string,
    n?: number,
    deps?: VectorSearchDeps,
  ) => Promise<VectorHit[]>;
  weights?: RrfWeights;
  // Injectable rerank; defaults to the DeepInfra cross-encoder; null degrades to the un-cut fused ranking.
  // @see #305
  rerank?: (query: string, documents: string[]) => Promise<number[] | null>;
}

/* The post-retrieval relevance bar: candidates below the calibrated threshold are dropped — including all of them, which is the graceful refusal path (a paraphrase referent may fall below the bar; known trade-off). */
// @see #305 #289
export const RERANK_CUT = 0.005;

// The text a candidate is graded on: the title (the filename matters for reranking too) above the content.
// @see #309
const rerankDocText = (slice: WorkspaceSlice): string =>
  slice.title ? `${slice.title}\n${slice.text}` : slice.text;

export const rerankAndCut = async (
  prompt: string,
  fused: WorkspaceSlice[],
  deps: RetrievalDeps,
): Promise<WorkspaceSlice[]> => {
  if (fused.length === 0) return [];
  const rerank = deps.rerank ?? rerankQuery;
  const scores = await rerank(prompt, fused.map(rerankDocText));
  // Degradation: a failed/unavailable reranker behaves exactly as pre-#305.
  // @see #305
  if (!scores) return fused;
  return fused
    .map((slice, i) => ({ slice, score: scores[i] ?? 0 }))
    .filter(({ score }) => score >= RERANK_CUT)
    .sort((x, y) => y.score - x.score) // stable: equal scores keep fused order
    .map(({ slice }) => slice);
};

export interface RankedWithCut {
  ranked: WorkspaceSlice[];
  /** Fused candidates the reranker graded (#305: ≤ ~12). */
  candidateCount: number;
  /** Candidates the cut removed — all of them is the graceful-refusal path. */
  cutCount: number;
}

export const rankWorkspaceSlicesWithCut = async (
  prompt: string,
  userId: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  deps: RetrievalDeps = {},
): Promise<RankedWithCut> => {
  if (slices.length === 0) return { ranked: [], candidateCount: 0, cutCount: 0 };
  const bm25 = pickTopSlices(prompt, slices, n);
  const vector = isWorkspaceMemoryEnabled()
    ? await (deps.vectorCandidates ?? vectorCandidates)(prompt, userId, config.embeddings.model, n)
    : [];
  const fused = rrfFuse(slices, bm25, vector, deps.weights);
  // The rerank stage shares the kill switch — flag off means exactly the pre-#305 fused ranking and no reranker call.
  // @see #305
  if (!isWorkspaceMemoryEnabled()) {
    const ranked = fused.slice(0, n);
    return { ranked, candidateCount: 0, cutCount: 0 };
  }
  const reranked = await rerankAndCut(prompt, fused, deps);
  return {
    ranked: reranked.slice(0, n),
    candidateCount: fused.length,
    cutCount: fused.length - reranked.length,
  };
};

export const rankWorkspaceSlices = async (
  prompt: string,
  userId: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  deps: RetrievalDeps = {},
): Promise<WorkspaceSlice[]> =>
  (await rankWorkspaceSlicesWithCut(prompt, userId, slices, n, deps)).ranked;
