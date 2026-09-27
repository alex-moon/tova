import { config } from '../config';
import type {
  AdminLangsmithModelStats,
  AdminLangsmithStatsPayload,
  AdminTraceDetail,
  AdminTraceRow,
  AdminTraceRun,
  AdminTracesPayload,
} from '../../shared/contracts';

/*
 * Read-only LangSmith query service for the admin Traces tab (#186).
 *
 * Sits next to `tracePurge.ts` and shares its raw-REST stance: x-api-key
 * header, project id resolved by name (name-match only — never fall back to
 * "first session returned"), no SDK. Where the purge is failure-tolerant and
 * silent, this is an interactive read path: failures surface as thrown
 * errors, the route maps them to 502, and a missing key/project is a first-
 * class "not configured" answer (null) rather than an error.
 *
 * Verified against the live API (2026-09-27):
 *  - POST /api/v1/runs/query answers { runs, ... } (an object, not an
 *    array — see #187 for the purge's array-cast bug).
 *  - Filters used here: eq(is_root, true), eq(status, "error"),
 *    eq(trace_id, ...), gte(start_time, ...), in(trace_id, [...]),
 *    eq(run_type, "llm"). Default order is newest-first.
 *  - Model identity lives on the `llm: '<model>'` child run name (chat
 *    turns carry no session metadata today), so every page of root runs is
 *    joined with one llm-children query. Token totals come from the same
 *    children: root-level `total_tokens` aggregates appear reliable without
 *    `select` but were observed as 0 with it, while child tokens are
 *    consistent in both shapes.
 *  - The API intermittently answers 429/5xx transiently: one retry after
 *    500ms, then the error propagates.
 */

const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
// Single wait before the one retry a transient 5xx gets (429s get the
// backoff budget in RETRY_WAITS_MS).
export const RETRY_WAIT_MS = 500;
// Per-attempt cap: a stalled LangSmith connection must never hang an
// admin request (the route holds the response open until this fires).
export const REQUEST_TIMEOUT_MS = 20_000;
// Stats window cap: enough depth for a dev project's weekly rollup while
// bounding the paged reads behind it.
const STATS_MAX_RUNS = 500;
// Trace detail cap: trees that exceeded this are truncated, not looped.
const DETAIL_MAX_RUNS = 200;
const ERROR_SNIPPET_CHARS = 300;

interface RawRun {
  id?: string;
  trace_id?: string;
  parent_run_id?: string | null;
  name?: string | null;
  run_type?: string | null;
  status?: string | null;
  error?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  total_tokens?: number | null;
  app_path?: string | null;
  inputs?: unknown;
  outputs?: unknown;
}

