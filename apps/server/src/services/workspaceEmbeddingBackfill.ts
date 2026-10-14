import { embeddingTextHash, truncateForEmbedding } from './workspaceEmbeddingText';

/*
 * #294: pure planning for the embedding backfill. The script
 * (`scripts/backfill-embeddings.ts`) owns the Mongo reads/writes and the
 * provider calls; this module owns the decision of *what* to embed, so the
 * idempotency rule is unit-testable without a database.
 *
 * The row key mirrors the model's unique index (`{ kind, sourceId, model }`).
 * A slice is re-embedded only when its `textHash` differs from the stored one,
 * so re-running over an unchanged corpus is a no-op.
 */

export type EmbeddableKind = 'chat' | 'file' | 'task';

export interface EmbeddableSlice {
  kind: EmbeddableKind;
  id: string;
  text: string;
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

/*
 * Build the `embeddingKey -> textHash` map the skip rule consults. `model`
 * defaults to the run's model: a row projection that omits `model` (the field
 * is redundant with the `find({ model })` filter that produced the rows) must
 * still key correctly, or the lookup falls through and the backfill re-embeds
 * every slice on every run. Keeping this here — not inline in the script —
 * makes that idempotency invariant unit-testable.
 */
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

/*
 * Decide which slices need a (re-)embed. `existingHashes` is keyed by
 * `embeddingKey`; a slice is skipped when its current hash already matches.
 * Slices with no embeddable text are counted separately and never embedded.
 */
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
    // `collectWorkspaceSlices` returns chat/task text untrimmed (it only
    // checks `.trim()` to skip blanks); the shared ingest helper
    // (`workspaceSliceText`) trims. Normalise here so both paths hash and embed
    // byte-identical text — otherwise the skip rule re-embeds every slice the
    // ingest path already wrote (and vice versa). Trimming the *collected*
    // text reproduces the helper exactly for all three kinds, which only ever
    // trim the final string.
    const { text, truncated: wasTruncated } = truncateForEmbedding(slice.text.trim());
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
