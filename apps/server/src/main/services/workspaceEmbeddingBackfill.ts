import { embeddingTextHash, truncateForEmbedding, withEmbedTitle } from './workspaceEmbeddingText';

/* Pure planning for the embedding backfill: the script owns Mongo/provider calls, this owns WHAT to embed so the idempotency rule (re-embed only when textHash differs) is unit-testable. */
// @see #294

export type EmbeddableKind = 'chat' | 'file' | 'task';

export interface EmbeddableSlice {
  kind: EmbeddableKind;
  id: string;
  text: string;
  // The slice title, folded into the embed text through `withEmbedTitle` — the same fold the ingest path applies, so hashed text stays byte-identical between the paths.
  // @see #309
  title?: string;
}

export interface PlannedEmbedding {
  kind: EmbeddableKind;
  sourceId: string;
  text: string;
  textHash: string;
  truncated: boolean;
}

export interface BackfillPlan {
  toEmbed: PlannedEmbedding[];
  skipped: number;
  empty: number;
  truncated: number;
  total: number;
}

export const embeddingKey = (kind: EmbeddableKind, sourceId: string, model: string): string =>
  `${kind}|${sourceId}|${model}`;

export interface ExistingEmbeddingRow {
  kind: string;
  sourceId: string;
  model?: string;
  textHash: string;
}

/* Build the `embeddingKey -> textHash` map the skip rule consults; `model` defaults per-row so a projection omitting the redundant field still keys correctly. */
// @see #294
export const existingEmbeddingHashes = (
  rows: ExistingEmbeddingRow[],
  model: string,
): Map<string, string> =>
  new Map(
    rows.map((row) => [
      embeddingKey(row.kind as EmbeddableKind, row.sourceId, row.model ?? model),
      row.textHash,
    ]),
  );

/* Decide which slices need a (re-)embed: skipped when the current hash matches; text-less slices counted separately, never embedded. */
export const planEmbeddingWrites = (
  slices: EmbeddableSlice[],
  existingHashes: ReadonlyMap<string, string>,
  model: string,
): BackfillPlan => {
  const toEmbed: PlannedEmbedding[] = [];
  let skipped = 0;
  let empty = 0;
  let truncated = 0;

  for (const slice of slices) {
    // Normalise so both paths hash and embed byte-identical text (otherwise the skip rule re-embeds everything the ingest path wrote); file slices fold their title in first via the same shared helper.
    // @see #309
    const { text, truncated: wasTruncated } = truncateForEmbedding(
      withEmbedTitle(slice.title, slice.text.trim()),
    );
    if (!text) {
      empty += 1;
      continue;
    }
    const textHash = embeddingTextHash(text, model);
    if (existingHashes.get(embeddingKey(slice.kind, slice.id, model)) === textHash) {
      skipped += 1;
      continue;
    }
    if (wasTruncated) truncated += 1;
    toEmbed.push({
      kind: slice.kind,
      sourceId: slice.id,
      text,
      textHash,
      truncated: wasTruncated,
    });
  }

  return { toEmbed, skipped, empty, truncated, total: slices.length };
};
