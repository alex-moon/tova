import { Fragment, useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import AdminService, {
  AdminError,
  AdminModelsService,
  AdminLogsService,
  AdminPatsService,
} from '../services/admin';
import AdminLangsmithView from './AdminLangsmithView';
import AdminEvalsView from './AdminEvalsView';
import type {
  AdminFixedModel,
  AdminLogEntry,
  AdminModelError,
  AdminPat,
  AdminUser,
  ModelComparisonRun,
} from '../types/admin';

const KNOWN_PERMISSIONS = ['routing'];

const LOG_LEVELS = ['all', 'info', 'warn', 'error'] as const;

// Retained logs are a 24h window, not a live tail — refresh slowly.
// @see #179
const LOGS_REFRESH_MS = 30000;

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [models, setModels] = useState<AdminFixedModel[] | null>(null);
  // @see #168
  const [modelErrors, setModelErrors] = useState<AdminModelError[]>([]);
  // Errors collapsed by default; expand key is provider/model/status/category.
  // @see #219
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [logLevel, setLogLevel] = useState<(typeof LOG_LEVELS)[number]>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  // configured/error mean graceful degradation (Loki env absent/unreachable).
  // @see #179
  const [logsConfigured, setLogsConfigured] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<
    'users' | 'models' | 'logs' | 'compare' | 'traces' | 'evals' | 'access'
  >('users');
  // PAT rows plus one-time plaintext shown after creation; never recoverable.
  // @see #184
  const [pats, setPats] = useState<AdminPat[] | null>(null);
  const [patName, setPatName] = useState('');
  const [newPatToken, setNewPatToken] = useState<string | null>(null);
  const [patCopied, setPatCopied] = useState(false);

  // A filter change re-queries the window; Loki has no incremental cursor.
  // @see #179
  const loadLogs = useCallback(
    async (params: { level?: 'info' | 'warn' | 'error'; q?: string }) => {
      try {
        const res = await AdminLogsService.listLogs({ level: params.level, q: params.q });
        setLogs(res.logs);
        setLogsConfigured(res.configured);
        setLogsError(res.error ?? null);
      } catch (err) {
        // Surface inline so the admin knows the pane is stale, not empty.
        setLogs([]);
        setLogsError(err instanceof Error ? err.message : 'Failed to load logs.');
      }
    },
    [],
  );

  const loadModels = useCallback(async () => {
    try {
      const res = await AdminModelsService.listModels();
      setModels(res.models);
      setModelErrors(res.errors);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  }, []);

  // Direct model comparison: pick entries, one prompt, run side by side.
  // @see #129 #234
  const [comparePrompt, setComparePrompt] = useState('');
  const [selectedCompareKeys, setSelectedCompareKeys] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<ModelComparisonRun | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const compareKey = (provider: string, modelId: string) => `${provider}|${modelId}`;

  // One checkbox per fixed model; the env-pinned serving rows.
  // @see #387
  const compareEntries = (models ?? []).map((m) => ({
    key: compareKey(m.provider, m.model),
    provider: m.provider,
    modelId: m.model,
    contextLength: m.contextLength,
  }));

  const toggleCompareSelected = (key: string) => {
    setSelectedCompareKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runComparison = async () => {
    const selected = compareEntries.filter((e) => selectedCompareKeys.has(e.key));
    if (!comparePrompt.trim() || selected.length === 0) return;
    setComparing(true);
    setCompareError(null);
    try {
      const run = await AdminModelsService.compareModels(
        comparePrompt.trim(),
        selected.map((e) => ({
          provider: e.provider,
          model: e.modelId,
          ...(e.contextLength !== undefined ? { contextLength: e.contextLength } : {}),
        })),
      );
      // The response preserves server execution order; render from it.
      setComparison(run);
    } catch (err) {
      setCompareError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setComparing(false);
    }
  };

  const loadUsers = useCallback(async () => {
    try {
      const res = await AdminService.listUsers();
      setUsers(res);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  }, []);

  const updateUser = (updated: AdminUser) => {
    setUsers((prev) => (prev ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev));
    setError(null);
  };

  const togglePermission = async (user: AdminUser, permission: string) => {
    const next = user.permissions.includes(permission)
      ? user.permissions.filter((p) => p !== permission)
      : [...user.permissions, permission];
    try {
      const res = await AdminService.updatePermissions(user.id, next);
      updateUser(res);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  const toggleRole = async (user: AdminUser) => {
    const role = user.role === 'admin' ? 'user' : 'admin';
    try {
      const res = await AdminService.updateRole(user.id, role);
      updateUser(res);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();

    loadModels();
  }, [loadUsers, loadModels]);

  // Logs fetch only while visible; the 30s refresh avoids a live-tail poll.
  // @see #179 #91
  useEffect(() => {
    if (activeSection !== 'logs') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLogs({ level: logLevel === 'all' ? undefined : logLevel, q: logQuery });
  }, [loadLogs, logLevel, logQuery, activeSection]);

  useEffect(() => {
    if (activeSection !== 'logs') return;
    const timer = setInterval(() => {
      loadLogs({ level: logLevel === 'all' ? undefined : logLevel, q: logQuery });
    }, LOGS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadLogs, logLevel, logQuery, activeSection]);

  // PATs load on demand, only while the Access section is visible.
  // @see #184
  const loadPats = useCallback(async () => {
    try {
      const res = await AdminPatsService.listPats();
      setPats(res.pats);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  }, []);

  useEffect(() => {
    if (activeSection !== 'access') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPats();
  }, [activeSection, loadPats]);

  const createPat = async () => {
    if (!patName.trim()) return;
    try {
      const created = await AdminPatsService.createPat(patName.trim());
      setNewPatToken(created.token);
      setPatCopied(false);
      setPatName('');
      await loadPats();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  const revokePat = async (pat: AdminPat) => {
    try {
      await AdminPatsService.revokePat(pat.id);
      // A revoked row can be the one whose token the box is showing.
      if (newPatToken) {
        setNewPatToken(null);
        setPatCopied(false);
      }
      await loadPats();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  const copyNewPat = async () => {
    if (!newPatToken) return;
    await navigator.clipboard.writeText(newPatToken);
    setPatCopied(true);
  };

  const sectionContent: {
    id: 'users' | 'models' | 'logs' | 'compare' | 'traces' | 'evals' | 'access';
    label: string;
  }[] = [
    { id: 'users', label: 'Users' },
    { id: 'models', label: 'Models' },
    { id: 'compare', label: 'Compare' },
    { id: 'traces', label: 'Traces' },
    { id: 'evals', label: 'Evals' },
    { id: 'logs', label: 'Logs' },
    { id: 'access', label: 'Access' },
  ];

  return (
    <div
      data-testid="admin-view"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      <div className="shrink-0 px-6">
        <div className="flex h-14 items-center">
          <h2 className="font-heading text-xl font-semibold">Admin</h2>
        </div>
        {!users && !error && <p className="text-sm text-muted-foreground">Loading users...</p>}
        {error && (
          <div
            data-testid="admin-error"
            className="mb-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-6 lg:flex-row">
        {/* A right-edge fade signals the phone tab strip scrolls; hidden at lg+ where the nav stacks. */}
        {/* @see #220 */}
        <div className="relative shrink-0 lg:contents">
          <nav
            data-testid="admin-nav"
            className="flex gap-2 overflow-x-auto rounded-xl p-2 lg:flex-col lg:overflow-x-visible panel-surface"
            aria-label="Admin sections"
          >
            {sectionContent.map((section) => (
              <button
                key={section.id}
                data-testid={`admin-tab-${section.id}`}
                onClick={() => {
                  // Leaving Access clears the token box; it is unrecoverable.
                  if (activeSection === 'access' && section.id !== 'access') {
                    setNewPatToken(null);
                    setPatCopied(false);
                  }
                  setActiveSection(section.id);
                }}
                aria-current={activeSection === section.id ? 'page' : undefined}
                className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  activeSection === section.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                {section.label}
              </button>
            ))}
          </nav>
          <div
            data-testid="admin-nav-fade"
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-xl bg-gradient-to-l from-background to-transparent lg:hidden"
          />
        </div>
        <div
          data-testid="admin-scroller"
          className="min-h-0 flex-1 overflow-y-auto rounded-xl px-4 py-4 ambient-wash"
        >
          {activeSection === 'users' && (
            <section data-testid="admin-users-section">
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="responsive-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Email</th>
                      <th className="px-4 py-3 font-medium">Role</th>
                      <th className="px-4 py-3 font-medium">Google</th>
                      <th className="px-4 py-3 font-medium">Permissions</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {users?.map((user) => (
                      <tr key={user.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3" data-label="Email">
                          {user.email}
                        </td>
                        <td
                          className="px-4 py-3"
                          data-label="Role"
                          data-testid={`role-${user.email}`}
                        >
                          {user.role}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Google">
                          {user.hasGoogle ? 'yes' : 'no'}
                        </td>
                        <td className="px-4 py-3" data-label="Permissions">
                          {KNOWN_PERMISSIONS.map((permission) => (
                            <label
                              key={permission}
                              className="mr-4 inline-flex items-center gap-1.5"
                            >
                              <input
                                type="checkbox"
                                data-testid={`perm-${permission}-${user.email}`}
                                checked={user.permissions.includes(permission)}
                                onChange={() => togglePermission(user, permission)}
                              />
                              {permission}
                            </label>
                          ))}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            data-testid={`toggle-role-${user.email}`}
                            onClick={() => toggleRole(user)}
                            className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                          >
                            {user.role === 'admin' ? 'Demote' : 'Promote'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {activeSection === 'models' && (
            <section data-testid="admin-models-section">
              <h3 className="font-heading text-lg font-semibold">Models</h3>
              <p className="text-xs text-muted-foreground">
                The fixed serving models (#387) — env-pinned per function, with chat hedged across
                its known provider backends. Routing is not editable here any more; set{' '}
                <code>CHAT_MODEL</code> / <code>TASK_MODEL</code> in the environment.
              </p>
              <div
                data-testid="admin-models"
                className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"
              >
                <table className="responsive-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Context</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models?.map((model) => (
                      <tr
                        key={`${model.provider}/${model.model}`}
                        className="border-b border-border last:border-b-0"
                      >
                        <td
                          className="px-4 py-3 font-mono text-xs"
                          data-label="Model"
                          data-testid={`admin-model-${model.model}`}
                        >
                          {model.model}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Provider">
                          {model.provider}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Context">
                          {model.contextLength?.toLocaleString() ?? '—'}
                        </td>
                      </tr>
                    ))}
                    {models?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={3}>
                          No models configured.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {modelErrors.length > 0 && (
                <div className="mt-4">
                  <h4 className="font-heading text-sm font-semibold">Recent endpoint errors</h4>
                  <p className="text-xs text-muted-foreground">
                    Completion failures tallied per provider route (status + category), newest first
                    — kept in Mongo because deploys wipe the logs.
                  </p>
                  <div
                    data-testid="admin-model-errors"
                    className="mt-2 overflow-x-auto rounded-xl border border-border bg-card"
                  >
                    <table className="responsive-table w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="px-4 py-3 font-medium">Model</th>
                          <th className="px-4 py-3 font-medium">Error</th>
                          <th className="px-4 py-3 font-medium">Count</th>
                          <th className="px-4 py-3 font-medium">Last seen</th>
                          <th className="px-4 py-3 font-medium">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {modelErrors.map((e) => {
                          const rowKey = `${e.provider}/${e.model}/${e.status ?? 'none'}/${e.category}`;
                          const expanded = expandedErrors.has(rowKey);
                          return (
                            <Fragment key={rowKey}>
                              <tr
                                data-testid={`admin-model-error-${e.provider}-${e.model}-${e.status ?? 'none'}`}
                                className="border-b border-border"
                              >
                                <td className="px-4 py-3 text-muted-foreground" data-label="Model">
                                  {e.provider}/{e.model}
                                </td>
                                <td className="px-4 py-3" data-label="Error">
                                  {e.status !== null ? `${e.status} · ` : ''}
                                  {e.category}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground" data-label="Count">
                                  {e.count}
                                </td>
                                <td
                                  className="px-4 py-3 text-muted-foreground"
                                  data-label="Last seen"
                                >
                                  {new Date(e.lastSeenAt).toLocaleString()}
                                </td>
                                <td className="px-4 py-3">
                                  <button
                                    type="button"
                                    aria-expanded={expanded}
                                    data-testid={`admin-model-error-toggle-${e.provider}-${e.model}-${e.status ?? 'none'}`}
                                    onClick={() =>
                                      setExpandedErrors((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(rowKey)) next.delete(rowKey);
                                        else next.add(rowKey);
                                        return next;
                                      })
                                    }
                                    className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                                  >
                                    {expanded ? (
                                      <ChevronDown className="size-4 shrink-0" />
                                    ) : (
                                      <ChevronRight className="size-4 shrink-0" />
                                    )}
                                    <span className="truncate">
                                      {expanded ? 'Hide error' : 'Show error'}
                                    </span>
                                  </button>
                                </td>
                              </tr>
                              {expanded && (
                                <tr
                                  className="border-b border-border last:border-b-0"
                                  data-testid={`admin-model-error-message-${e.provider}-${e.model}-${e.status ?? 'none'}`}
                                >
                                  <td colSpan={5} className="px-4 py-3">
                                    <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                                      {e.lastMessage}
                                    </pre>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}
          {activeSection === 'compare' && (
            <section data-testid="admin-compare-section">
              <h3 className="font-heading text-lg font-semibold">Compare</h3>
              <p className="text-xs text-muted-foreground">
                One prompt through the existing agent on each fixed model (issue #129, #387).
                Sequential; picks inform routing decisions.
              </p>
              <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
                <textarea
                  data-testid="compare-prompt"
                  value={comparePrompt}
                  onChange={(e) => setComparePrompt(e.target.value)}
                  rows={4}
                  placeholder="Prompt to run against each selected model…"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <div className="flex flex-col gap-2">
                  {compareEntries.map((entry) => (
                    <label key={entry.key} className="flex items-start gap-2 text-sm break-all">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        data-testid={`compare-model-${entry.provider}-${entry.modelId}`}
                        checked={selectedCompareKeys.has(entry.key)}
                        onChange={() => toggleCompareSelected(entry.key)}
                      />
                      <span>
                        {entry.provider}/{entry.modelId}
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  data-testid="compare-run"
                  onClick={runComparison}
                  disabled={comparing || !comparePrompt.trim() || selectedCompareKeys.size === 0}
                  className="self-start rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {comparing ? 'Running…' : 'Run comparison'}
                </button>
                {compareError && (
                  <div
                    data-testid="compare-error"
                    className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
                  >
                    {compareError}
                  </div>
                )}
                {comparison && (
                  <div
                    data-testid="compare-results"
                    className="flex flex-col divide-y divide-border"
                  >
                    {comparison.results.map((res) => (
                      <div key={`${res.provider}/${res.model}`} className="py-3">
                        <div className="mb-1 flex items-center gap-2 text-sm">
                          <span className="font-medium" data-testid={`compare-answer-${res.model}`}>
                            {res.provider}/{res.model}
                          </span>
                          <span
                            className={`text-xs ${res.error ? 'text-destructive' : 'text-muted-foreground'}`}
                          >
                            {res.error
                              ? `error · ${res.error}`
                              : `${(res.latencyMs / 1000).toFixed(1)}s`}
                          </span>
                        </div>
                        {res.answer && (
                          <pre className="whitespace-pre-wrap text-sm">{res.answer}</pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
          {activeSection === 'traces' && <AdminLangsmithView />}
          {activeSection === 'evals' && <AdminEvalsView />}
          {activeSection === 'logs' && (
            <section data-testid="admin-logs-section">
              <h3 className="font-heading text-lg font-semibold">Logs</h3>
              <p className="text-xs text-muted-foreground">
                Retained server logs (#179) — last 24 hours from Grafana Cloud, newest first. These
                survive deploys, unlike the old in-memory buffer.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {LOG_LEVELS.map((level) => (
                  <label key={level} className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="log-level"
                      data-testid={`log-level-${level}`}
                      checked={logLevel === level}
                      onChange={() => setLogLevel(level)}
                    />
                    {level}
                  </label>
                ))}
                <input
                  data-testid="log-search"
                  value={logQuery}
                  onChange={(e) => setLogQuery(e.target.value)}
                  placeholder="Filter messages…"
                  className="ml-auto rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
                />
              </div>
              <div
                data-testid="admin-logs"
                className="mt-4 max-h-80 overflow-y-auto rounded-xl border border-border bg-card"
              >
                {!logsConfigured && (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    Retained logs are not configured (Loki env absent).
                  </p>
                )}
                {logsConfigured && logsError && (
                  <p className="px-4 py-3 text-sm text-destructive">{logsError}</p>
                )}
                {logsConfigured && !logsError && logs.length === 0 && (
                  <p className="px-4 py-3 text-sm text-muted-foreground">No log entries.</p>
                )}
                {logs.map((log) => (
                  <div key={log.id} className="border-b border-border px-4 py-2 font-mono text-xs">
                    <span className="mr-2 text-muted-foreground">{log.ts}</span>
                    <span
                      className={`mr-2 font-semibold ${
                        log.level === 'error'
                          ? 'text-destructive'
                          : log.level === 'warn'
                            ? 'text-yellow-500'
                            : 'text-foreground'
                      }`}
                    >
                      {log.level}
                    </span>
                    <span>{log.msg}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {activeSection === 'access' && (
            <section data-testid="admin-access-section">
              <h3 className="font-heading text-lg font-semibold">Access</h3>
              <p className="text-xs text-muted-foreground">
                Personal access tokens (#184) — for agents and CLI scripts. Paste into{' '}
                <code>.env</code> as <code>TOVA_PAT</code> and send it as{' '}
                <code>Authorization: Bearer</code>. Tokens inherit their creator&apos;s role.
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">Name</span>
                  <input
                    data-testid="pat-name-input"
                    value={patName}
                    onChange={(e) => setPatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createPat();
                    }}
                    placeholder="agent laptop"
                    className="rounded-lg border border-border bg-background px-2 py-1"
                  />
                </label>
                <button
                  data-testid="pat-create-button"
                  onClick={() => void createPat()}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Generate token
                </button>
              </div>
              {newPatToken && (
                <div
                  data-testid="pat-one-time-token"
                  className="mt-4 rounded-xl border border-border bg-card p-4"
                >
                  <p className="text-xs font-semibold text-yellow-500">
                    Copy it now — this token is shown once and never stored in plaintext.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <code className="max-w-full overflow-x-auto rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs">
                      {newPatToken}
                    </code>
                    <button
                      data-testid="pat-copy-button"
                      onClick={() => void copyNewPat()}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      {patCopied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card">
                <table data-testid="admin-pats" className="responsive-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Created</th>
                      <th className="px-4 py-3 font-medium">Last used</th>
                      <th className="px-4 py-3 font-medium">Expires</th>
                      <th className="px-4 py-3 font-medium">Created by</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {(pats ?? []).map((pat) => (
                      <tr key={pat.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3" data-label="Name">
                          {pat.name}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Created">
                          {new Date(pat.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Last used">
                          {pat.lastUsedAt ? new Date(pat.lastUsedAt).toLocaleString() : 'never'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Expires">
                          {pat.expiresAt ? new Date(pat.expiresAt).toLocaleString() : 'never'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Created by">
                          {pat.creatorEmail}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            data-testid={`pat-revoke-${pat.name}`}
                            onClick={() => void revokePat(pat)}
                            className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                    {pats?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={6}>
                          No tokens yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminView;
