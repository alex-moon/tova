/* Jest stub for `@mastra/observability`: entrypoint and options builder. */

export class Observability {
  constructor(public readonly config: unknown) {}
}

type TracingOptions = Record<string, unknown>;
export type TracingOptionsUpdater = (options: TracingOptions) => TracingOptions;

export const buildTracingOptions = (...updaters: TracingOptionsUpdater[]): TracingOptions =>
  updaters.reduce<TracingOptions>((acc, updater) => updater(acc), {});
