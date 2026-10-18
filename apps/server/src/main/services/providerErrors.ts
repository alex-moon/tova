/* Provider error classification; leaf module (no service imports). */
// @see #213

/* Overload is a per-endpoint transient, not an account rate limit. */
// @see #213
const providerErrorCode = (err: unknown): string => {
  const carrier = err as
    { data?: { error?: { code?: unknown } }; responseBody?: unknown } | null | undefined;
  const fromData = carrier?.data?.error?.code;
  if (typeof fromData === 'string') return fromData;
  const body = carrier?.responseBody;
  const raw = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  const match = /"code"\s*:\s*"([^"]+)"/.exec(raw);
  return match?.[1] ?? '';
};

export const isOverloadError = (err: unknown): boolean => {
  if (providerErrorCode(err).toLowerCase() === 'engine_overloaded') return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /engine[ _-]?overloaded|model busy,? retry later|\boverloaded\b/i.test(message);
};
