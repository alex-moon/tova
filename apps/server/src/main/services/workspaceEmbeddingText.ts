import { createHash } from 'crypto';

/* Single source of embed text, shared so hashes cannot diverge. */
// @see #294 #309

// Cap for the 512-token window; never an over-length input.
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

/* Metadata fold shared by ingest and backfill for byte-identical text. */
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

/* Truncate to the provider-safe cap; report whether cut. */
export const truncateForEmbedding = (
  text: string,
  cap = EMBEDDING_MAX_CHARS,
): { text: string; truncated: boolean } => {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
};

/* Skip identity: sha256 of model plus truncated embed text. */
export const embeddingTextHash = (text: string, model: string): string =>
  createHash('sha256').update(`${model}\n${text}`).digest('hex');
