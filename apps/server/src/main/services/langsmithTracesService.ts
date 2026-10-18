import { config } from '../config';
import type {
  AdminLangsmithModelStats,
  AdminLangsmithStatsPayload,
  AdminTraceDetail,
  AdminTraceRow,
  AdminTraceRun,
  AdminTracesPayload,
} from '@tova/shared';

/* Read-only LangSmith REST queries for the admin Traces tab (no SDK). */
// @see #186 #237 #187

const BASE_URL = 'https://api.smith.langchain.com';
const PAGE_SIZE = 100;
// Wait before the one retry a transient 5xx gets (429s use RETRY_WAITS_MS).
export const RETRY_WAIT_MS = 500;
// Per-attempt cap: a stalled connection must never hang an admin request.
export const REQUEST_TIMEOUT_MS = 20_000;
// Stats window cap: enough depth for a weekly rollup.
const STATS_MAX_RUNS = 500;
// Trace detail cap: trees beyond this are truncated, not looped.
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
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  app_path?: string | null;
  inputs?: unknown;
  outputs?: unknown;
  /* `extra.metadata` carries the MODEL_GENERATION span attributes. */
  // @see #237
  extra?: { metadata?: Record<string, unknown> } | null;
  /* TTFT: `first_token_time - start_time`; absent non-streaming. */
  // @see #237
  first_token_time?: string | null;
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

