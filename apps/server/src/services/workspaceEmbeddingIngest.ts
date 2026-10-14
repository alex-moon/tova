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

/*
 * #294: the write side of workspace semantic retrieval. Two entry points:
 *
 *  - `embedWorkspaceSlice` embeds one slice on ingest (a user message saved, an
 *    asset's text extracted, a task settled). Fire-and-forget: it is never on
 *    the response path and never throws.
 *  - `embedWorkspaceUser` backfills one user's whole collected corpus. The
 *    backfill script and the #289 eval runner share it, so the ingest path and
 *    the backfill path cannot derive different text (they both go through
 *    `workspaceSliceText` + `truncateForEmbedding`) — which is what keeps the
 *    `textHash` skip rule idempotent.
 *
 * Both are gated by `WORKSPACE_MEMORY_ENABLED` at the call site that decides
 * whether to run at all; `embedWorkspaceSlice` also checks it directly so an
 * accidental caller cannot embed while the feature is off.
 */

// Batch size for the backfill; keeps one request well under provider limits.
export const EMBED_BATCH = 64;

export type EmbeddableKind = 'chat' | 'file' | 'task';

export interface EmbedWorkspaceSliceInput {
  userId: string;
  kind: EmbeddableKind;
  sourceId: string;
  source: EmbeddingTextSource;
}

/*
 * Embed and upsert one slice. Returns without a write when the feature is off,
 * the text is empty, or the provider fails — every failure is logged and
 * swallowed, so an ingest hook can never break the turn that triggered it.
 */
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

/*
 * Fire-and-forget wrapper for the request/worker hot paths. `embedWorkspaceSlice`
 * already swallows, so the returned promise is intentionally not awaited.
 */
export const enqueueWorkspaceEmbedding = (input: EmbedWorkspaceSliceInput): void => {
  void embedWorkspaceSlice(input);
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

/*
 * Backfill one user's collected corpus. Idempotent: only slices whose
 * `textHash` differs from the stored row are (re-)embedded, so a second run
 * over an unchanged corpus writes nothing. Best-effort per batch — a provider
 * failure is counted and skipped, not thrown.
 */
export const embedWorkspaceUser = async (
  userId: string,
  deps: EmbedUserDeps = {},
): Promise<EmbedUserResult> => {
  const uid = new mongoose.Types.ObjectId(userId);
  const model = config.embeddings.model;

  const collected = await collectWorkspaceSlices(userId);
  const slices: EmbeddableSlice[] = collected.map((slice) => ({
    kind: slice.kind,
    id: slice.id,
    text: slice.text,
  }));

  const rows = await WorkspaceEmbedding.find({ model, userId: uid })
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

  const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts, { kind: 'passage' }));
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
