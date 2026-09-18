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

const failureSetOn = (ctx: unknown): Set<string> | undefined => {
  const requestContext = (ctx as DegradeContextShape | null | undefined)?.requestContext;
  if (typeof requestContext?.get !== 'function' || typeof requestContext?.set !== 'function')
    return undefined;
  const existing = requestContext.get(TOOL_FAILURES_KEY);
  if (existing instanceof Set) return existing as Set<string>;
  const fresh = new Set<string>();
  requestContext.set(TOOL_FAILURES_KEY, fresh);
  return fresh;
};

export const markToolFailed = (ctx: unknown, toolId: string): void => {
  failureSetOn(ctx)?.add(toolId);
};

export const toolIsFailed = (ctx: unknown, toolId: string): boolean =>
  failureSetOn(ctx)?.has(toolId) ?? false;

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
