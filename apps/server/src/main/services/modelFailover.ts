/* Provider error classification: client aborts are hangups, prompt-size errors are prompt-shape problems, rate limits fail loudly without disabling the endpoint. */
// @see #233 #232

export { isOverloadError } from './providerErrors';

export const isClientAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError');

/* Mirrors the 413 discrimination in streamingErrorMessage: a stricter matcher would disable an endpoint on a rate-limit-shaped error the route layer treats as a retry. */
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

/* Mirrors the prompt-size detection in streamingErrorMessage; kept here so services stay free of route-import cycles. */
export const isPromptSizeError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return statusCode === 413 || /Request too large/.test(message);
};
