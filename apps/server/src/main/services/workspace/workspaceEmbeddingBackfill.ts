import { embeddingTextHash, truncateForEmbedding, withEmbedTitle } from './workspaceEmbeddingText';

/* Pure backfill planning: this owns WHAT to embed; the script owns IO. */
// @see #294

export type EmbeddableKind = 'chat' | 'file' | 'task';

export interface EmbeddableSlice {
  kind: EmbeddableKind;
  id: string;
  text: string;
  // Only file titles fold (ingest parity); chat/task embed bare text.
  // @see #309 #393
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

/* The embeddingKey -> textHash map the skip rule consults. */
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

/* Skip when the current hash matches; text-less slices count, never embed. */
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
    // Ingest folds titles for files only; the planner must hash the same text.
    // @see #309 #393
    const body = slice.text.trim();
    const { text, truncated: wasTruncated } = truncateForEmbedding(
      slice.kind === 'file' ? withEmbedTitle(slice.title, body) : body,
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
