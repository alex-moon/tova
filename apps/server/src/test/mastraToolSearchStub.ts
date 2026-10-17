/* Jest-only stub for `@mastra/core/processors` (ESM-only transitive deps). */
// @see #360
export interface ToolSearchProcessorOptions {
  tools: Record<string, unknown>;
  search?: { topK?: number; minScore?: number; autoLoad?: boolean };
}

export class ToolSearchProcessor {
  readonly options: ToolSearchProcessorOptions;
  constructor(options: ToolSearchProcessorOptions) {
    this.options = options;
  }
}
