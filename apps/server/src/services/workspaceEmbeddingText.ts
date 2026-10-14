import { createHash } from 'crypto';

/*
 * #294: the one place a workspace slice's embed text is derived. Both the
 * ingest hooks and the backfill go through `workspaceSliceText`, so the text
 * that gets embedded can never diverge between the two paths — which would
 * otherwise make the `textHash` skip logic wrong and silently re-embed (or
 * never re-embed) a slice.
 *
 * The derivations mirror `collectWorkspaceSlices`:
 *   chat -> the message content
 *   file -> markdownExtracted, falling back to textExtracted
 *   task -> the user/assistant TaskEvent contents joined in `seq` order
 *           (system notices are visible-only and never embedded)
 */

// Conservative cap for `bge-base-en-v1.5`'s 512-token window (~3.5 chars/token
// in English). Truncating client-side means the provider never receives an
// over-length input, whatever its own behaviour on one.
export const EMBEDDING_MAX_CHARS = 1800;

export type EmbeddingTextSource =
  | { kind: 'chat'; content: string | null | undefined }
  | {
      kind: 'file';
      markdownExtracted?: string | null;
      textExtracted?: string | null;
    }
  | { kind: 'task'; events: { role: string; content: string | null | undefined }[] };

export const workspaceSliceText = (source: EmbeddingTextSource): string => {
  switch (source.kind) {
    case 'chat':
      return (source.content ?? '').trim();
    case 'file':
      return ((source.markdownExtracted ?? '') || (source.textExtracted ?? '')).trim();
    case 'task':
      return source.events
        .filter(
          (event) =>
            (event.role === 'user' || event.role === 'assistant') &&
            (event.content ?? '').trim().length > 0,
        )
        .map((event) => event.content as string)
        .join('\n')
        .trim();
  }
};

/*
 * Truncate to the provider-safe cap before embedding. Returns whether the
 * text was cut so the backfill can report the truncation rate (the #289
 * corpus cannot yet measure the dilution this causes).
 */
export const truncateForEmbedding = (
  text: string,
  cap = EMBEDDING_MAX_CHARS,
): { text: string; truncated: boolean } => {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
};

/*
 * Content identity for the skip decision: sha256 of the model plus the
 * (already-truncated) embed text. Re-running the backfill over an unchanged
 * corpus produces the same hash and is a no-op.
 */
export const embeddingTextHash = (text: string, model: string): string =>
  createHash('sha256').update(`${model}\n${text}`).digest('hex');
