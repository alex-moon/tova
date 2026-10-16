import { useCallback, useEffect, useState } from 'react';
import { AdminError, AdminLangsmithService } from '../services/admin';
import type {
  AdminLangsmithModelStats,
  AdminLangsmithStatsPayload,
  AdminSessionCostRow,
  AdminSessionsCostPayload,
  AdminTraceDetail,
  AdminTraceRow,
  AdminTraceRun,
  AdminTracesPayload,
} from '../types/admin';

/*
 * Admin "Traces" tab (#186): the two LangSmith tools the routing loop
 * needs, both read-only — a recent-traces browser with a drill-down run
 * tree, and a per-model stats strip. Extracted from AdminView (which
 * holds every other tab inline) to keep that file navigable; mounting is
 * conditional on the tab being active, same as the other sections.
 */

const formatDuration = (ms: number | null): string =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

const formatTokens = (tokens: number | null): string =>
  tokens === null ? '—' : tokens.toLocaleString();

// #237: a stats row is per (model, provider); the provider is null on a
// legacy no-provider rollup.
const modelLabel = (row: AdminLangsmithModelStats): string =>
  row.provider ? `${row.model} · ${row.provider}` : row.model;

// Estimated cost is null when a price is unknown (#199 unknown ≠ free), so
// render `—` rather than $0. Sub-cent spend keeps more precision than 2dp.
const formatCost = (usd: number | null): string => {
  if (usd === null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
};

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

// #308: the workspace-memory facts, terse for the table cell — the guard
// outcome plus (when the guard fired) how many slices the block carried.
// Undefined on traces from before the metadata existed.
const memoryLabel = (trace: AdminTraceRow): string => {
  if (!trace.workspaceGate) return '—';
  const hits =
    trace.workspaceGate === 'yes' && trace.workspaceHits !== undefined
      ? ` · ${trace.workspaceHits}`
      : '';
  return `${trace.workspaceGate}${hits}`;
};

const prettyJson = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

// Indentation depth from the parentId chain; orphaned ids (server dropped
// a parent) degrade to depth 0 rather than breaking the render.
const depthOf = (run: AdminTraceRun, byId: Map<string, AdminTraceRun>): number => {
  let depth = 0;
  let current: AdminTraceRun | undefined = run;
  while (current?.parentId && depth < 20) {
    current = byId.get(current.parentId);
    depth += 1;
  }
  return depth;
};

const RunBlock = ({ run, depth }: { run: AdminTraceRun; depth: number }) => (
  <div
    data-testid={`langsmith-run-${run.id}`}
    className="rounded-lg border border-border bg-card p-3 text-sm"
    style={{ marginLeft: `${depth * 1.5}rem` }}
  >
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-medium">{run.name}</span>
      <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
        {run.runType}
      </span>
      <span
        className={`text-xs ${run.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {run.status}
        {run.model ? ` · ${run.model}` : ''}
        {run.provider ? ` · ${run.provider}` : ''}
      </span>
      <span className="text-xs text-muted-foreground">
        {formatDuration(run.durationMs)}
        {run.ttftMs !== null ? ` · first token ${formatDuration(run.ttftMs)}` : ''} ·{' '}
        {formatTokens(run.totalTokens)} tok
      </span>
    </div>
    {run.error && (
      <p data-testid={`langsmith-run-error-${run.id}`} className="mt-2 text-xs text-destructive">
        {run.error}
      </p>
    )}
    <div className="mt-2 grid gap-2">
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">inputs</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-accent p-2 text-xs">
          {prettyJson(run.inputs)}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">outputs</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-accent p-2 text-xs">
          {prettyJson(run.outputs)}
        </pre>
      </details>
    </div>
  </div>
);

// One model's stats: a primary row (traffic + latency + tokens) and a paired
// cost-breakdown row with the in/out split and the estimated spend (#224).
// Rendered as two sibling <tr> inside a fragment so the table body stays a
// real table; the cost row is muted and visually bound to its model.
const ModelStatsRow = ({ row }: { row: AdminLangsmithModelStats }) => (
  <>
    <tr
      data-testid={`langsmith-model-${row.model}${row.provider ? `-${row.provider}` : ''}`}
      className="border-b border-border"
    >
      <td className="px-3 py-2">{modelLabel(row)}</td>
      <td className="px-3 py-2">{row.calls}</td>
      <td className={`px-3 py-2 ${row.errors > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
        {row.errors}
      </td>
      <td className="px-3 py-2">{formatDuration(row.avgDurationMs)}</td>
      <td className="px-3 py-2">{formatDuration(row.avgTtftMs)}</td>
      <td className="px-3 py-2">{formatTokens(row.totalTokens)}</td>
    </tr>
    <tr
      data-testid={`langsmith-cost-${row.model}${row.provider ? `-${row.provider}` : ''}`}
      className="border-b border-border last:border-b-0 text-xs text-muted-foreground"
    >
      <td colSpan={6} className="px-3 py-1.5">
        <span className="pl-3">
          in {formatTokens(row.inputTokens)} · out {formatTokens(row.outputTokens)} · est.{' '}
          {formatCost(row.estimatedCostUsd)}
        </span>
      </td>
    </tr>
  </>
);

/*
 * Per-session cost breakdown (#224). Message counts and token/cost totals are
 * deliberately separate columns: only assistant turns logged after #224 carry
 * usage, so a session's counts can be non-zero while its tokens/cost are `—`
 * until usage builds up. Keeping them side by side makes that skew legible.
 */
const SessionCostRow = ({ row }: { row: AdminSessionCostRow }) => (
  <tr
    data-testid={`langsmith-session-${row.sessionId}`}
    className="border-b border-border last:border-b-0"
  >
    <td className="max-w-[12rem] truncate px-3 py-2" title={row.title}>
      {row.title}
    </td>
    <td className="px-3 py-2">{row.messagesIn}</td>
    <td className="px-3 py-2">{row.messagesOut}</td>
    <td className="px-3 py-2">{formatTokens(row.inputTokens)}</td>
    <td className="px-3 py-2">{formatTokens(row.outputTokens)}</td>
    <td className="px-3 py-2">{formatCost(row.estimatedCostUsd)}</td>
    <td className="px-3 py-2 text-xs text-muted-foreground">{formatTime(row.lastActivityAt)}</td>
  </tr>
);

const AdminLangsmithView = () => {
  const [traces, setTraces] = useState<AdminTracesPayload | null>(null);
  const [stats, setStats] = useState<AdminLangsmithStatsPayload | null>(null);
  const [sessionCosts, setSessionCosts] = useState<AdminSessionsCostPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [detail, setDetail] = useState<AdminTraceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async (params: { errorsOnly?: boolean; model?: string }) => {
    setLoading(true);
    try {
      const res = await AdminLangsmithService.listTraces(params);
      setTraces(res);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, []);

  // First load: traces and the stats rollup in parallel; a stats failure is
  // non-fatal for the list (the banner covers it, refresh retries both).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load({});
    AdminLangsmithService.listStats()
      .then(setStats)
      .catch(() => {});
    AdminLangsmithService.listSessionCosts()
      .then(setSessionCosts)
      .catch(() => {});
  }, [load]);

  const refresh = () => {
    void load({ errorsOnly, ...(modelFilter ? { model: modelFilter } : {}) });
    AdminLangsmithService.listStats()
      .then(setStats)
      .catch(() => {});
    AdminLangsmithService.listSessionCosts()
      .then(setSessionCosts)
      .catch(() => {});
  };

  const openTrace = async (traceId: string) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await AdminLangsmithService.getTrace(traceId));
    } catch (err) {
      setDetailError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setDetailLoading(false);
    }
  };

  const applyFilters = (next: { errorsOnly?: boolean; model?: string }) => {
    void load(next);
  };

  const modelOptions = [...new Set((stats?.models ?? []).map((m) => m.model))];

  const byId = new Map((detail?.runs ?? []).map((run) => [run.id, run]));

  return (
    <section data-testid="admin-langsmith-section">
      {error && (
        <div
          data-testid="langsmith-error"
          className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {detailError && (
        <div
          data-testid="langsmith-detail-error"
          className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {detailError}
        </div>
      )}

      {detail ? (
        <div data-testid="langsmith-trace-detail" className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-heading text-base font-semibold">Trace {detail.traceId}</h3>
            <button
              data-testid="langsmith-detail-close"
              onClick={() => {
                setDetail(null);
                setDetailError(null);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              Back to traces
            </button>
          </div>
          {detail.runs.map((run) => (
            <RunBlock key={run.id} run={run} depth={depthOf(run, byId)} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className="rounded-xl border border-border bg-card p-4"
            data-testid="langsmith-stats"
          >
            <h3 className="mb-3 font-heading text-base font-semibold">
              Model stats · last 7 days
              {stats?.computedAt && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  updated {formatTime(stats.computedAt)}
                  {stats.stale ? ' · updating…' : ''}
                </span>
              )}
            </h3>
            {stats && stats.models.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="responsive-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 font-medium">Calls</th>
                      <th className="px-3 py-2 font-medium">Errors</th>
                      <th className="px-3 py-2 font-medium">Avg latency</th>
                      <th className="px-3 py-2 font-medium">Avg TTFT</th>
                      <th className="px-3 py-2 font-medium">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.models.map((row) => (
                      <ModelStatsRow key={`${row.model}/${row.provider ?? ''}`} row={row} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr
                      data-testid="langsmith-cost-total"
                      className="border-t border-border text-sm"
                    >
                      <td className="px-3 py-2 font-medium">Total</td>
                      <td className="px-3 py-2">{stats.totals.calls}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2">
                        est. {formatCost(stats.totals.estimatedCostUsd)}
                      </td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2">{formatTokens(stats.totals.totalTokens)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No traced runs in the window.</p>
            )}
          </div>

          <div
            className="rounded-xl border border-border bg-card p-4"
            data-testid="langsmith-session-costs"
          >
            <h3 className="mb-1 font-heading text-base font-semibold">
              Session cost · last 7 days
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              From our own messages. Token and cost totals count only turns logged after the
              per-message usage change, so they lag the message counts while usage builds up. Each
              turn is priced by the provider that served it, so a model raced across two backends
              bills at the winning provider's rate.
            </p>
            {sessionCosts && sessionCosts.sessions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Session</th>
                      <th className="px-3 py-2 font-medium">In</th>
                      <th className="px-3 py-2 font-medium">Out</th>
                      <th className="px-3 py-2 font-medium">Tokens in</th>
                      <th className="px-3 py-2 font-medium">Tokens out</th>
                      <th className="px-3 py-2 font-medium">Est. cost</th>
                      <th className="px-3 py-2 font-medium">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionCosts.sessions.map((row) => (
                      <SessionCostRow key={row.sessionId} row={row} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr data-testid="langsmith-session-total" className="border-t border-border">
                      <td className="px-3 py-2 font-medium">
                        {sessionCosts.totals.sessions} session
                        {sessionCosts.totals.sessions === 1 ? '' : 's'}
                      </td>
                      <td className="px-3 py-2">{sessionCosts.totals.messagesIn}</td>
                      <td className="px-3 py-2">{sessionCosts.totals.messagesOut}</td>
                      <td className="px-3 py-2">{formatTokens(sessionCosts.totals.inputTokens)}</td>
                      <td className="px-3 py-2">
                        {formatTokens(sessionCosts.totals.outputTokens)}
                      </td>
                      <td className="px-3 py-2">
                        {formatCost(sessionCosts.totals.estimatedCostUsd)}
                      </td>
                      <td className="px-3 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No sessions in the window.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid="langsmith-errors-only"
                checked={errorsOnly}
                onChange={(event) => {
                  setErrorsOnly(event.target.checked);
                  applyFilters({
                    errorsOnly: event.target.checked,
                    ...(modelFilter ? { model: modelFilter } : {}),
                  });
                }}
              />
              errors only
            </label>
            <select
              data-testid="langsmith-model-filter"
              value={modelFilter}
              onChange={(event) => {
                const model = event.target.value;
                setModelFilter(model);
                applyFilters({ errorsOnly, ...(model ? { model } : {}) });
              }}
              className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">all models</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <button
              data-testid="langsmith-refresh"
              onClick={refresh}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table data-testid="langsmith-traces" className="responsive-table w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Started</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Memory</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                  <th className="px-4 py-3 font-medium">Tokens</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {(traces?.traces ?? []).map((trace) => (
                  <tr
                    key={trace.id}
                    data-testid={`langsmith-trace-${trace.traceId}`}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="px-4 py-3 text-muted-foreground" data-label="Started">
                      {formatTime(trace.startedAt)}
                    </td>
                    <td
                      className={`px-4 py-3 ${trace.status === 'error' ? 'text-destructive' : ''}`}
                      data-label="Status"
                    >
                      {trace.status}
                    </td>
                    <td className="px-4 py-3" data-label="Model">
                      {trace.model ?? '—'}
                      {trace.provider ? ` · ${trace.provider}` : ''}
                    </td>
                    <td
                      className={`px-4 py-3 ${
                        trace.workspaceGate === 'timeout' ? 'text-destructive' : ''
                      }`}
                      data-label="Memory"
                    >
                      {memoryLabel(trace)}
                    </td>
                    <td className="px-4 py-3" data-label="Duration">
                      {formatDuration(trace.durationMs)}
                    </td>
                    <td className="px-4 py-3" data-label="Tokens">
                      {formatTokens(trace.totalTokens)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {trace.error && (
                        <span className="mr-3 text-xs text-destructive" title={trace.error}>
                          {trace.error.slice(0, 60)}
                        </span>
                      )}
                      {trace.appPath && (
                        <a
                          data-testid={`langsmith-open-external-${trace.traceId}`}
                          href={`https://smith.langchain.com${trace.appPath}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mr-3 text-xs text-muted-foreground underline hover:text-foreground"
                        >
                          LangSmith ↗
                        </a>
                      )}
                      <button
                        data-testid={`langsmith-open-${trace.traceId}`}
                        onClick={() => void openTrace(trace.traceId)}
                        className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {loading && <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>}
            {!loading && traces && traces.traces.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">No traces.</p>
            )}
          </div>
        </div>
      )}
      {detailLoading && !detail && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="langsmith-detail-loading">
          Loading trace…
        </p>
      )}
    </section>
  );
};

export default AdminLangsmithView;