// Minimal structural fetch options; RequestInit is not in scope here.
interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const fetchWithRetry = async (url: string, init: FetchInitLike): Promise<unknown> => {
  const attempt = async (): Promise<unknown> => {
    const res = await fetch(url, {
      ...init,
      // Hard cap per attempt; a stalled connection must not hang the request.
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
    // Retry 429s with backoff, 5xx once; real 4xx propagate immediately.
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
  // Name-match only (as tracePurge): never fall back to another project.
  if (!Array.isArray(res) || !res.some((s) => s.name === project && s.id)) {
    throw new LangsmithError(`project "${project}" not found`);
  }
  const match = res.find((s) => s.name === project) as { id: string; name: string };
  return { id: match.id, name: match.name };
};

// `llm: '...'` run name → the model id; null for anything else.
export const modelFromRunName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const match = /^llm: '(.+)'$/.exec(name);
  return match ? match[1] : null;
};

/* Map Mastra's `fireworks-ai` id back to the roster's `fireworks`. */
// @see #237
const MASTRA_PROVIDER_ALIASES: Record<string, string> = { 'fireworks-ai': 'fireworks' };

// Provider from `ls_provider` span metadata; null when absent.
// @see #237
export const providerFromRun = (run: RawRun): string | null => {
  const provider = run.extra?.metadata?.ls_provider;
  if (typeof provider !== 'string' || provider.length === 0) return null;
  return MASTRA_PROVIDER_ALIASES[provider] ?? provider;
};

// Time-to-first-token from `first_token_time`; null non-streaming.
// @see #237
export const ttftMsOf = (run: RawRun): number | null => {
  if (!run.start_time || !run.first_token_time) return null;
  const ms = new Date(run.first_token_time).getTime() - new Date(run.start_time).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/* Aborted race loser, not a real failure; excluded from stats. */
// @see #237
export const isAbortedRun = (run: RawRun): boolean => {
  const error = run.error ?? '';
  return /abort|cancel/i.test(error) || /AbortError|CanceledError/.test(error);
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
  providerOf: Map<string, string>;
  tokensOf: Map<string, number>;
}

// Safety cap: a pathological project must not loop the join forever.
const JOIN_MAX_PAGES = 10;

// Paged llm-children sweep joining each trace's model + token total.
const joinLlmChildren = async (
  headers: Record<string, string>,
  projectId: string,
  traceIds: string[],
): Promise<ModelJoin> => {
  const modelOf = new Map<string, string>();
  const providerOf = new Map<string, string>();
  const tokensOf = new Map<string, number>();
  if (traceIds.length === 0) return { modelOf, providerOf, tokensOf };

  const baseFilter = `in(trace_id, [${traceIds.map((id) => `"${id}"`).join(', ')}])`;
  for (let page = 0; page < JOIN_MAX_PAGES; page++) {
    const res = await queryRuns(headers, projectId, {
      filter: `and(${baseFilter}, eq(run_type, "llm"))`,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      // `extra` carries `ls_provider`; the model still comes from the name.
      // @see #237
      select: ['trace_id', 'name', 'total_tokens', 'extra'],
    });
    const children = res.runs ?? [];
    for (const run of children) {
      if (!run.trace_id) continue;
      const model = modelFromRunName(run.name);
      if (model && !modelOf.has(run.trace_id)) modelOf.set(run.trace_id, model);
      const provider = providerFromRun(run);
      if (provider && !providerOf.has(run.trace_id)) providerOf.set(run.trace_id, provider);
      if (typeof run.total_tokens === 'number' && run.total_tokens > 0) {
        tokensOf.set(run.trace_id, (tokensOf.get(run.trace_id) ?? 0) + run.total_tokens);
      }
    }
    if (children.length < PAGE_SIZE) break;
  }
  return { modelOf, providerOf, tokensOf };
};

const rootFilter = (errorsOnly: boolean) =>
  errorsOnly ? 'and(eq(is_root, true), eq(status, "error"))' : 'eq(is_root, true)';

// Workspace-memory metadata keys on the root run's trace metadata.
// @see #308
const WORKSPACE_GATES = new Set(['yes', 'no', 'timeout', 'off']);

const workspaceFactsOf = (
  run: RawRun,
): { workspaceGate?: 'yes' | 'no' | 'timeout' | 'off'; workspaceHits?: number } => {
  const meta = run.extra?.metadata;
  if (!meta) return {};
  const facts: { workspaceGate?: 'yes' | 'no' | 'timeout' | 'off'; workspaceHits?: number } = {};
  if (
    typeof meta.tova_workspace_gate === 'string' &&
    WORKSPACE_GATES.has(meta.tova_workspace_gate)
  ) {
    facts.workspaceGate = meta.tova_workspace_gate as 'yes' | 'no' | 'timeout' | 'off';
  }
  if (typeof meta.tova_workspace_hits === 'number' && Number.isFinite(meta.tova_workspace_hits)) {
    facts.workspaceHits = meta.tova_workspace_hits;
  }
  return facts;
};

const toTraceRow = (run: RawRun, join: ModelJoin): AdminTraceRow | null => {
  if (!run.id || !run.trace_id) return null;
  return {
    id: run.id,
    traceId: run.trace_id,
    name: run.name ?? '',
    status: run.status ?? 'unknown',
    model: join.modelOf.get(run.trace_id) ?? null,
    provider: join.providerOf.get(run.trace_id) ?? null,
    startedAt: run.start_time ?? '',
    durationMs: durationMsOf(run),
    totalTokens: join.tokensOf.get(run.trace_id) ?? null,
    error: errorSnippet(run.error),
    ...(run.app_path ? { appPath: run.app_path } : {}),
    ...workspaceFactsOf(run),
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

// Recent root runs, newest first; the model filter applies post-merge.
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
    // `extra` carries the workspace metadata the row surfaces.
    // @see #308
    select: [
      'id',
      'trace_id',
      'name',
      'status',
      'error',
      'start_time',
      'end_time',
      'app_path',
      'extra',
    ],
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

// Full run set of one trace, `chunk:` artifacts dropped, oldest first.
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
      provider: providerFromRun(run),
      startedAt: run.start_time ?? '',
      endedAt: run.end_time ?? null,
      durationMs: durationMsOf(run),
      ttftMs: ttftMsOf(run),
      totalTokens: typeof run.total_tokens === 'number' ? run.total_tokens : null,
      error: errorSnippet(run.error),
      inputs: run.inputs ?? null,
      outputs: run.outputs ?? null,
    });
  }
  return { traceId, runs };
};

/* Per-(model, provider) rollup from llm runs; aborted losers excluded. */
// @see #237 #224
export const traceStats = async (days = 7): Promise<AdminLangsmithStatsPayload | null> => {
  const apiKey = config.langsmith.apiKey;
  const project = config.langsmith.project;
  if (!apiKey || !project) return null;

  const headers = headersFor(apiKey);
  const resolved = await resolveProject(headers, project);

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const filter = `and(eq(run_type, "llm"), gte(start_time, "${since}"))`;

  const byKey = new Map<
    string,
    {
      model: string;
      provider: string | null;
      calls: number;
      errors: number;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      durationSum: number;
      durationCount: number;
      ttftSum: number;
      ttftCount: number;
    }
  >();
  const totals = { calls: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 };

  // Stable key for `(model, provider)`; the provider is null for a legacy run.
  const keyOf = (model: string, provider: string | null): string =>
    `${model}\u0000${provider ?? ''}`;

  for (let offset = 0; offset < STATS_MAX_RUNS; offset += PAGE_SIZE) {
    const res = await queryRuns(headers, resolved.id, {
      filter,
      limit: PAGE_SIZE,
      offset,
      select: [
        'name',
        'status',
        'error',
        'start_time',
        'end_time',
        'total_tokens',
        'prompt_tokens',
        'completion_tokens',
        'first_token_time',
        'extra',
      ],
    });
    const llmRuns = res.runs ?? [];
    if (llmRuns.length === 0) break;

    for (const run of llmRuns) {
      const model = modelFromRunName(run.name);
      if (!model) continue;
      // An aborted race loser never served the user; drop it entirely.
      // @see #237
      if (isAbortedRun(run)) continue;
      const provider = providerFromRun(run);
      const duration = durationMsOf(run);
      const ttft = ttftMsOf(run);
      const tokens = typeof run.total_tokens === 'number' ? run.total_tokens : 0;
      // Token split for cost: absent/non-numeric counts as 0.
      // @see #224
      const inputTokens = typeof run.prompt_tokens === 'number' ? run.prompt_tokens : 0;
      const outputTokens = typeof run.completion_tokens === 'number' ? run.completion_tokens : 0;
      const isError = run.status === 'error';

      const key = keyOf(model, provider);
      const entry = byKey.get(key) ?? {
        model,
        provider,
        calls: 0,
        errors: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationSum: 0,
        durationCount: 0,
        ttftSum: 0,
        ttftCount: 0,
      };
      entry.calls += 1;
      if (isError) entry.errors += 1;
      entry.totalTokens += tokens;
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      if (duration !== null) {
        entry.durationSum += duration;
        entry.durationCount += 1;
      }
      if (ttft !== null) {
        entry.ttftSum += ttft;
        entry.ttftCount += 1;
      }
      byKey.set(key, entry);

      totals.calls += 1;
      if (isError) totals.errors += 1;
      totals.totalTokens += tokens;
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
    }

    if (llmRuns.length < PAGE_SIZE) break;
  }

  const models: AdminLangsmithModelStats[] = [...byKey.values()]
    .map(({ durationSum, durationCount, ttftSum, ttftCount, ...stats }) => ({
      ...stats,
      avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
      avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null,
      // Cost is joined at read time from the in-DB price.
      // @see #224
      estimatedCostUsd: null,
    }))
    .sort((a, b) => b.calls - a.calls);

  return { since, models, totals: { ...totals, estimatedCostUsd: null } };
};
