import { useState, useEffect, useCallback } from 'react';
import AdminService, { AdminError, AdminModelsService } from '../services/admin';
import type { AdminModel, AdminUser } from '../types/admin';
import ScrollablePanel from './ScrollablePanel';

const KNOWN_PERMISSIONS = ['routing'];

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [models, setModels] = useState<AdminModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ScrollablePanel
      title="Admin"
      panelTestId="admin-view"
      panelClassName="h-full max-h-none rounded-none border-none bg-background text-foreground p-6"
      bodyClassName="space-y-6"
    >
      {!users && !error && <p className="text-sm text-muted-foreground">Loading users...</p>}
      {error && (
        <div
          data-testid="admin-error"
          className="rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
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
                <td className="px-4 py-3 text-muted-foreground">{user.hasGoogle ? 'yes' : 'no'}</td>
                <td className="px-4 py-3">
                  {KNOWN_PERMISSIONS.map((permission) => (
                    <label key={permission} className="mr-4 inline-flex items-center gap-1.5">
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
      <h3 className="font-heading text-lg font-semibold">Models</h3>
      <p className="-mt-4 text-xs text-muted-foreground">
        Read-only (issue #33) — routing bands and feedback tallies.
      </p>
      <div
        data-testid="admin-models"
        className="overflow-x-auto rounded-xl border border-border bg-card"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 font-medium">Bands</th>
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
                <td className="px-4 py-3 text-muted-foreground">
                  {model.stats.length === 0
                    ? '—'
                    : model.stats.map((s) => `${s.band}: ${s.up}↑ ${s.down}↓`).join(' · ')}
                </td>
              </tr>
            ))}
            {models?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-muted-foreground" colSpan={4}>
                  No models configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </ScrollablePanel>
  );
};

export default AdminView;
