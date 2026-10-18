import { useCallback, useEffect, useState } from 'react';
import { AdminError, AdminEvalsService } from '../services/admin';
import type { AdminEvalRunDetail, AdminEvalRunSummary } from '../types/admin';

// Admin "Evals" tab: eval-rollup runs with drill-down and a manual run.
// @see #225

const formatTime = (iso: string | null): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

const scoreClass = (score: string): string =>
  score === 'pass'
    ? 'text-emerald-600'
    : score === 'partial'
      ? 'text-amber-600'
      : score === 'error'
        ? 'text-destructive'
        : 'text-red-600';

const Counts = ({ run }: { run: AdminEvalRunSummary }) => (
  // A single compact line so the row survives a 375px viewport.
  <span className="whitespace-nowrap text-xs">
    <span className="text-emerald-600">{run.counts.pass}p</span>{' '}
    <span className="text-amber-600">{run.counts.partial}~</span>{' '}
    <span className="text-red-600">{run.counts.fail}f</span>
    {run.counts.error > 0 && <span className="text-destructive"> {run.counts.error}e</span>}
  </span>
);

const AdminEvalsView = () => {
  const [runs, setRuns] = useState<AdminEvalRunSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminEvalRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await AdminEvalsService.listEvalRuns();
      setRuns(res.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const openRun = async (id: string) => {
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await AdminEvalsService.getEvalRun(id));
    } catch (err) {
      setDetailError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setDetailLoading(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await AdminEvalsService.runEvalsNow();
      await load();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section data-testid="admin-evals-section">
      {error && (
        <div
          data-testid="evals-error"
          className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {detailError && (
        <div
          data-testid="evals-detail-error"
          className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {detailError}
        </div>
      )}

      {detail ? (
        <div data-testid="evals-run-detail" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-heading text-base font-semibold">
              Run {detail.id.slice(-6)} · {formatTime(detail.startedAt)}
            </h3>
            <button
              data-testid="evals-detail-close"
              onClick={() => {
                setDetail(null);
                setDetailError(null);
              }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              Back to runs
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {detail.status} · {detail.models.join(', ')}
            {detail.error ? ` · ${detail.error}` : ''}
          </p>
          <div className="space-y-2">
            {detail.results.map((result) => (
              <div
                key={`${result.model}/${result.caseId}`}
                data-testid={`evals-case-${result.caseId}`}
                className="rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-medium">{result.caseId}</span>
                  <span className={`text-xs font-semibold ${scoreClass(result.score)}`}>
                    {result.score}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {result.provider}:{result.model}
                  </span>
                </div>
                {result.report && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-accent p-2 text-xs">
                    {result.report}
                  </pre>
                )}
              </div>
            ))}
            {detail.results.length === 0 && (
              <p className="text-sm text-muted-foreground">No case results recorded.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground">
              Scheduled deterministic evals (#225) — stored rollups, newest first.
            </p>
            <button
              data-testid="evals-run-now"
              onClick={() => void runNow()}
              disabled={running}
              className="ml-auto rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {running ? 'Starting…' : 'Run now'}
            </button>
          </div>

          <div
            data-testid="evals-runs"
            className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
          >
            {(runs ?? []).map((run) => (
              <button
                key={run.id}
                data-testid={`evals-run-${run.id}`}
                onClick={() => void openRun(run.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{formatTime(run.startedAt)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {run.models.join(', ')}
                  </span>
                </span>
                <Counts run={run} />
                <span
                  className={`shrink-0 text-xs ${run.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {run.status}
                </span>
              </button>
            ))}
            {loading && <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>}
            {!loading && runs && runs.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No eval runs yet. Use “Run now” or enable the daily schedule.
              </p>
            )}
          </div>
        </div>
      )}
      {detailLoading && !detail && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="evals-detail-loading">
          Loading run…
        </p>
      )}
    </section>
  );
};

export default AdminEvalsView;
