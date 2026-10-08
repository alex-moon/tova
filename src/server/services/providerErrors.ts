/*
 * #213: provider error classification shared by the racing runtime
 * (`racingService.ts`, via `modelFailover.ts`) and the diagnostics tally
 * (`modelErrorTally.ts`).
 *
 * Kept in a leaf module (no service imports) so both callers can use it
 * without an import cycle: `modelErrorTally` → `inferenceService` is already
 * reached from `racingService` via `inferenceService`.
 */

/*
 * Endpoint overload is a *per-endpoint transient* failure, distinct from an
 * account rate limit even though both can arrive as HTTP 429. DeepInfra
 * reports it as `code: "engine_overloaded"` / "Model busy, retry later" in the
 * response body.
 *
 * Detection is body-first (AI-SDK `APICallError` exposes the parsed body as
 * `data` and/or `responseBody`), then a narrow message fallback for the
 * Mastra-wrapped error shape observed in the ticket. The message set is
 * deliberately small: "rate limit" / TPM / RPM wording must never match here.
 */
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
