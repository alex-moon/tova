/* Per-completion tool degradation: a failed tool short-circuits to a degraded result on retries within the same completion; null-context call-sites no-op. */
// @see #82

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

// Mark a tool failed for this completion; the reason is remembered so retries report the original failure.
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

// Bound any error to a short single-line reason; errors can carry long multi-line payloads.
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

// The tool result is the only channel to tell the model the tool failed; auth-flavoured failures add the re-connect pointer.
// @see #82 #333
const AUTH_FLAVORED =
  /401|403|invalid_token|unauthorized|needs-reauth|not connected|unreachable|fetch failed|ECONNREFUSED/i;

export const degradedToolError = (toolId: string, reason?: string): string =>
  `Tool ${toolId} failed to run${
    reason ? `: ${reason}` : ' (reason unknown)'
  }. It is unavailable for the rest of this completion — tell the user you tried to use it but it could not be used.${
    reason && AUTH_FLAVORED.test(reason)
      ? ' The connector providing this tool may need re-connecting in the Connectors view.'
      : ''
  }`;
