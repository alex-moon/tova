/*
 * Per-completion tool degradation (#82). Tool `execute` wrappers receive
 * Mastra's request context as their second argument (a fresh `RequestContext`
 * per completion call, pinned by mastraRequestContext.test.ts), which is the
 * natural per-completion scope: a tool that fails once is marked failed there
 * and short-circuits to a degraded result on every retry inside the same
 * completion, without another handshake or network round trip.
 *
 * Both entry points tolerate a null/undefined or contextless call-site by
 * no-oping / returning false, so legacy callers passing nothing do not break.
 */

const TOOL_FAILURES_KEY = 'toolFailures';

interface DegradeContextShape {
  requestContext?: {
    get?: (key: string) => unknown;
    set?: (key: string, value: unknown) => void;
  };
}

const failureMapOn = (ctx: unknown): Map<string, string> | undefined => {
  const requestContext = (ctx as DegradeContextShape | null | undefined)?.requestContext;
  if (typeof requestContext?.get !== 'function' || typeof requestContext?.set !== 'function')
    return undefined;
  const existing = requestContext.get(TOOL_FAILURES_KEY);
  if (existing instanceof Map) return existing as Map<string, string>;
  const fresh = new Map<string, string>();
  requestContext.set(TOOL_FAILURES_KEY, fresh);
  return fresh;
};

// Mark a tool failed for this completion. The optional reason is remembered
// so a short-circuited retry reports the original failure, not a placeholder.
export const markToolFailed = (ctx: unknown, toolId: string, reason?: string): void => {
  const map = failureMapOn(ctx);
  if (!map) return;
  // Re-marking keeps the recorded reason: the first failure is the honest one.
  if (!map.has(toolId)) map.set(toolId, reason || 'reason unknown');
};

export const toolIsFailed = (ctx: unknown, toolId: string): boolean =>
  failureMapOn(ctx)?.has(toolId) ?? false;

export const toolDegradeReason = (ctx: unknown, toolId: string): string =>
  failureMapOn(ctx)?.get(toolId) || 'reason unknown';

// Bound any error to a short, single-line, human-readable reason. Errors
// can carry long multi-line payloads (HTTP dumps, stack fragments); the
// collapse keeps the tool result compact and model-friendly.
const REASON_MAX_CHARS = 255;

export const reasonFrom = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!raw) return 'reason unknown';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'reason unknown';
  return collapsed.length > REASON_MAX_CHARS
    ? `${collapsed.slice(0, REASON_MAX_CHARS - 3)}...`
    : collapsed;
};

// The model-facing degraded result text (#82): the only channel we own for
// "the model surfaces that it tried to use the tool but it failed" is the
// tool result itself, so the instruction rides in the text.
export const degradedToolError = (toolId: string, reason?: string): string =>
  `Tool ${toolId} failed to run${
    reason ? `: ${reason}` : ' (reason unknown)'
  }. It is unavailable for the rest of this completion — tell the user you tried to use it but it could not be used.`;
