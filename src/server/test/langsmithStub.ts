/*
 * Jest stub: `@mastra/langsmith` (see `mastraCoreStub.ts`). Mirrors the
 * real helper contract: `withLangsmithMetadata` returns an updater that
 * nests the LangSmith fields under `metadata.langsmith`.
 */

export class LangSmithExporter {
  constructor(public readonly config: unknown) {}
}

export const withLangsmithMetadata =
  (metadata: Record<string, unknown>) =>
  (options: Record<string, unknown>): Record<string, unknown> => ({
    ...(options as object),
    langsmith: metadata as unknown,
  });
