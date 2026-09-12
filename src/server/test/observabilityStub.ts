/*
 * Jest stub: `@mastra/observability` (see `mastraCoreStub.ts`). The two
 * exported bits mirror the real API used by `mastraService.ts`: the
 * registry entrypoint class and the tracing-options builder that folds
 * `TracingOptionsUpdater`s onto the call's tracing options.
 */

export class Observability {
  constructor(public readonly config: unknown) {}
}

type TracingOptions = Record<string, unknown>;
export type TracingOptionsUpdater = (options: TracingOptions) => TracingOptions;

export const buildTracingOptions = (...updaters: TracingOptionsUpdater[]): TracingOptions =>
  updaters.reduce<TracingOptions>((acc, updater) => updater(acc), {});
