import type { NeutralStreamChunk } from './llmTypes';

/* Tool-chip builders shared by the chat route and the task sequencer:
 * provider-neutral summaries both paths persist as identical chips. */
// @see #33 #196 #254 #398

// Provider-neutral tool outcome summaries for the SSE 'tool' events.
// @see #33
const toolLabelFrom = (name: string): string =>
  name === 'web_search'
    ? 'Searched the web'
    : name === 'fetch_url'
      ? 'Fetched the page'
      : name === 'list_files'
        ? 'Listed your files'
        : name === 'read_file'
          ? 'Read a file'
          : name === 'generate_file'
            ? 'Created a file'
            : name === 'edit_file'
              ? 'Updated a file'
              : name === 'search_tools'
                ? 'Searched connected tools'
                : name || 'Tool run';

const toolCallEvent = (call: NonNullable<NeutralStreamChunk['toolCall']>) => ({
  phase: 'call' as const,
  name: call.name,
  label: toolLabelFrom(call.name),
  ...(typeof call.args?.query === 'string' && call.args.query ? { query: call.args.query } : {}),
});

const domainsFrom = (urls: string[]): string[] => {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // Malformed URL: skip silently.
    }
  }
  return [...hosts].slice(0, 5);
};

// Chip counts: per-tool semantics, not a count-every-array heuristic.
// @see #114
const singleArrayFieldLength = (result: unknown): number | null => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const arrayFields = Object.values(result).filter((value) => Array.isArray(value));
  return arrayFields.length === 1 ? (arrayFields[0] as unknown[]).length : null;
};

type ToolCallEvent = ReturnType<typeof toolCallEvent>;
type ToolResultEvent = ReturnType<typeof toolResultEvent>;

// Unresolved calls stay phase 'call'; resolved ones carry the result.
// @see #196
export type PersistedToolEvent = (ToolCallEvent | ToolResultEvent) & { query?: string };

/* Merge a result into the latest unresolved like-named call; else append. */
// @see #196
export const reconcileToolEvent = <T extends PersistedToolEvent>(
  list: T[],
  ev: PersistedToolEvent,
): T[] => {
  if (ev.phase === 'result') {
    for (let i = list.length - 1; i >= 0; i--) {
      const candidate = list[i];
      if (candidate.phase === 'call' && candidate.name === ev.name) {
        list[i] = {
          ...ev,
          ...(candidate.query ? { query: candidate.query } : {}),
        } as T;
        return list;
      }
    }
  }
  list.push(ev as T);
  return list;
};

// Shared with the task sequencer so both paths build identical chips.
// @see #254 #196
export const toolResultEvent = (result: {
  name: string;
  result: unknown;
  args?: Record<string, unknown>;
}) => {
  const base = {
    phase: 'result' as const,
    name: result.name,
    label: toolLabelFrom(result.name),
    ...(typeof result.args?.query === 'string' && result.args.query
      ? { query: result.args.query }
      : {}),
  };
  if (result.name === 'web_search' || result.name === 'fetch_url') {
    const items = Array.isArray((result.result as { results?: unknown })?.results)
      ? (result.result as { results: unknown[] }).results
      : [];
    const urls = items
      .map((item) => (item as { url?: unknown } | null)?.url)
      .filter((url): url is string => typeof url === 'string' && url !== '');
    const hasResults = Array.isArray((result.result as { results?: unknown })?.results);
    return {
      ...base,
      status: urls.length > 0 ? ('ok' as const) : ('empty' as const),
      ...(hasResults ? { resultCount: items.length } : {}),
      ...(urls.length > 0 ? { domains: domainsFrom(urls) } : {}),
    };
  }
  if (result.name === 'generate_file') {
    const payload = result.result as { file?: { filename?: unknown }; error?: unknown } | null;
    const filename = payload?.file?.filename;
    if (payload && typeof payload.error === 'string') {
      return { ...base, status: 'empty' as const };
    }
    return {
      ...base,
      status: 'ok' as const,
      ...(typeof filename === 'string' && filename !== '' ? { filename } : {}),
    };
  }
  if (result.name === 'edit_file') {
    const payload = result.result as { file?: { filename?: unknown }; error?: unknown } | null;
    const filename = payload?.file?.filename;
    if (payload && typeof payload.error === 'string') {
      return { ...base, status: 'empty' as const };
    }
    return {
      ...base,
      status: 'ok' as const,
      ...(typeof filename === 'string' && filename !== '' ? { filename } : {}),
    };
  }
  if (result.name === 'list_files') {
    const payload = result.result as { files?: unknown; error?: unknown } | null;
    const files = Array.isArray(payload?.files) ? (payload?.files as unknown[]) : null;
    if (payload && typeof payload.error === 'string' && (!files || files.length === 0)) {
      // Degraded: empty files + error → no count.
      // @see #114
      return { ...base, status: 'empty' as const };
    }
    const count = files?.length ?? 0;
    return {
      ...base,
      status: count > 0 ? ('ok' as const) : ('empty' as const),
      resultCount: count,
    };
  }
  const count = singleArrayFieldLength(result.result);
  return {
    ...base,
    status: 'ok' as const,
    ...(count !== null ? { resultCount: count } : {}),
  };
};

export { toolCallEvent };
