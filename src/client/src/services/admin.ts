import axios from 'axios';
import type { AdminModel, AdminUser, AdminLogsPayload } from '../types/admin';

// Normalised admin failure: message comes from the server response when one
// arrived, otherwise the call's fallback. Views catch AdminError and read
// .message without importing axios (PR #27 review).
export class AdminError extends Error {
  constructor(message = 'Something went wrong.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AdminError';
  }
}

const toAdminError = (err: unknown, fallback: string): AdminError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new AdminError(message, { cause: err });
  }
  return new AdminError(fallback, { cause: err });
};

// Connector separating views from axios. All admin API traffic goes through
// this class; views should not import axios directly (PR #19 review).
const AdminService = {
  async listUsers(): Promise<AdminUser[]> {
    try {
      const res = await axios.get<AdminUser[]>('/api/admin/users');
      return res.data;
    } catch (err) {
      throw toAdminError(err, 'Failed to load users.');
    }
  },

  async updatePermissions(id: string, permissions: string[]): Promise<AdminUser> {
    try {
      const res = await axios.put<AdminUser>(`/api/admin/users/${id}/permissions`, { permissions });
      return res.data;
    } catch (err) {
      throw toAdminError(err, 'Failed to update permissions.');
    }
  },

  async updateRole(id: string, role: 'user' | 'admin'): Promise<AdminUser> {
    try {
      const res = await axios.put<AdminUser>(`/api/admin/users/${id}/role`, { role });
      return res.data;
    } catch (err) {
      throw toAdminError(err, 'Failed to update role.');
    }
  },
};

export default AdminService;

// Read-only model inventory (issue #33): no actions, list only.
const listModels = async (): Promise<AdminModel[]> => {
  try {
    const res = await axios.get<AdminModel[]>('/api/admin/models');
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load models.');
  }
};

const AdminModelsService = { listModels };

export interface ListLogsParams {
  level?: 'info' | 'warn' | 'error';
  q?: string;
  cursor?: number;
}

// Read-only log tail (issue #76): `cursor` from a previous response returns
// only newer entries so polling stays incremental.
const listLogs = async (params: ListLogsParams = {}): Promise<AdminLogsPayload> => {
  try {
    const res = await axios.get<AdminLogsPayload>('/api/admin/logs', { params });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load logs.');
  }
};

const AdminLogsService = { listLogs };

export { AdminModelsService, AdminLogsService };
