/* Jest stub for `@mastra/langsmith`: nests fields under metadata.langsmith. */

export class LangSmithExporter {
  constructor(public readonly config: unknown) {}
}

export const withLangsmithMetadata =
  (metadata: Record<string, unknown>) =>
  (options: Record<string, unknown>): Record<string, unknown> => ({
    ...(options as object),
    langsmith: metadata as unknown,
  });
