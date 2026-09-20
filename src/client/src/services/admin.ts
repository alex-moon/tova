import axios from 'axios';
import type { AdminModel, AdminUser, AdminLogsPayload, ModelComparisonRun } from '../types/admin';

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

// Model inventory with CRUD (issue #104): list, create, update, delete
// routing rows in the admin view. Mutations return the row id (POST/PUT) or
// nothing (DELETE); callers refetch for the authoritative list.
type ModelInput = Partial<Omit<AdminModel, 'id' | 'stats' | 'contextLength'>> & {
  contextLength?: number | null;
};

const listModels = async (): Promise<AdminModel[]> => {
  try {
    const res = await axios.get<AdminModel[]>('/api/admin/models');
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load models.');
  }
};

const createModel = async (payload: ModelInput): Promise<{ id: string }> => {
  try {
    const res = await axios.post<{ id: string }>('/api/admin/models', payload);
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to create model.');
  }
};

const updateModel = async (id: string, payload: ModelInput): Promise<{ id: string }> => {
  try {
    const res = await axios.put<{ id: string }>(`/api/admin/models/${id}`, payload);
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to update model.');
  }
};

const deleteModel = async (id: string): Promise<void> => {
  try {
    await axios.delete(`/api/admin/models/${id}`);
  } catch (err) {
    throw toAdminError(err, 'Failed to delete model.');
  }
};

// Direct model comparison (issue #129): one prompt through the existing
// agent on chosen model rows. Row shape mirrors the models payload so the
// view can forward selections straight from the inventory table.
const compareModels = async (
  prompt: string,
  models: { provider: string; model: string; contextLength?: number }[],
): Promise<ModelComparisonRun> => {
  try {
    const res = await axios.post<ModelComparisonRun>('/api/admin/model-compare', {
      prompt,
      models,
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to run model comparison.');
  }
};

const AdminModelsService = { listModels, createModel, updateModel, deleteModel, compareModels };

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
