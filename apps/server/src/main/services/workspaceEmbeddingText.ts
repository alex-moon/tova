import { createHash } from 'crypto';

/* The one place a workspace slice's embed text is derived, shared by ingest and backfill so the hashed text cannot diverge (which would silently break the hash-skip rule); derivations mirror collectWorkspaceSlices. */
// @see #294 #309

// Conservative cap for the 512-token window, so the provider never receives an over-length input.
export const EMBEDDING_MAX_CHARS = 1800;

export type EmbeddingTextSource =
  | { kind: 'chat'; content: string | null | undefined }
  | {
      kind: 'file';
      filename?: string | null;
      markdownExtracted?: string | null;
      textExtracted?: string | null;
    }
  | { kind: 'task'; events: { role: string; content: string | null | undefined }[] };

/* The metadata fold shared by ingest and backfill so the hashed text stays byte-identical; only a file slice's title carries terms the content cannot supply. */
// @see #309
export const withEmbedTitle = (title: string | null | undefined, text: string): string => {
  const trimmed = (title ?? '').trim();
  return trimmed ? `${trimmed}\n${text}` : text;
};

export const workspaceSliceText = (source: EmbeddingTextSource): string => {
  switch (source.kind) {
    case 'chat':
      return (source.content ?? '').trim();
    case 'file':
      return withEmbedTitle(
        source.filename,
        ((source.markdownExtracted ?? '') || (source.textExtracted ?? '')).trim(),
      );
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

/* Truncate to the provider-safe cap; reports whether the text was cut so the backfill can report the truncation rate. */
export const truncateForEmbedding = (
  text: string,
  cap = EMBEDDING_MAX_CHARS,
): { text: string; truncated: boolean } => {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
};

/* Content identity for the skip decision: sha256 of the model plus the truncated embed text. */
export const embeddingTextHash = (text: string, model: string): string =>
  createHash('sha256').update(`${model}\n${text}`).digest('hex');
