import { Fragment, useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import AdminService, {
  AdminError,
  AdminModelsService,
  AdminLogsService,
  AdminGraphService,
  AdminPatsService,
  type ModelInput,
} from '../services/admin';
import AdminLangsmithView from './AdminLangsmithView';
import AdminEvalsView from './AdminEvalsView';
import type {
  AdminLogEntry,
  AdminModelError,
  AdminModel,
  AdminModelLookup,
  AdminPat,
  AdminUser,
  ModelComparisonRun,
  AdminGraphEntitiesPayload,
  AdminGraphEntityDetail,
} from '../types/admin';

const KNOWN_PERMISSIONS = ['routing'];

const LOG_LEVELS = ['all', 'info', 'warn', 'error'] as const;

// #179: retained logs are a 24h window, not a live tail — refresh slowly.
const LOGS_REFRESH_MS = 30000;

/*
 * #168 cool-off badge: approximate remaining hours, computed client-side —
 * expiry itself stays server-authoritative (lazy, on read). Returns null
 * when the model is not cooling off, so callers render nothing.
 */
const coolOffHoursLeft = (disabledUntil: string | null): number | null => {
  if (!disabledUntil) return null;
  const ms = new Date(disabledUntil).getTime() - Date.now();
  if (ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / 3_600_000));
};

/*
 * #199: mirror of the server cap (USD per 1M tokens, in + out). Display-only
 * — the server enforces exclusion from the pools — but the admin table flags
 * a row that would be ruled out so a bad price is visible before it bites.
 */
const MAX_MODEL_PRICE_USD_PER_MTOK = 1.5;

