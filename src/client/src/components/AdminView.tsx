import { useState, useEffect, useCallback, useRef } from 'react';
import AdminService, { AdminError, AdminModelsService, AdminLogsService } from '../services/admin';
import type { AdminLogEntry, AdminModel, AdminUser, ModelComparisonRun } from '../types/admin';

const KNOWN_PERMISSIONS = ['routing'];

const LOG_LEVELS = ['all', 'info', 'warn', 'error'] as const;

const POLL_INTERVAL_MS = 3000;

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [logLevel, setLogLevel] = useState<(typeof LOG_LEVELS)[number]>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const cursorRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'users' | 'models' | 'logs' | 'compare'>(
    'users',
  );

  // Issue #76: incremental polling via the monotonic log cursor. A filter
  // change resets the cursor because the server filters by level/text, so
  // previous ids must be re-fetched under the new filter.
  const loadLogs = useCallback(
    async (params: { level?: 'info' | 'warn' | 'error'; q?: string; reset?: boolean }) => {
      const { level, q, reset } = params;
      if (reset) cursorRef.current = 0;
      try {
        const res = await AdminLogsService.listLogs({
          level,
          q,
          cursor: cursorRef.current,
        });
        cursorRef.current = res.nextCursor;
        setLogs((prev) => {
          const next = reset ? res.logs : [...prev, ...res.logs];
          return next.slice(-300);
        });
      } catch {
        // Polling failure is non-fatal: the next tick or manual refresh
        // retries. Suppressing the error avoids flashing the inline banner
        // every poll when the admin page is left open in a background tab.
      }
    },
    [],
  );

  const loadModels = useCallback(async () => {
    try {
      const res = await AdminModelsService.listModels();
      setModels(res);
      setError(null);
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  }, []);

  // Direct model comparison (issue #129): pick rows from the inventory, type
  // a prompt, and run it through the existing agent on each selection side
  // by side. Server-mirrored cap on selections (MAX_COMPARE_MODELS = 6).
  const [comparePrompt, setComparePrompt] = useState('');
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<ModelComparisonRun | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const toggleModelSelected = (id: string) => {
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runComparison = async () => {
    const selected = (models ?? []).filter((m) => selectedModelIds.has(m.id));
    if (!comparePrompt.trim() || selected.length === 0) return;
    setComparing(true);
    setCompareError(null);
    try {
      const run = await AdminModelsService.compareModels(
        comparePrompt.trim(),
        selected.map((m) => ({
          provider: m.provider,
          model: m.model,
          ...(m.contextLength !== undefined ? { contextLength: m.contextLength } : {}),
        })),
      );
      // Selection order in the view is the checkbox order in the table; the
      // response preserves the server's sequential execution order, so render
      // directly from it.
      setComparison(run);
    } catch (err) {
      setCompareError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setComparing(false);
    }
  };

  // CRUD for routing rows (issue #104). Mutations refetch the authoritative
  // list rather than trusting the (id-only) response bodies.
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [form, setForm] = useState<{
    provider: string;
    model: string;
    tier: string;
    contextLength: string;
    tools: boolean;
    vision: boolean;
  }>({
    provider: 'deepinfra',
    model: '',
    tier: 'small',
    contextLength: '',
    tools: true,
    vision: false,
  });

  const formDataFor = (m: AdminModel) => ({
    provider: m.provider,
    model: m.model,
    tier: m.tier as string,
    contextLength: m.contextLength === undefined ? '' : String(m.contextLength),
    tools: m.tools,
    vision: m.vision,
  });

  const startEdit = (m: AdminModel) => {
    setEditingModelId(m.id);
    setForm(formDataFor(m));
  };

  const submitForm = async () => {
    const payload = {
      provider: form.provider,
      model: form.model,
      tier: form.tier as AdminModel['tier'],
      ...(form.contextLength ? { contextLength: Number(form.contextLength) } : {}),
      tools: form.tools,
      vision: form.vision,
    };
    try {
      if (editingModelId) {
        await AdminModelsService.updateModel(
          editingModelId,
          form.contextLength ? payload : { ...payload, contextLength: null },
        );
      } else {
        await AdminModelsService.createModel(payload);
      }
      setEditingModelId(null);
      setForm({
        provider: 'deepinfra',
        model: '',
        tier: 'small',
        contextLength: '',
        tools: true,
        vision: false,
      });
      await loadModels();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  const toggleModelEligible = async (m: AdminModel) => {
    try {
      await AdminModelsService.updateModel(m.id, { eligible: !m.eligible });
      await loadModels();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  const deleteModel = async (m: AdminModel) => {
    try {
      await AdminModelsService.deleteModel(m.id);
      await loadModels();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
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

  // Issue #91: logs fetches and the poll timer only run while the Logs
  // section is visible — an every-3s poll against a hidden tab wastes API
  // calls and eventually trips rate limiting.
  useEffect(() => {
    if (activeSection !== 'logs') return;
    loadLogs({ level: logLevel === 'all' ? undefined : logLevel, q: logQuery, reset: true });
  }, [loadLogs, logLevel, logQuery, activeSection]);

  useEffect(() => {
    if (activeSection !== 'logs') return;
    const timer = setInterval(() => {
      loadLogs({ level: logLevel === 'all' ? undefined : logLevel, q: logQuery });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadLogs, logLevel, logQuery, activeSection]);

  const sectionContent: {
    id: 'users' | 'models' | 'logs' | 'compare';
    label: string;
  }[] = [
    { id: 'users', label: 'Users' },
    { id: 'models', label: 'Models' },
    { id: 'compare', label: 'Compare' },
    { id: 'logs', label: 'Logs' },
  ];

  return (
    <div
      data-testid="admin-view"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      <div className="shrink-0 px-6 pt-6">
        <h2 className="font-heading text-xl font-semibold">Admin</h2>
        {!users && !error && <p className="mt-3 text-sm text-muted-foreground">Loading users...</p>}
        {error && (
          <div
            data-testid="admin-error"
            className="mt-3 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-6 lg:flex-row">
        <nav
          data-testid="admin-nav"
          className="flex shrink-0 gap-2 lg:flex-col"
          aria-label="Admin sections"
        >
          {sectionContent.map((section) => (
            <button
              key={section.id}
              data-testid={`admin-tab-${section.id}`}
              onClick={() => setActiveSection(section.id)}
              aria-current={activeSection === section.id ? 'page' : undefined}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                activeSection === section.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-accent hover:text-accent-foreground'
              }`}
            >
              {section.label}
            </button>
          ))}
        </nav>
        <div data-testid="admin-scroller" className="min-h-0 flex-1 overflow-y-auto">
          {activeSection === 'users' && (
            <section data-testid="admin-users-section">
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
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
                        <td className="px-4 py-3">{user.email}</td>
                        <td className="px-4 py-3" data-testid={`role-${user.email}`}>
                          {user.role}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {user.hasGoogle ? 'yes' : 'no'}
                        </td>
                        <td className="px-4 py-3">
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
                Routing rows (issue #33/#104) — disable, edit, add or delete; feedback tallies per
                band.
              </p>
              <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">Provider</span>
                  <select
                    data-testid="model-form-provider"
                    value={form.provider}
                    onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                    className="rounded-lg border border-border bg-background px-2 py-1"
                  >
                    <option value="groq">groq</option>
                    <option value="deepinfra">deepinfra</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">Model</span>
                  <input
                    data-testid="model-form-model"
                    value={form.model}
                    onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                    placeholder="org/model-name"
                    className="w-64 rounded-lg border border-border bg-background px-2 py-1"
                  />
                </label>
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">Tier</span>
                  <select
                    data-testid="model-form-tier"
                    value={form.tier}
                    onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value }))}
                    className="rounded-lg border border-border bg-background px-2 py-1"
                  >
                    <option value="small">small</option>
                    <option value="large">large</option>
                    <option value="guard">guard</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">Context</span>
                  <input
                    data-testid="model-form-context"
                    value={form.contextLength}
                    onChange={(e) => setForm((f) => ({ ...f, contextLength: e.target.value }))}
                    inputMode="numeric"
                    placeholder="e.g. 131072"
                    className="w-28 rounded-lg border border-border bg-background px-2 py-1"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    data-testid="model-form-tools"
                    checked={form.tools}
                    onChange={(e) => setForm((f) => ({ ...f, tools: e.target.checked }))}
                  />
                  tools
                </label>
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    data-testid="model-form-vision"
                    checked={form.vision}
                    onChange={(e) => setForm((f) => ({ ...f, vision: e.target.checked }))}
                  />
                  vision
                </label>
                <button
                  data-testid="model-form-submit"
                  onClick={submitForm}
                  disabled={!form.model.trim()}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors disabled:opacity-50"
                >
                  {editingModelId ? 'Save' : 'Add model'}
                </button>
                {editingModelId && (
                  <button
                    data-testid="model-form-cancel"
                    onClick={() => setEditingModelId(null)}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <div
                data-testid="admin-models"
                className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Tier</th>
                      <th className="px-4 py-3 font-medium">Context</th>
                      <th className="px-4 py-3 font-medium">Eligible</th>
                      <th className="px-4 py-3 font-medium">Capabilities</th>
                      <th className="px-4 py-3 font-medium">Feedback</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {models?.map((model) => (
                      <tr key={model.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3" data-testid={`admin-model-${model.id}`}>
                          {model.model}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{model.provider}</td>
                        <td className="px-4 py-3">{model.tier}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {model.contextLength?.toLocaleString() ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            data-testid={`model-eligible-${model.id}`}
                            checked={model.eligible}
                            onChange={() => toggleModelEligible(model)}
                          />
                        </td>
                        <td className="px-4 py-3" data-testid={`admin-model-caps-${model.id}`}>
                          <span
                            className={`mr-1.5 inline-block rounded-full border px-2 py-0.5 text-xs ${
                              model.vision
                                ? 'border-primary text-primary'
                                : 'border-border text-muted-foreground'
                            }`}
                            data-testid={`admin-model-vision-${model.id}`}
                          >
                            vision {model.vision ? '✓' : '✗'}
                          </span>
                          <span
                            className={`mr-1.5 inline-block rounded-full border px-2 py-0.5 text-xs ${
                              model.tools
                                ? 'border-primary text-primary'
                                : 'border-border text-muted-foreground'
                            }`}
                          >
                            tools {model.tools ? '✓' : '✗'}
                          </span>
                          <span className="inline-block px-2 py-0.5 text-xs text-muted-foreground">
                            {model.contextLength
                              ? `${model.contextLength.toLocaleString()} tok`
                              : ''}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {model.stats.length === 0
                            ? '—'
                            : model.stats.map((s) => `${s.band}: ${s.up}↑ ${s.down}↓`).join(' · ')}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            data-testid={`model-edit-${model.id}`}
                            onClick={() => startEdit(model)}
                            className="mr-2 rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
                          >
                            Edit
                          </button>
                          <button
                            data-testid={`model-delete-${model.id}`}
                            onClick={() => deleteModel(model)}
                            className="rounded-lg border border-destructive px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {models?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={8}>
                          No models configured.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {activeSection === 'compare' && (
            <section data-testid="admin-compare-section">
              <h3 className="font-heading text-lg font-semibold">Compare</h3>
              <p className="text-xs text-muted-foreground">
                One prompt through the existing agent on selected models (issue #129) — same path as
                the ticket's eval script. Sequential runs; picks inform routing decisions.
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
                <div className="flex flex-wrap gap-3">
                  {models
                    ?.filter((m) => m.tier !== 'guard')
                    .map((model) => (
                      <label key={model.id} className="inline-flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          data-testid={`compare-model-${model.model}`}
                          checked={selectedModelIds.has(model.id)}
                          onChange={() => toggleModelSelected(model.id)}
                        />
                        {model.provider}/{model.model}
                        <span className="text-muted-foreground">({model.tier})</span>
                      </label>
                    ))}
                </div>
                <button
                  data-testid="compare-run"
                  onClick={runComparison}
                  disabled={comparing || !comparePrompt.trim() || selectedModelIds.size === 0}
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
          {activeSection === 'logs' && (
            <section data-testid="admin-logs-section">
              <h3 className="font-heading text-lg font-semibold">Logs</h3>
              <p className="-mt-4 text-xs text-muted-foreground">
                Live server log tail (issue #76) — filters the admin API's in-memory buffer.
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
                {logs.length === 0 && (
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
        </div>
      </div>
    </div>
  );
};

export default AdminView;
