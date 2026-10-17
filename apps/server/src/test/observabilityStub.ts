/* Jest stub for `@mastra/observability`: the registry entrypoint class and the tracing-options builder folding TracingOptionsUpdaters onto the call's tracing options. */

export class Observability {
  constructor(public readonly config: unknown) {}
}

type TracingOptions = Record<string, unknown>;
export type TracingOptionsUpdater = (options: TracingOptions) => TracingOptions;

export const buildTracingOptions = (...updaters: TracingOptionsUpdater[]): TracingOptions =>
  updaters.reduce<TracingOptions>((acc, updater) => updater(acc), {});