export class LangsmithError extends Error {
  constructor(
    message: string,
    public readonly response?: Response,
  ) {
    super(message);
    this.name = 'LangsmithError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_WAITS_MS = [1000, 2000, 4000];

// Minimal structural fetch options (Node's RequestInit DOM type is not in
// scope under the server eslint globals).
interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const fetchWithRetry = async (url: string, init: FetchInitLike): Promise<unknown> => {
  const attempt = async (): Promise<unknown> => {
    const res = await fetch(url, {
      ...init,
      // Hard cap per attempt — a stalled upstream connection must never
      // hang the admin request indefinitely.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const status = res.status;
      throw new LangsmithError(`LangSmith request failed: HTTP ${status}`, res);
    }
    return res.json();
  };
  try {
    return await attempt();
  } catch (err) {
    // The live API rate-limits (429) burstily and 5xxes transiently: retry
    // 429s with backoff (honoring a longer Retry-After), 5xx once after a
    // short wait. Real 4xx errors propagate immediately.
    if (!(err instanceof LangsmithError)) throw err;
    const status = Number(/HTTP (\d+)/.exec(err.message)?.[1]);
    const isRateLimit = status === 429;
    const isTransient = status >= 500;
    if (!isRateLimit && !isTransient) throw err;
    const retryAfterHeader = err.response?.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const waits = isRateLimit ? RETRY_WAITS_MS : [RETRY_WAIT_MS];
    for (const wait of waits) {
      await sleep(Number.isFinite(retryAfterSec) ? Math.max(wait, retryAfterSec * 1000) : wait);
      try {
        return await attempt();
      } catch (retryErr) {
        if (!(retryErr instanceof LangsmithError)) throw retryErr;
        const retryStatus = Number(/HTTP (\d+)/.exec(retryErr.message)?.[1]);
        if (retryStatus !== 429 && retryStatus < 500) throw retryErr;
      }
    }
    throw new LangsmithError(err.message);
  }
};

const queryRuns = (headers: Record<string, string>, projectId: string, body: object) =>
  fetchWithRetry(`${BASE_URL}/api/v1/runs/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session: [projectId], ...body }),
  }) as Promise<{ runs?: RawRun[] }>;

const resolveProject = async (headers: Record<string, string>, project: string) => {
  const res = (await fetchWithRetry(
    `${BASE_URL}/api/v1/sessions?name=${encodeURIComponent(project)}&limit=1`,
    { headers },
  )) as { id?: string; name?: string }[];
  // Name-match only (same rule as tracePurge): a fallback pick could read
  // runs from a project the config never named.
  if (!Array.isArray(res) || !res.some((s) => s.name === project && s.id)) {
    throw new LangsmithError(`project "${project}" not found`);
  }
  const match = res.find((s) => s.name === project) as { id: string; name: string };
  return { id: match.id, name: match.name };
};

// `llm: 'openai/gpt-oss-20b'` → `openai/gpt-oss-20b`; null for anything
// else so non-llm runs never report a model.
export const modelFromRunName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const match = /^llm: '(.+)'$/.exec(name);
  return match ? match[1] : null;
};

const durationMsOf = (run: RawRun): number | null => {
  if (!run.start_time || !run.end_time) return null;
  const ms = new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

const errorSnippet = (error: string | null | undefined): string | null =>
  error ? error.slice(0, ERROR_SNIPPET_CHARS) : null;

interface ModelJoin {
  modelOf: Map<string, string>;
  tokensOf: Map<string, number>;
}

// Safety cap for the join below: a busy page of tool-heavy traces (up to
// maxSteps llm calls each) must not loop forever on a pathological project.
const JOIN_MAX_PAGES = 10;

// One paged llm-children sweep over a page of root runs: supplies each
// trace's model and its token total (summed across the trace's llm calls —
// multi-step tool turns have one llm child per step, all of the same
// model).
const joinLlmChildren = async (
  headers: Record<string, string>,
  projectId: string,
  traceIds: string[],
): Promise<ModelJoin> => {
  const modelOf = new Map<string, string>();
  const tokensOf = new Map<string, number>();
  if (traceIds.length === 0) return { modelOf, tokensOf };

  const baseFilter = `in(trace_id, [${traceIds.map((id) => `"${id}"`).join(', ')}])`;
  for (let page = 0; page < JOIN_MAX_PAGES; page++) {
    const res = await queryRuns(headers, projectId, {
      filter: `and(${baseFilter}, eq(run_type, "llm"))`,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      select: ['trace_id', 'name', 'total_tokens'],
    });
    const children = res.runs ?? [];
    for (const run of children) {
      if (!run.trace_id) continue;
      const model = modelFromRunName(run.name);
      if (model && !modelOf.has(run.trace_id)) modelOf.set(run.trace_id, model);
      if (typeof run.total_tokens === 'number' && run.total_tokens > 0) {
        tokensOf.set(run.trace_id, (tokensOf.get(run.trace_id) ?? 0) + run.total_tokens);
      }
    }
    if (children.length < PAGE_SIZE) break;
  }
  return { modelOf, tokensOf };
};

const rootFilter = (errorsOnly: boolean) =>
  errorsOnly ? 'and(eq(is_root, true), eq(status, "error"))' : 'eq(is_root, true)';

const toTraceRow = (run: RawRun, join: ModelJoin): AdminTraceRow | null => {
  if (!run.id || !run.trace_id) return null;
  return {
    id: run.id,
    traceId: run.trace_id,
    name: run.name ?? '',
    status: run.status ?? 'unknown',
    model: join.modelOf.get(run.trace_id) ?? null,
    startedAt: run.start_time ?? '',
    durationMs: durationMsOf(run),
    totalTokens: join.tokensOf.get(run.trace_id) ?? null,
    error: errorSnippet(run.error),
    ...(run.app_path ? { appPath: run.app_path } : {}),
  };
};

const headersFor = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  'Content-Type': 'application/json',
});

export interface ListTracesParams {
  errorsOnly?: boolean;
  model?: string;
  limit?: number;
}

// Recent root runs, newest first, with the model filter applied post-merge
// (the model lives on a child run name — a server-side filter would mean
// fragile filter-string quoting for no gain at this window size).
export const listTraces = async (
  params: ListTracesParams = {} as ListTracesParams,
): Promise<AdminTracesPayload | null> => {
  const apiKey = config.langsmith.apiKey;
  const project = config.langsmith.project;
  if (!apiKey || !project) return null;

  const headers = headersFor(apiKey);
  const resolved = await resolveProject(headers, project);

  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const res = await queryRuns(headers, resolved.id, {
    filter: rootFilter(Boolean(params.errorsOnly)),
    limit,
    select: ['id', 'trace_id', 'name', 'status', 'error', 'start_time', 'end_time', 'app_path'],
  });
  const roots = res.runs ?? [];
  const join = await joinLlmChildren(
    headers,
    resolved.id,
    roots.map((r) => r.trace_id).filter((id): id is string => Boolean(id)),
  );

  const traces = roots
    .map((run) => toTraceRow(run, join))
    .filter((row): row is AdminTraceRow => row !== null)
    .filter((row) => !params.model || row.model === params.model)
    .slice(0, limit);

  return { project: resolved, traces };
};

// Full run set of one trace, `chunk:` streaming artifacts dropped (dozens
// per turn, zero duration, no diagnostic value), oldest first so the client
// can render the tree top-down. Pages by PAGE_SIZE — the API rejects any
// per-query limit above 100 (verified live: 101 → 400). Returns an empty
// run list for an unknown trace id — the route distinguishes that as a 404.
export const getTrace = async (traceId: string): Promise<AdminTraceDetail | null> => {
  const apiKey = config.langsmith.apiKey;
  const project = config.langsmith.project;
  if (!apiKey || !project) return null;

  const headers = headersFor(apiKey);
  const resolved = await resolveProject(headers, project);

  const raw: RawRun[] = [];
  const filter = `eq(trace_id, "${traceId}")`;
  for (let offset = 0; offset < DETAIL_MAX_RUNS; offset += PAGE_SIZE) {
    const res = await queryRuns(headers, resolved.id, { filter, limit: PAGE_SIZE, offset });
    const page = res.runs ?? [];
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const kept = raw
    .filter((run) => !run.name?.startsWith('chunk:'))
    .sort((a, b) => new Date(a.start_time ?? 0).getTime() - new Date(b.start_time ?? 0).getTime());

  const runs: AdminTraceRun[] = [];
  for (const run of kept) {
    if (!run.id) continue;
    runs.push({
      id: run.id,
      parentId: run.parent_run_id ?? null,
      name: run.name ?? '',
      runType: run.run_type ?? 'unknown',
      status: run.status ?? 'unknown',
      model: modelFromRunName(run.name),
      startedAt: run.start_time ?? '',
      endedAt: run.end_time ?? null,
      durationMs: durationMsOf(run),
      totalTokens: typeof run.total_tokens === 'number' ? run.total_tokens : null,
      error: errorSnippet(run.error),
      inputs: run.inputs ?? null,
      outputs: run.outputs ?? null,
    });
  }
  return { traceId, runs };
};

/*
 * Per-model rollup since `days` ago, aggregated from llm runs directly.
 *
 * Why llm runs and not root turns: the model identity and token counts live
 * on the llm children, so a root-based rollup would need a children-join
 * per page (multiplying requests against a burstily rate-limited API — the
 * first live smoke test of that shape hung for minutes). One paged sweep of
 * llm runs answers per-model health in ~STATS_MAX_RUNS/PAGE_SIZE + 2 calls.
 *
 * Semantics, kept honest in the contract: rows count llm *calls* (a tool
 * turn makes several to the same model), and turns that failed before any
 * llm call do not appear here — the traces list's errors-only filter covers
 * turn-level failures.
 */
export const traceStats = async (days = 7): Promise<AdminLangsmithStatsPayload | null> => {
  const apiKey = config.langsmith.apiKey;
  const project = config.langsmith.project;
  if (!apiKey || !project) return null;

  const headers = headersFor(apiKey);
  const resolved = await resolveProject(headers, project);

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const filter = `and(eq(run_type, "llm"), gte(start_time, "${since}"))`;

  const byModel = new Map<
    string,
    {
      model: string;
      calls: number;
      errors: number;
      totalTokens: number;
      durationSum: number;
      durationCount: number;
    }
  >();
  const totals = { calls: 0, errors: 0, totalTokens: 0 };

  for (let offset = 0; offset < STATS_MAX_RUNS; offset += PAGE_SIZE) {
    const res = await queryRuns(headers, resolved.id, {
      filter,
      limit: PAGE_SIZE,
      offset,
      select: ['name', 'status', 'start_time', 'end_time', 'total_tokens'],
    });
    const llmRuns = res.runs ?? [];
    if (llmRuns.length === 0) break;

    for (const run of llmRuns) {
      const model = modelFromRunName(run.name);
      if (!model) continue;
      const duration = durationMsOf(run);
      const tokens = typeof run.total_tokens === 'number' ? run.total_tokens : 0;
      const isError = run.status === 'error';

      const entry = byModel.get(model) ?? {
        model,
        calls: 0,
        errors: 0,
        totalTokens: 0,
        durationSum: 0,
        durationCount: 0,
      };
      entry.calls += 1;
      if (isError) entry.errors += 1;
      entry.totalTokens += tokens;
      if (duration !== null) {
        entry.durationSum += duration;
        entry.durationCount += 1;
      }
      byModel.set(model, entry);

      totals.calls += 1;
      if (isError) totals.errors += 1;
      totals.totalTokens += tokens;
    }

    if (llmRuns.length < PAGE_SIZE) break;
  }

  const models: AdminLangsmithModelStats[] = [...byModel.values()]
    .map(({ durationSum, durationCount, ...stats }) => ({
      ...stats,
      avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls);

  return { since, models, totals };
};
