import type { RoutingResult } from './routerService';
import { AllModelsDisabledError, disableModel } from './modelConfigService';
import { recordEndpointError } from './modelErrorStatsService';

export { ALL_MODELS_DISABLED_MESSAGE, AllModelsDisabledError } from './modelConfigService';

/*
 * Model-failure cool-off (#168): when a routed completion endpoint fails, the
 * failed model is immediately disabled for a cool-off period (see `disableModel`)
 * and the turn is re-routed against the freshly-excluded pool. When no
 * non-disabled models remain, the router fails with an end-user-visible message.
 *
 * Not retried / not disabling:
 * - client aborts: the user hung up; the endpoint never failed.
 * - prompt-size errors (`isPromptSizeErrors` below): the 413 family is a
 *   prompt-shape problem surfaced with its own actionable message — disabling
 *   a healthy endpoint for hours on a single oversized prompt would be wrong.
 * - rate-limit errors (#168, decision 2026-09-26): 429 gets a back-off
 *   mechanism, which is a separate mechanism from cool-off and does not
 *   exist yet — until it does, a 429 fails the turn loudly without
 *   disabling the endpoint (retry-looping into other models would drain the
 *   pool on rate limits, which is not a per-endpoint failure state).
 *
 * An `AllModelsDisabledError` escaping `route` (a pool that was already
 * drained by cool-off before this turn) passes through untouched.
 *
 * The guard classifier lives outside this path (`routeQuery` handles its own
 * error fallback); the cool-off applies to the tier pools (`disableModel`
 * writes `providerroutings.disabledUntil`, which every pool read excludes).
 */

export const isClientAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError');

/*
 * Mirrors the 413 / "Request too large" detection in `streamingErrorMessage`
 * 413 detection in `streamingErrorMessage` (routes/chat.ts). Kept here (not
 * imported from the route) so services stay free of route-import cycles.
 */
export const isPromptSizeError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return statusCode === 413 || /Request too large/.test(message);
};

/*
 * Mirrors the 429 discrimination in `streamingErrorMessage` (routes/chat.ts):
 * a status code when present, plus the Groq/Mastra message bodies that
 * rethrow without one. A stricter (narrower) matcher here would disable an
 * endpoint on a rate-limit-shaped error the route layer treats as a retry.
 */
export const isRateLimitError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return (
    statusCode === 429 ||
    /rate[ _-]?limit/i.test(message) ||
    /(tokens per minute|requests per minute)/i.test(message) ||
    /\bTPM\b|\bRPM\b|\btoo many requests\b/i.test(message)
  );
};

export interface FailoverOutcome<T> {
  routing: RoutingResult;
  completion: T;
}

/** Safety cap: one disable per attempt exhausts any sane pool long before. */
export const MAX_ATTEMPTS = 8;

export const withModelFailover = async <T>(
  route: () => Promise<RoutingResult>,
  invoke: (routing: RoutingResult) => Promise<T>,
): Promise<FailoverOutcome<T>> => {
  let disabledAny = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let routing: RoutingResult;
    try {
      routing = await route();
    } catch (err) {
      // Pool empty. Only retry-shaped when this loop already disabled
      // something — a pool that started empty is a config problem and keeps
      // its original loud error.
      if (disabledAny) throw new AllModelsDisabledError();
      throw err;
    }
    try {
      const completion = await invoke(routing);
      return { routing, completion };
    } catch (err) {
      if (isClientAbort(err)) throw err;
      // #168 diagnostics: every non-abort endpoint error is recorded —
      // including the 429/413 shapes below that deliberately do not disable —
      // so real connector error shapes accumulate per model (deploy wipes
      // the logs that would otherwise answer this).
      await recordEndpointError(routing.provider, routing.model, err);
      if (isPromptSizeError(err)) throw err;
      if (isRateLimitError(err)) throw err;
      lastError = err;
      const disabled = await disableModel(routing.provider, routing.model);
      if (!disabled) {
        // Cool-off write failed: the pool is unchanged, so a re-route would
        // re-pick the same broken endpoint — surface the original error.
        throw err;
      }
      disabledAny = true;
    }
  }
  throw lastError;
};
