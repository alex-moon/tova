/* Jest-only stub for `@mastra/core/processors` (ESM-only transitive deps); suites assert on the options the service passes to the processor, so the constructor is captured as plain data. */
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
