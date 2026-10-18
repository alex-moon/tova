import mongoose from 'mongoose';
import { config } from '../config';
import { WorkspaceEmbedding } from '../models/WorkspaceEmbedding';
import { embedTexts } from './embeddingService';
import { collectWorkspaceSlices } from './workspaceRetrievalService';
import {
  existingEmbeddingHashes,
  planEmbeddingWrites,
  type EmbeddableSlice,
} from './workspaceEmbeddingBackfill';
import {
  embeddingTextHash,
  truncateForEmbedding,
  workspaceSliceText,
  type EmbeddingTextSource,
} from './workspaceEmbeddingText';

/* Write side of workspace retrieval: ingest + backfill, hash-idempotent. */
// @see #294 #289

// Batch size for the backfill; keeps one request well under provider limits.
export const EMBED_BATCH = 64;

export type EmbeddableKind = 'chat' | 'file' | 'task';

export interface EmbedWorkspaceSliceInput {
  userId: string;
  kind: EmbeddableKind;
  sourceId: string;
  source: EmbeddingTextSource;
}

/* Embed and upsert one slice; never throws, so ingest cannot break a turn. */
export const embedWorkspaceSlice = async (
  input: EmbedWorkspaceSliceInput,
  deps: { embed?: (texts: string[]) => Promise<number[][]> } = {},
): Promise<void> => {
  if (!config.workspaceMemory.enabled) return;
  try {
    const { text } = truncateForEmbedding(workspaceSliceText(input.source));
    if (!text) return;
    const model = config.embeddings.model;
    const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts, { kind: 'passage' }));
    const [vector] = await embed([text]);
    if (!vector) return;
    await WorkspaceEmbedding.updateOne(
      { kind: input.kind, sourceId: input.sourceId, model },
      {
        $set: {
          userId: new mongoose.Types.ObjectId(input.userId),
          dim: config.embeddings.dim,
          vector,
          textHash: embeddingTextHash(text, model),
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error('Workspace embedding ingest error:', err);
  }
};

/* Fire-and-forget wrapper; the promise is tracked so purge can drain it. */
// @see #393
const inFlightEmbeds = new Map<string, Set<Promise<void>>>();

export const enqueueWorkspaceEmbedding = (input: EmbedWorkspaceSliceInput): void => {
  const pending = embedWorkspaceSlice(input);
  let set = inFlightEmbeds.get(input.userId);
  if (!set) {
    set = new Set();
    inFlightEmbeds.set(input.userId, set);
  }
  set.add(pending);
  // Both paths, so a future rejection can never surface as unhandled.
  const cleanup = () => {
    const current = inFlightEmbeds.get(input.userId);
    current?.delete(pending);
    if (current && current.size === 0) inFlightEmbeds.delete(input.userId);
  };
  void pending.then(cleanup, cleanup);
};

/* Await every in-flight ingest for a user; the purge drains around the sweep. */
// @see #393
export const drainUserEmbeddings = async (userId: string): Promise<void> => {
  const set = inFlightEmbeds.get(userId);
  if (!set) return;
  await Promise.allSettled([...set]);
};

export interface EmbedUserResult {
  total: number;
  /** Slices the plan selected for embedding (0 on an idempotent re-run). */
  pending: number;
  embedded: number;
  skipped: number;
  empty: number;
  truncated: number;
  failed: number;
  chars: number;
}

export interface EmbedUserDeps {
  // Injectable for tests; defaults to the DeepInfra passage embedder.
  embed?: (texts: string[]) => Promise<number[][]>;
  // Plan and report without embedding or writing (the script's `--dry-run`).
  dryRun?: boolean;
}

/* Backfill one user's corpus; idempotent by textHash. */
export const embedWorkspaceUser = async (
  userId: string,
  deps: EmbedUserDeps = {},
): Promise<EmbedUserResult> => {
  const uid = new mongoose.Types.ObjectId(userId);
  const model = config.embeddings.model;

  const collected = await collectWorkspaceSlices(userId);
  // Title rides along so planned text matches the ingest fold.
  // @see #309
  const slices: EmbeddableSlice[] = collected.map((slice) => ({
    kind: slice.kind,
    id: slice.id,
    text: slice.text,
    title: slice.title,
  }));

  // Rows of a foreign dim never satisfy the skip; the upsert overwrites them.
  // @see #393
  const rows = await WorkspaceEmbedding.find({ model, userId: uid, dim: config.embeddings.dim })
    .select('kind sourceId model textHash')
    .lean();
  const plan = planEmbeddingWrites(slices, existingEmbeddingHashes(rows, model), model);
  const chars = plan.toEmbed.reduce((sum, item) => sum + item.text.length, 0);

  const result: EmbedUserResult = {
    total: plan.total,
    pending: plan.toEmbed.length,
    embedded: 0,
    skipped: plan.skipped,
    empty: plan.empty,
    truncated: plan.truncated,
    failed: 0,
    chars,
  };
  if (deps.dryRun) return result;

  // Backfill timeout: a 64-passage batch outlives the hot-path budget.
  const embed =
    deps.embed ??
    ((texts: string[]) =>
      embedTexts(texts, { kind: 'passage', timeoutMs: config.embeddings.backfillTimeoutMs }));
  for (let i = 0; i < plan.toEmbed.length; i += EMBED_BATCH) {
    const batch = plan.toEmbed.slice(i, i + EMBED_BATCH);
    let vectors: number[][];
    try {
      vectors = await embed(batch.map((item) => item.text));
    } catch (err) {
      result.failed += batch.length;
      console.error('Workspace embedding backfill batch error:', err);
      continue;
    }
    for (let j = 0; j < batch.length; j += 1) {
      const item = batch[j];
      try {
        await WorkspaceEmbedding.updateOne(
          { kind: item.kind, sourceId: item.sourceId, model },
          {
            $set: {
              userId: uid,
              dim: config.embeddings.dim,
              vector: vectors[j],
              textHash: item.textHash,
            },
          },
          { upsert: true },
        );
        result.embedded += 1;
      } catch (err) {
        result.failed += 1;
        console.error('Workspace embedding backfill upsert error:', err);
      }
    }
  }
  return result;
};
