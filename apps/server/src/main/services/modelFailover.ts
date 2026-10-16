/*
 * #233: provider error classification. Formerly the tier-era serial failover
 * loop's discriminator; the loop (`withModelFailover`) is gone with the tier
 * router (#232/#233), but the racing runtime (`racingService.ts`) reuses the
 * same retry/abort/test-not-fail decisions:
 *
 * - client aborts: the user hung up; the endpoint never failed.
 * - prompt-size errors: the 413 family is a prompt-shape problem surfaced with
 *   its own actionable message — disabling a healthy endpoint for hours on a
 *   single oversized prompt would be wrong.
 * - rate-limit errors: 429 gets a back-off mechanism (deferred); until then it
 *   fails the turn loudly without disabling the endpoint.
 *
 * `isOverloadError` (#213) lives in the leaf `providerErrors.ts` module so the
 * diagnostics tally can share it without an import cycle.
 */

export { isOverloadError } from './providerErrors';

export const isClientAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError');

/*
 * Mirrors the 413 discrimination in `streamingErrorMessage` (routes/chat.ts):
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

/*
 * Mirrors the 413 / "Request too large" detection in `streamingErrorMessage`
 * (routes/chat.ts). Kept here (not imported from the route) so services stay
 * free of route-import cycles.
 */
export const isPromptSizeError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return statusCode === 413 || /Request too large/.test(message);
};
