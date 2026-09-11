import { useState, useEffect, useCallback } from 'react';
import AdminService, { getErrorMessage } from '../services/admin';
import type { AdminUser } from '../types/admin';

const KNOWN_PERMISSIONS = ['routing'];

const AdminView = () => {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const res = await AdminService.listUsers();
      setUsers(res);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load users.'));
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
      setError(getErrorMessage(err, 'Failed to update permissions.'));
    }
  };

  const toggleRole = async (user: AdminUser) => {
    const role = user.role === 'admin' ? 'user' : 'admin';
    try {
      const res = await AdminService.updateRole(user.id, role);
      updateUser(res);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update role.'));
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadUsers();
  }, [loadUsers]);

  return (
    <div data-testid="admin-view">
      <div>{error && <div data-testid="admin-error">{error}</div>}</div>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Google</th>
            <th>Permissions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users?.map((user) => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td data-testid={`role-${user.email}`}>{user.role}</td>
              <td>{user.hasGoogle ? 'yes' : 'no'}</td>
              <td>
                {KNOWN_PERMISSIONS.map((permission) => (
                  <label key={permission} style={{ marginRight: '0.5rem' }}>
                    <input
                      type="checkbox"
                      data-testid={`perm-${permission}-${user.email}`}
                      checked={user.permissions.includes(permission)}
                      onChange={() => togglePermission(user, permission)}
                    />{' '}
                    {permission}
                  </label>
                ))}
              </td>
              <td>
                <button data-testid={`toggle-role-${user.email}`} onClick={() => toggleRole(user)}>
                  {user.role === 'admin' ? 'Demote' : 'Promote'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default AdminView;
