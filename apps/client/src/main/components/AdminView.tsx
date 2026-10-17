import { Fragment, useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import AdminService, {
  AdminError,
  AdminModelsService,
  AdminLogsService,
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
} from '../types/admin';

const KNOWN_PERMISSIONS = ['routing'];

const LOG_LEVELS = ['all', 'info', 'warn', 'error'] as const;

// Retained logs are a 24h window, not a live tail — refresh slowly.
// @see #179
const LOGS_REFRESH_MS = 30000;

// Approximate client-side cool-off hours; null when not cooling off. Expiry stays server-authoritative.
// @see #168
const coolOffHoursLeft = (disabledUntil: string | null): number | null => {
  if (!disabledUntil) return null;
  const ms = new Date(disabledUntil).getTime() - Date.now();
  if (ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / 3_600_000));
};

// The exact TTFT figure the router scores on, so operators see what the router sees.
// @see #234
const formatTtft = (ms: number | undefined, samples: number | undefined): string => {
  if (ms === undefined) return '—';
  const mean = `${Math.round(ms)} ms`;
  return samples !== undefined ? `${mean} (${samples})` : mean;
};

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [models, setModels] = useState<AdminModel[] | null>(null);
  // @see #168
  const [modelErrors, setModelErrors] = useState<AdminModelError[]>([]);
  // Long error messages collapsed by default; the expand key is provider/model/status/category.
  // @see #219
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [logLevel, setLogLevel] = useState<(typeof LOG_LEVELS)[number]>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  // `configured`/`error` describe graceful degradation (Loki env absent or unreachable).
  // @see #179
  const [logsConfigured, setLogsConfigured] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<
    'users' | 'models' | 'logs' | 'compare' | 'traces' | 'evals' | 'access'
  >('users');
  // PAT rows plus the one-time plaintext shown right after creation; cleared on reload/navigation, never recoverable.
  // @see #184
  const [pats, setPats] = useState<AdminPat[] | null>(null);
  const [patName, setPatName] = useState('');
  const [newPatToken, setNewPatToken] = useState<string | null>(null);
  const [patCopied, setPatCopied] = useState(false);

  // A filter change re-queries the time window; there is no incremental cursor (Loki is queried by time, not id).
  // @see #179
  const loadLogs = useCallback(
    async (params: { level?: 'info' | 'warn' | 'error'; q?: string }) => {
      try {
        const res = await AdminLogsService.listLogs({ level: params.level, q: params.q });
        setLogs(res.logs);
        setLogsConfigured(res.configured);
        setLogsError(res.error ?? null);
      } catch (err) {
        // Surface the failure inline so the admin knows the log pane is stale rather than empty.
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

  // Direct model comparison: pick provider entries, type a prompt, run each side by side; cap mirrored server-side.
  // @see #129 #234
  const [comparePrompt, setComparePrompt] = useState('');
  const [selectedCompareKeys, setSelectedCompareKeys] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<ModelComparisonRun | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const compareKey = (provider: string, modelId: string) => `${provider}|${modelId}`;

  // One checkbox per provider entry, so a roster's raced backends are individually selectable.
  const compareEntries = (models ?? []).flatMap((m) =>
    m.providers.map((p) => ({
      key: compareKey(p.provider, p.modelId),
      provider: p.provider,
      modelId: p.modelId,
      contextLength: m.contextLength,
    })),
  );

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
      // The response preserves the server's sequential execution order, so render directly from it.
      setComparison(run);
    } catch (err) {
      setCompareError(err instanceof AdminError ? err.message : 'Something went wrong.');
    } finally {
      setComparing(false);
    }
  };

  // Add-a-model flow: provider catalogs supply context/prices/capabilities — no manual stats form; both providers resolve into `providers[]`.
  // @see #217 #234
  const [lookupModelName, setLookupModelName] = useState('');
  const [lookupDeepinfra, setLookupDeepinfra] = useState<AdminModelLookup | null>(null);
  const [lookupFireworks, setLookupFireworks] = useState<AdminModelLookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  // @see #217
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  // Summary is DeepInfra-first (the only catalog with prices); Fireworks fills in when DeepInfra is absent.
  const lookupFound = (lookupDeepinfra?.found ?? false) || (lookupFireworks?.found ?? false);
  const lookupSummary = lookupDeepinfra?.found ? lookupDeepinfra : lookupFireworks;

  const resetLookup = () => {
    setLookupDeepinfra(null);
    setLookupFireworks(null);
    setLookupError(null);
  };

  const runLookup = async () => {
    const name = lookupModelName.trim();
    if (!name) return;
    setLooking(true);
    resetLookup();
    // Each provider is settled independently so one failure cannot hide a hit; both failing surfaces the error, not "not found".
    const settle = (p: Promise<AdminModelLookup>) =>
      p.then(
        (result) => ({ result, error: null as string | null }),
        (e: unknown) => ({
          result: { found: false } as AdminModelLookup,
          error: e instanceof AdminError ? e.message : 'Something went wrong.',
        }),
      );
    const [deepinfra, fireworks] = await Promise.all([
      settle(AdminModelsService.lookupModel('deepinfra', name)),
      settle(AdminModelsService.lookupModel('fireworks', name)),
    ]);
    setLookupDeepinfra(deepinfra.result);
    setLookupFireworks(fireworks.result);
    if (
      !deepinfra.result.found &&
      !fireworks.result.found &&
      (deepinfra.error || fireworks.error)
    ) {
      setLookupError(deepinfra.error ?? fireworks.error);
    }
    setLooking(false);
  };

  const addLookedUpModel = async () => {
    if (!lookupFound) return;
    const name = lookupModelName.trim();
    const providers: { provider: string; modelId: string }[] = [];
    // DeepInfra keys the roster modelId directly; Fireworks stores its own accounts/fireworks/models/... id.
    if (lookupDeepinfra?.found) providers.push({ provider: 'deepinfra', modelId: name });
    if (lookupFireworks?.found) {
      providers.push({ provider: 'fireworks', modelId: lookupFireworks.model ?? name });
    }
    const payload: ModelInput = {
      modelId: name,
      label: name,
      providers,
      ...(lookupSummary?.contextLength !== undefined
        ? { contextLength: lookupSummary.contextLength }
        : {}),
      // Only DeepInfra publishes prices; Fireworks leaves them unknown, which the weighted score treats as neutral.
      ...(lookupDeepinfra?.inputPrice !== undefined
        ? { inputPrice: lookupDeepinfra.inputPrice }
        : {}),
      ...(lookupDeepinfra?.outputPrice !== undefined
        ? { outputPrice: lookupDeepinfra.outputPrice }
        : {}),
      ...(lookupSummary?.vision ? { vision: true } : {}),
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

  // Refresh overwrites only provider-owned model-level fields; vision is only ever set true so it cannot clobber an admin correction.
  // @see #217
  const refreshModel = async (m: AdminModel) => {
    setRefreshingId(m.id);
    try {
      const details = await AdminModelsService.lookupModel('deepinfra', m.modelId);
      if (!details.found) {
        setError(`Model not found in the deepinfra catalog.`);
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

  // Send the full provider list with just the toggled entry flipped, so the server merges and preserves system-owned fields.
  // @see #234
  const toggleProviderEnabled = async (m: AdminModel, providerId: string) => {
    try {
      await AdminModelsService.updateModel(m.id, {
        providers: m.providers.map((p) => ({
          provider: p.provider,
          modelId: p.modelId,
          enabled: p.provider === providerId ? !p.enabled : p.enabled,
        })),
      });
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

  // Retained logs fetch only while the Logs section is visible; the 30s window refresh avoids a live-tail poll.
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
                  // Leaving Access clears the one-time token box for good — the plaintext is unrecoverable.
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
                Roster models (issue #33/#104/#234) — one row per model with its two raced
                providers. Disable a provider, refresh model details, add or delete; the live TTFT
                is the exact figure the router scores on. Details are pulled from the DeepInfra
                catalog (prices) and Fireworks (capabilities) (#217).
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
                  {lookupFound && (
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
                {lookupDeepinfra && lookupFireworks && !lookupFound && !lookupError && (
                  <p
                    data-testid="model-form-not-found"
                    className="mt-3 text-sm text-muted-foreground"
                  >
                    Model not found
                  </p>
                )}
                {lookupFound && lookupSummary && (
                  <dl
                    data-testid="model-form-result"
                    className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"
                  >
                    <div>
                      <dt className="text-xs text-muted-foreground">Model</dt>
                      <dd data-testid="model-form-result-model">{lookupSummary.model}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Context</dt>
                      <dd data-testid="model-form-result-context">
                        {lookupSummary.contextLength?.toLocaleString() ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">In $/M</dt>
                      <dd data-testid="model-form-result-input-price">
                        {lookupSummary.inputPrice !== undefined
                          ? `$${lookupSummary.inputPrice.toFixed(3)}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Out $/M</dt>
                      <dd data-testid="model-form-result-output-price">
                        {lookupSummary.outputPrice !== undefined
                          ? `$${lookupSummary.outputPrice.toFixed(3)}`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Capabilities</dt>
                      <dd data-testid="model-form-result-caps">
                        {lookupSummary.vision ? 'vision' : 'text'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Providers</dt>
                      <dd data-testid="model-form-result-providers">
                        {[
                          lookupDeepinfra?.found ? 'deepinfra' : null,
                          lookupFireworks?.found ? 'fireworks' : null,
                        ]
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </dd>
                    </div>
                  </dl>
                )}
              </div>
              <div
                data-testid="admin-models"
                className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"
              >
                <table className="responsive-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 font-medium">Providers</th>
                      <th className="px-4 py-3 font-medium">Context</th>
                      <th className="px-4 py-3 font-medium">In / Out $/M</th>
                      <th className="px-4 py-3 font-medium">Eligible</th>
                      <th className="px-4 py-3 font-medium">Capabilities</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {models?.map((model) => (
                      <tr key={model.id} className="border-b border-border last:border-b-0">
                        <td
                          className="px-4 py-3"
                          data-label="Model"
                          data-testid={`admin-model-${model.id}`}
                        >
                          {model.label}
                        </td>
                        <td className="px-4 py-3" data-label="Providers">
                          <ul
                            className="flex flex-col gap-1"
                            data-testid={`admin-model-providers-${model.id}`}
                          >
                            {model.providers.map((p) => {
                              const coolOff = coolOffHoursLeft(p.disabledUntil);
                              return (
                                <li
                                  key={p.provider}
                                  className="flex items-center gap-2 text-muted-foreground"
                                  data-testid={`admin-model-provider-${model.id}-${p.provider}`}
                                >
                                  <input
                                    type="checkbox"
                                    data-testid={`provider-enabled-${model.id}-${p.provider}`}
                                    checked={p.enabled}
                                    onChange={() => void toggleProviderEnabled(model, p.provider)}
                                    title={`Race ${p.provider} for this model`}
                                  />
                                  <span className="font-mono text-xs">{p.provider}</span>
                                  <span
                                    className="text-xs"
                                    data-testid={`provider-ttft-${model.id}-${p.provider}`}
                                  >
                                    TTFT {formatTtft(p.ttftMs, p.ttftSamples)}
                                  </span>
                                  {coolOff !== null && (
                                    <span
                                      data-testid={`admin-model-cooloff-${model.id}-${p.provider}`}
                                      className="inline-block rounded-full border border-warning px-2 py-0.5 text-xs text-warning"
                                    >
                                      Cooling off · ~{coolOff}h left
                                    </span>
                                  )}
                                </li>
                              );
                            })}
                            {model.providers.length === 0 && (
                              <li className="text-xs text-muted-foreground">No providers</li>
                            )}
                          </ul>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground" data-label="Context">
                          {model.contextLength?.toLocaleString() ?? '—'}
                        </td>
                        <td
                          className="px-4 py-3 text-muted-foreground"
                          data-label="In / Out $/M"
                          data-testid={`admin-model-price-${model.id}`}
                        >
                          {model.inputPrice !== undefined && model.outputPrice !== undefined
                            ? `$${model.inputPrice.toFixed(3)} / $${model.outputPrice.toFixed(3)}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3" data-label="Eligible">
                          <input
                            type="checkbox"
                            data-testid={`model-eligible-${model.id}`}
                            checked={model.eligible}
                            onChange={() => toggleModelEligible(model)}
                          />
                        </td>
                        <td
                          className="px-4 py-3"
                          data-label="Capabilities"
                          data-testid={`admin-model-caps-${model.id}`}
                        >
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
                    ))}
                    {models?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={7}>
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
                          // The error tally is keyed provider+modelId; a row is cooling off when that entry's cool-off is in the future.
                          // @see #234
                          const cooling = (models ?? []).some((m) =>
                            m.providers.some(
                              (p) =>
                                p.provider === e.provider &&
                                p.modelId === e.model &&
                                coolOffHoursLeft(p.disabledUntil) !== null,
                            ),
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
                                  data-label="Model"
                                >
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
                One prompt through the existing agent on selected provider entries (issue #129) —
                each roster model offers its two raced backends, so a 3-model roster is up to six
                runs. Sequential; picks inform routing decisions.
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
