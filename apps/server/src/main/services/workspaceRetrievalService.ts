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

/* Workspace memory: BM25-ranked retrieval over existing rows, pure. */
// @see #253 #138 #251 #298 #293

/* Keyword tokeniser: lowercase, non-word split, drop stopwords; BM25 terms. */
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

// Kill switch, default OFF: a wrong injection pollutes every turn.
// @see #251
export const isWorkspaceMemoryEnabled = (): boolean => config.workspaceMemory.enabled;

// Injection budget (chars): leaves room for the library index.
export const BLOCK_CAP = 1200;

// Asset/task candidate pools: still bounded (see the corpus-read comment).
const ASSET_POOL = 50;
const TASK_POOL = 50;
// Newest-500 chat window: O(1) per turn, generous for real corpora.
// @see #393
const CHAT_POOL = 500;
const MAX_SLICES = 6;

export type WorkspaceSlice = {
  kind: 'chat' | 'file' | 'task';
  id: string;
  title: string;
  text: string;
  at: Date;
};

/* BM25 ranking replaces the naive overlap score; pure. */
// @see #293
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/* Extra occurrences per title token; title carries unsupplied terms. */
// @see #309
export const BM25_TITLE_BOOST = 2;

// Doc stream: content plus title tokens repeated BM25_TITLE_BOOST times.
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

  // Tokenise each document once; df becomes a has-lookup per term.
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
  // All-empty docs (avgdl 0): division by zero, no overlaps possible.
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
      // Total order: BM25 desc, then recency, then id asc.
      .sort(
        (a, b) =>
          b.score - a.score ||
          new Date(b.slice.at).getTime() - new Date(a.slice.at).getTime() ||
          (a.slice.id < b.slice.id ? -1 : a.slice.id > b.slice.id ? 1 : 0),
      )
      .slice(0, n)
  );
};

/* Snippet centred on the prompt match, bounded to cap for exact accounting. */
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

/* Task slice title: first instruction line, collapsed and capped. */
export const TASK_TITLE_CAP = 60;
export const taskTitle = (instruction: string): string => {
  const line = instruction.replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled task';
  return line.length <= TASK_TITLE_CAP ? line : `${line.slice(0, TASK_TITLE_CAP - 1)}…`;
};

/* One bullet per slice under a hard cap; empty when nothing fits. */
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

/* BM25-only wrapper for pure callers; retrieval ranks via rrfFuse. */
// @see #294
export const buildWorkspaceBlock = (
  prompt: string,
  slices: WorkspaceSlice[],
  n = MAX_SLICES,
  cap = BLOCK_CAP,
): string => renderBlock(prompt, pickTopSlices(prompt, slices, n), cap);

/* Corpus read: chats, assets, task streams as pure prompt-slice data. */
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
    // Newest window only: the corpus read is O(1) per turn, not O(history).
    // @see #393
    Message.find({
      role: 'user',
      sessionId: { $in: sessionIds },
      _id: { $ne: excludeMessageId ?? null },
    })
      .sort({ timestamp: -1 })
      .limit(CHAT_POOL)
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

/* Top-ranked slices with IDs; never throws — retrieval degrades to []. */
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

/* The rendered <user:workspace> block; empty when nothing overlaps. */
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

/* Semantic half: embed query, Atlas Vector Search; degrades to BM25. */
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
  // Server-side ANN deadline; the client-side race discards late results.
  maxTimeMs?: number;
}

export interface VectorSearchDeps {
  // Injectable for tests.
  embed?: (texts: string[]) => Promise<number[][]>;
  // Injectable for tests; default runs the Atlas `$vectorSearch` aggregate.
  search?: (params: VectorSearchParams) => Promise<VectorHit[]>;
  timeoutMs?: number;
}

/* Over-fetch: orphan rows still occupy the window; candidates get ANN
   exploration headroom above the result window. */
// @see #294 #393
export const VECTOR_CANDIDATE_MULTIPLIER = 4;
export const VECTOR_CANDIDATE_FLOOR = 100;
export const VECTOR_NUM_CANDIDATE_MULTIPLIER = 4;

const defaultVectorSearch = async (params: VectorSearchParams): Promise<VectorHit[]> => {
  const rows = await WorkspaceEmbedding.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'vector',
        queryVector: params.queryVector,
        numCandidates: params.numCandidates,
        limit: params.limit,
        // userId is an ObjectId; a string filter would match nothing.
        filter: { userId: new mongoose.Types.ObjectId(params.userId), model: params.model },
      },
    },
    { $project: { _id: 0, sourceId: 1, score: { $meta: 'vectorSearchScore' } } },
    // Server-side deadline: the query stops, not just the caller.
    // @see #393
  ]).option({ maxTimeMS: params.maxTimeMs ?? config.embeddings.timeoutMs });
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
  const numCandidates = limit * VECTOR_NUM_CANDIDATE_MULTIPLIER;
  const timeoutMs = deps.timeoutMs ?? config.embeddings.timeoutMs;
  try {
    const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts, { kind: 'query' }));
    const search = deps.search ?? defaultVectorSearch;
    // One deadline over embed + ANN query; the late result is discarded.
    // @see #294
    const run = async (): Promise<VectorHit[]> => {
      const [queryVector] = await embed([query]);
      if (!queryVector || queryVector.length === 0) return [];
      return search({ userId, model, queryVector, limit, numCandidates, maxTimeMs: timeoutMs });
    };
    return await withTimeout(run(), timeoutMs, 'workspace vector search');
  } catch (err) {
    console.error('Workspace vector search degraded to BM25:', err);
    return [];
  }
};

/* Reciprocal rank fusion of BM25 and vector; orphans dropped; pure. */
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

/* Pipeline: BM25 fused via rrfFuse; flag off means BM25 only. */
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
  // Injectable rerank; null degrades to the un-cut fused ranking.
  // @see #305
  rerank?: (query: string, documents: string[]) => Promise<number[] | null>;
}

/* Post-retrieval bar: dropping all candidates is the refusal path. */
// @see #305 #289
export const RERANK_CUT = 0.005;

// Rerank budget: RRF-ordered candidates and doc chars sent for grading.
// @see #393
export const RERANK_MAX_CANDIDATES = 24;
export const RERANK_DOC_CHARS = 2000;

// The text a candidate is graded on: title above content.
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
  // Grading sees a bounded window in RRF order; slices keep full text.
  // @see #393
  const graded = fused.slice(0, RERANK_MAX_CANDIDATES);
  const scores = await rerank(
    prompt,
    graded.map((slice) => rerankDocText(slice).slice(0, RERANK_DOC_CHARS)),
  );
  // Degradation: a failed/unavailable reranker behaves exactly as pre-#305.
  // @see #305
  if (!scores) return fused;
  return graded
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
  // Rerank shares the kill switch; flag off means no reranker call.
  // @see #305
  if (!isWorkspaceMemoryEnabled()) {
    const ranked = fused.slice(0, n);
    return { ranked, candidateCount: 0, cutCount: 0 };
  }
  const reranked = await rerankAndCut(prompt, fused, deps);
  const gradedCount = Math.min(fused.length, RERANK_MAX_CANDIDATES);
  // Degradation returns the full fused list; cuts never go negative.
  const kept = Math.min(reranked.length, gradedCount);
  return {
    ranked: reranked.slice(0, n),
    candidateCount: gradedCount,
    cutCount: gradedCount - kept,
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