const modelPrice = (m: AdminModel): number | undefined =>
  m.inputPrice !== undefined && m.outputPrice !== undefined
    ? m.inputPrice + m.outputPrice
    : undefined;

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [models, setModels] = useState<AdminModel[] | null>(null);
  // #168 diagnostics: per-model error shapes, rendered as their own table
  // under the models inventory.
  const [modelErrors, setModelErrors] = useState<AdminModelError[]>([]);
  // #219: long error messages are collapsed by default so rows stay a single
  // line; the key is provider/model/status/category.
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [logLevel, setLogLevel] = useState<(typeof LOG_LEVELS)[number]>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  // #179: retained logs come from Grafana Cloud Loki; `configured`/`error`
  // describe graceful degradation (Loki env absent or unreachable).
  const [logsConfigured, setLogsConfigured] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<
    'users' | 'models' | 'logs' | 'compare' | 'graph' | 'traces' | 'evals' | 'access'
  >('users');
  // PATs (#184): Access-tab rows, the generate form, and the one-time
  // plaintext shown right after creation (cleared on reload/navigation —
  // it is never recoverable afterwards).
  const [pats, setPats] = useState<AdminPat[] | null>(null);
  const [patName, setPatName] = useState('');
  const [newPatToken, setNewPatToken] = useState<string | null>(null);
  const [patCopied, setPatCopied] = useState(false);

  // #179: retained logs are one time-window page from Loki (default last
  // 24h), newest first. A filter change re-queries the window; there is no
  // incremental cursor (Loki is queried by time, not id).
  const loadLogs = useCallback(
    async (params: { level?: 'info' | 'warn' | 'error'; q?: string }) => {
      try {
        const res = await AdminLogsService.listLogs({ level: params.level, q: params.q });
        setLogs(res.logs);
        setLogsConfigured(res.configured);
        setLogsError(res.error ?? null);
      } catch (err) {
        // A failed fetch is non-fatal for the rest of the view, but surface it
        // inline so the admin knows the log pane is stale rather than empty.
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

  // Add-a-model flow (#217): the provider catalog supplies context/prices/
  // capabilities, so there is no manual stats form. The admin types a model
  // name, searches, reviews the summary, picks a tier and adds. Provider is
  // fixed to DeepInfra (the dropdown was removed — see
  // docs/plan-217-provider-model-lookup.md, Groq investigation).
  const [lookupModelName, setLookupModelName] = useState('');
  const [lookupTier, setLookupTier] = useState<'small' | 'large'>('small');
  const [lookupResult, setLookupResult] = useState<AdminModelLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  // #217: which row's Refresh is in flight, so its button can show a throbber.
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const resetLookup = () => {
    setLookupResult(null);
    setLookupError(null);
  };

  const runLookup = async () => {
    const name = lookupModelName.trim();
    if (!name) return;
    setLooking(true);
    resetLookup();
    try {
      setLookupResult(await AdminModelsService.lookupModel(name));
    } catch (err) {
      setLookupError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setLooking(false);
    }
  };

  const addLookedUpModel = async () => {
    if (!lookupResult?.found || !lookupResult.model) return;
    const payload: ModelInput = {
      provider: 'deepinfra',
      model: lookupResult.model,
      tier: lookupTier,
      ...(lookupResult.contextLength !== undefined
        ? { contextLength: lookupResult.contextLength }
        : {}),
      ...(lookupResult.inputPrice !== undefined ? { inputPrice: lookupResult.inputPrice } : {}),
      ...(lookupResult.outputPrice !== undefined ? { outputPrice: lookupResult.outputPrice } : {}),
      ...(lookupResult.vision !== undefined ? { vision: lookupResult.vision } : {}),
    };
    try {
      await AdminModelsService.createModel(payload);
      setLookupModelName('');
      resetLookup();
      await loadModels();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  };

  // #217: Refresh re-pulls the provider's current values for an existing row
  // and updates it in place. Only provider-owned fields are overwritten —
  // tier/provider/model/eligible are left alone. Vision is only ever set to
  // true (a catalog that omits the tag must not clobber an admin correction).
  const refreshModel = async (m: AdminModel) => {
    setRefreshingId(m.id);
    try {
      const details = await AdminModelsService.lookupModel(m.model);
      if (!details.found) {
        setError(`Model not found in the ${m.provider} catalog.`);
        return;
      }
      await AdminModelsService.updateModel(m.id, {
        contextLength: details.contextLength ?? null,
        inputPrice: details.inputPrice ?? null,
        outputPrice: details.outputPrice ?? null,
        ...(details.vision ? { vision: true } : {}),
      });
      await loadModels();
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setRefreshingId(null);
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

  // #179: retained logs fetch only while the Logs section is visible (issue
  // #91). A 30s refresh keeps the window current without hammering Loki with
  // an incremental 3s poll — the window is 24h, not a live tail.
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

  // PATs (#184): load-on-demand, only while the Access section is visible.
  // The one-time token box is cleared on leaving the tab (in the nav click
  // below) — the effect stays side-effect-only so nothing cascades.
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

  // Per-user entity graph (issue #138 plan task 5): pick a user, list their
  // nodes paginated, drill into one node for its edges. Load-on-demand and
  // read-only — writes come from extraction, never this tab.
  const [graphUserId, setGraphUserId] = useState<string | null>(null);
  const [graphEntities, setGraphEntities] = useState<AdminGraphEntitiesPayload | null>(null);
  const [graphPage, setGraphPage] = useState(1);
  const [graphDetail, setGraphDetail] = useState<AdminGraphEntityDetail | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);

  const loadGraphEntities = useCallback(async (userId: string, page: number) => {
    setGraphLoading(true);
    try {
      const res = await AdminGraphService.listGraphEntities(userId, page);
      setGraphEntities(res);
      setGraphPage(page);
      setGraphError(null);
    } catch (err) {
      setGraphError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const openGraphDetail = useCallback(async (id: string) => {
    setGraphDetail(null);
    setGraphLoading(true);
    try {
      setGraphDetail(await AdminGraphService.getGraphEntity(id));
    } catch (err) {
      setGraphError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setGraphLoading(false);
    }
  }, []);

  const selectGraphUser = (userId: string) => {
    setGraphUserId(userId);
    setGraphDetail(null);
    if (userId) void loadGraphEntities(userId, 1);
  };

  const sectionContent: {
    id: 'users' | 'models' | 'logs' | 'compare' | 'graph' | 'traces' | 'evals' | 'access';
    label: string;
  }[] = [
    { id: 'users', label: 'Users' },
    { id: 'models', label: 'Models' },
    { id: 'compare', label: 'Compare' },
    { id: 'graph', label: 'Graph' },
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
        <nav
          data-testid="admin-nav"
          className="flex shrink-0 gap-2 overflow-x-auto rounded-xl p-2 lg:flex-col lg:overflow-x-visible panel-surface"
          aria-label="Admin sections"
        >
          {sectionContent.map((section) => (
            <button
              key={section.id}
              data-testid={`admin-tab-${section.id}`}
              onClick={() => {
                // Leaving Access hides the one-time token box for good —
                // the plaintext is unrecoverable after this point.
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
          data-testid="admin-scroller"
          className="min-h-0 flex-1 overflow-y-auto rounded-xl px-4 py-4 ambient-wash"
        >
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
                Routing rows (issue #33/#104) — disable, refresh, add or delete; feedback tallies
                per band. Model details are pulled from the DeepInfra catalog (#217).
              </p>
              <div className="mt-4 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-sm">
                    <span className="mr-2 text-muted-foreground">Model</span>
                    <input
                      data-testid="model-form-model"
                      value={lookupModelName}
                      onChange={(e) => {
                        setLookupModelName(e.target.value);
                        resetLookup();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runLookup();
                      }}
                      placeholder="org/model-name"
                      className="w-full rounded-lg border border-border bg-background px-2 py-1 sm:w-64"
                    />
                  </label>
                  <button
                    data-testid="model-form-search"
                    onClick={() => void runLookup()}
                    disabled={!lookupModelName.trim() || looking}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50"
                  >
                    {looking && (
                      <span
                        data-testid="model-form-search-throbber"
                        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                        aria-hidden="true"
                      />
                    )}
                    {looking ? 'Searching…' : 'Search'}
                  </button>
                  <label className="text-sm">
                    <span className="mr-2 text-muted-foreground">Tier</span>
                    <select
                      data-testid="model-form-tier"
                      value={lookupTier}
                      onChange={(e) => setLookupTier(e.target.value as 'small' | 'large')}
                      className="rounded-lg border border-border bg-background px-2 py-1"
                    >
                      <option value="small">small</option>
                      <option value="large">large</option>
                    </select>
                  </label>
                  {lookupResult?.found && (
                    <button
                      data-testid="model-form-submit"
                      onClick={() => void addLookedUpModel()}
                      className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors"
                    >
                      Add model
                    </button>
                  )}
                </div>
                {lookupError && (
                  <p data-testid="model-form-error" className="mt-3 text-sm text-destructive">
                    {lookupError}
                  </p>
                )}
                {lookupResult && !lookupResult.found && (
                  <p
                    data-testid="model-form-not-found"
                    className="mt-3 text-sm text-muted-foreground"
                  >
                    Model not found
                  </p>
                )}
                {lookupResult?.found && (
                  <dl
                    data-testid="model-form-result"
                    className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"
                  >
                    <div>
                      <dt className="text-xs text-muted-foreground">Model</dt>
                      <dd data-testid="model-form-result-model">{lookupResult.model}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Context</dt>
                      <dd data-testid="model-form-result-context">
                        {lookupResult.contextLength?.toLocaleString() ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">In $/M</dt>
                      <dd data-testid="model-form-result-input-price">
                        {lookupResult.inputPrice !== undefined
                          ? `$${lookupResult.inputPrice.toFixed(3)}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Out $/M</dt>
                      <dd data-testid="model-form-result-output-price">
                        {lookupResult.outputPrice !== undefined
                          ? `$${lookupResult.outputPrice.toFixed(3)}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Capabilities</dt>
                      <dd data-testid="model-form-result-caps">
                        {lookupResult.vision ? 'vision' : 'text'}
                      </dd>
                    </div>
                  </dl>
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
                      <th className="px-4 py-3 font-medium">In $/M</th>
                      <th className="px-4 py-3 font-medium">Out $/M</th>
                      <th className="px-4 py-3 font-medium">In+Out</th>
                      <th className="px-4 py-3 font-medium">Eligible</th>
                      <th className="px-4 py-3 font-medium">Capabilities</th>
                      <th className="px-4 py-3 font-medium">Feedback</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {models?.map((model) => {
                      const coolOff = coolOffHoursLeft(model.disabledUntil);
                      const price = modelPrice(model);
                      const overCap = price !== undefined && price > MAX_MODEL_PRICE_USD_PER_MTOK;
                      return (
                        <tr key={model.id} className="border-b border-border last:border-b-0">
                          <td className="px-4 py-3" data-testid={`admin-model-${model.id}`}>
                            {model.model}
                            {coolOff !== null && (
                              <span
                                data-testid={`admin-model-cooloff-${model.id}`}
                                className="ml-2 inline-block rounded-full border border-warning px-2 py-0.5 text-xs text-warning"
                              >
                                Cooling off · ~{coolOff}h left
                              </span>
                            )}
                            {overCap && (
                              <span
                                data-testid={`admin-model-overcap-${model.id}`}
                                className="ml-2 inline-block rounded-full border border-destructive px-2 py-0.5 text-xs text-destructive"
                              >
                                Over ${MAX_MODEL_PRICE_USD_PER_MTOK.toFixed(2)} cap ✓ excluded
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{model.provider}</td>
                          <td className="px-4 py-3">{model.tier}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {model.contextLength?.toLocaleString() ?? '—'}
                          </td>
                          <td
                            className="px-4 py-3 text-muted-foreground"
                            data-testid={`admin-model-input-price-${model.id}`}
                          >
                            {model.inputPrice !== undefined
                              ? `$${model.inputPrice.toFixed(3)}`
                              : '—'}
                          </td>
                          <td
                            className="px-4 py-3 text-muted-foreground"
                            data-testid={`admin-model-output-price-${model.id}`}
                          >
                            {model.outputPrice !== undefined
                              ? `$${model.outputPrice.toFixed(3)}`
                              : '—'}
                          </td>
                          <td
                            className={`px-4 py-3 ${
                              overCap ? 'font-medium text-destructive' : 'text-muted-foreground'
                            }`}
                            data-testid={`admin-model-price-${model.id}`}
                          >
                            {price !== undefined ? `$${price.toFixed(3)}` : '—'}
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
                              : model.stats
                                  .map((s) => `${s.band}: ${s.up}↑ ${s.down}↓`)
                                  .join(' · ')}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              data-testid={`model-refresh-${model.id}`}
                              onClick={() => void refreshModel(model)}
                              disabled={refreshingId === model.id}
                              className="mr-2 inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                            >
                              {refreshingId === model.id && (
                                <span
                                  data-testid={`model-refresh-throbber-${model.id}`}
                                  className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                                  aria-hidden="true"
                                />
                              )}
                              Refresh
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
                      );
                    })}
                    {models?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={11}>
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
                    — kept in Mongo because deploys wipe the logs. Highlighted rows are currently
                    cooling off.
                  </p>
                  <div
                    data-testid="admin-model-errors"
                    className="mt-2 overflow-x-auto rounded-xl border border-border bg-card"
                  >
                    <table className="w-full text-sm">
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
                          const cooling = (models ?? []).some(
                            (m) =>
                              m.provider === e.provider &&
                              m.model === e.model &&
                              coolOffHoursLeft(m.disabledUntil) !== null,
                          );
                          const rowKey = `${e.provider}/${e.model}/${e.status ?? 'none'}/${e.category}`;
                          const expanded = expandedErrors.has(rowKey);
                          return (
                            <Fragment key={rowKey}>
                              <tr
                                data-testid={`admin-model-error-${e.provider}-${e.model}-${e.status ?? 'none'}`}
                                className="border-b border-border"
                              >
                                <td
                                  className={`px-4 py-3 ${cooling ? 'text-warning' : 'text-muted-foreground'}`}
                                >
                                  {e.provider}/{e.model}
                                </td>
                                <td className="px-4 py-3">
                                  {e.status !== null ? `${e.status} · ` : ''}
                                  {e.category}
                                </td>
                                <td className="px-4 py-3 text-muted-foreground">{e.count}</td>
                                <td className="px-4 py-3 text-muted-foreground">
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
          {activeSection === 'graph' && (
            <section data-testid="admin-graph-section">
              <h3 className="font-heading text-lg font-semibold">Graph</h3>
              <p className="text-xs text-muted-foreground">
                Per-user entity graph (issue #138) — nodes and edges extracted across chats, with
                source links for audit.
              </p>
              <div className="mt-4">
                <label className="text-sm">
                  <span className="mr-2 text-muted-foreground">User</span>
                  <select
                    data-testid="graph-user-select"
                    value={graphUserId ?? ''}
                    onChange={(e) => selectGraphUser(e.target.value)}
                    className="rounded-lg border border-border bg-background px-2 py-1"
                  >
                    <option value="">Select a user…</option>
                    {users?.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.email}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {graphError && (
                <div
                  data-testid="graph-error"
                  className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {graphError}
                </div>
              )}
              {graphLoading && <p className="mt-4 text-sm text-muted-foreground">Loading graph…</p>}
              {graphEntities && (
                <div
                  data-testid="admin-graph-entities"
                  className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"
                >
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-4 py-3 font-medium">Name</th>
                        <th className="px-4 py-3 font-medium">Kind</th>
                        <th className="px-4 py-3 font-medium">Mentions</th>
                        <th className="px-4 py-3 font-medium">Confidence</th>
                        <th className="px-4 py-3 font-medium">Sources</th>
                        <th className="px-4 py-3">
                          {graphEntities.total > graphEntities.limit && (
                            <span className="text-muted-foreground">
                              page {graphEntities.page} /{' '}
                              {Math.ceil(graphEntities.total / graphEntities.limit)}
                            </span>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {graphEntities.entities.map((entity) => (
                        <tr key={entity.id} className="border-b border-border last:border-b-0">
                          <td className="px-4 py-3" data-testid={`graph-entity-${entity.id}`}>
                            {entity.name}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{entity.kind}</td>
                          <td className="px-4 py-3">{entity.mentionCount}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {entity.confidence.toFixed(2)}
                            {entity.salience === 'high' ? ' · salient' : ''}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {entity.sourceRefs.length}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              data-testid={`graph-open-${entity.id}`}
                              onClick={() => openGraphDetail(entity.id)}
                              className="rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
                            >
                              Detail
                            </button>
                          </td>
                        </tr>
                      ))}
                      {graphEntities.entities.length === 0 && (
                        <tr>
                          <td className="px-4 py-3 text-muted-foreground" colSpan={6}>
                            No entities for this user yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {graphEntities.total > graphEntities.limit && (
                    <div className="flex gap-2 px-4 py-3">
                      <button
                        data-testid="graph-page-prev"
                        disabled={graphEntities.page <= 1}
                        onClick={() => graphUserId && loadGraphEntities(graphUserId, graphPage - 1)}
                        className="rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50"
                      >
                        Prev
                      </button>
                      <button
                        data-testid="graph-page-next"
                        disabled={
                          graphEntities.page >= Math.ceil(graphEntities.total / graphEntities.limit)
                        }
                        onClick={() => graphUserId && loadGraphEntities(graphUserId, graphPage + 1)}
                        className="rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}
              {graphDetail && (
                <div
                  data-testid="admin-graph-detail"
                  className="mt-4 rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4
                        className="font-heading text-base font-semibold"
                        data-testid="graph-detail-name"
                      >
                        {graphDetail.entity.name}
                      </h4>
                      <p className="text-xs text-muted-foreground">{graphDetail.entity.kind}</p>
                    </div>
                    <button
                      data-testid="graph-detail-close"
                      onClick={() => setGraphDetail(null)}
                      className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                      Close
                    </button>
                  </div>
                  {graphDetail.entity.summary && (
                    <p className="mt-2 text-sm">{graphDetail.entity.summary}</p>
                  )}
                  {graphDetail.entity.sourceRefs.length > 0 && (
                    <p
                      className="mt-2 text-xs text-muted-foreground"
                      data-testid="graph-detail-sources"
                    >
                      {graphDetail.entity.sourceRefs.length} source
                      {graphDetail.entity.sourceRefs.length === 1 ? '' : 's'} — first session{' '}
                      {graphDetail.entity.sourceRefs[0].sessionId.slice(-6)}
                    </p>
                  )}
                  <h5 className="mt-4 text-sm font-medium">Edges</h5>
                  {graphDetail.edges.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No edges.</p>
                  ) : (
                    <ul data-testid="graph-detail-edges" className="mt-2 divide-y divide-border">
                      {graphDetail.edges.map((edge) => (
                        <li key={edge.id} className="py-2 text-sm">
                          {edge.fromName} —{' '}
                          <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                            {edge.kind}
                          </span>{' '}
                          → {edge.toName}
                          {edge.summary && (
                            <span className="text-muted-foreground"> · {edge.summary}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
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
                <table data-testid="admin-pats" className="w-full text-sm">
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
                        <td className="px-4 py-3">{pat.name}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(pat.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {pat.lastUsedAt ? new Date(pat.lastUsedAt).toLocaleString() : 'never'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {pat.expiresAt ? new Date(pat.expiresAt).toLocaleString() : 'never'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{pat.creatorEmail}</td>
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
