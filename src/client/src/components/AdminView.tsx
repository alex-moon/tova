import { useState, useEffect, useCallback, useRef } from 'react';
import AdminService, { AdminError, AdminModelsService, AdminLogsService } from '../services/admin';
import type { AdminLogEntry, AdminModel, AdminUser } from '../types/admin';

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
  const [activeSection, setActiveSection] = useState<'users' | 'models' | 'logs'>('users');

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
    } catch (err) {
      setError(err instanceof AdminError ? err.message : 'Something went wrong.');
    }
  }, []);

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

  const sectionContent: { id: 'users' | 'models' | 'logs'; label: string }[] = [
    { id: 'users', label: 'Users' },
    { id: 'models', label: 'Models' },
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
                Read-only (issue #33) — routing bands and feedback tallies.
              </p>
              <div
                data-testid="admin-models"
                className="mt-4 overflow-x-auto rounded-xl border border-border bg-card"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Model</th>
                      <th className="px-4 py-3 font-medium">Provider</th>
                      <th className="px-4 py-3 font-medium">Bands</th>
                      <th className="px-4 py-3 font-medium">Capabilities</th>
                      <th className="px-4 py-3 font-medium">Feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models?.map((model) => (
                      <tr key={model.id} className="border-b border-border last:border-b-0">
                        <td className="px-4 py-3" data-testid={`admin-model-${model.id}`}>
                          {model.model}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{model.provider}</td>
                        <td className="px-4 py-3">{model.tiers.join(', ')}</td>
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
                      </tr>
                    ))}
                    {models?.length === 0 && (
                      <tr>
                        <td className="px-4 py-3 text-muted-foreground" colSpan={5}>
                          No models configured.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
