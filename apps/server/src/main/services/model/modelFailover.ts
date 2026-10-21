/* Provider error classification: aborts, prompt size, rate limits. */
// @see #233 #232

export { isOverloadError } from '../providerErrors';

export const isClientAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError');

/* Mirrors streamingErrorMessage's rate-limit discrimination. */
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

/* Mirrors streamingErrorMessage's prompt-size detection. */
export const isPromptSizeError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';
  const statusCode = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  return statusCode === 413 || /Request too large/.test(message);
};
