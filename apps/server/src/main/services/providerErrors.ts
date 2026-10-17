/* Provider error classification shared by the racing runtime and the diagnostics tally; leaf module (no service imports) so both callers avoid an import cycle. */
// @see #213

/* Endpoint overload is a per-endpoint transient, distinct from an account rate limit even though both can arrive as 429; detection is body-first with a narrow message fallback that must never match rate-limit wording. */
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
