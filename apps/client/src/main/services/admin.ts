import axios from 'axios';
import type {
  AdminModel,
  AdminModelsPayload,
  AdminModelLookup,
  AdminUser,
  AdminLogsPayload,
  AdminPatCreated,
  AdminPatsPayload,
  ModelComparisonRun,
  AdminTracesPayload,
  AdminTraceDetail,
  AdminLangsmithStatsPayload,
  AdminEvalRunsPayload,
  AdminEvalRunDetail,
  AdminSessionsCostPayload,
} from '../types/admin';

// Normalised admin failure: server message when one arrived, else the fallback; views read .message without importing axios.
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

// Connector separating views from axios; all admin API traffic goes through this class.
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

// Model inventory CRUD over roster rows; mutations return the row id, callers refetch; the list carries per-model error diagnostics.
// @see #104 #234 #168
export type ModelInput = Partial<
  Omit<AdminModel, 'id' | 'providers' | 'contextLength' | 'inputPrice' | 'outputPrice'>
> & {
  contextLength?: number | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  providers?: { provider: string; modelId: string; enabled?: boolean }[];
};

const listModels = async (): Promise<AdminModelsPayload> => {
  try {
    const res = await axios.get<AdminModelsPayload>('/api/admin/models');
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

// Provider catalog lookup; `found: false` is a normal miss, not an error.
// @see #217 #234
const lookupModel = async (
  provider: 'deepinfra' | 'fireworks',
  model: string,
): Promise<AdminModelLookup> => {
  try {
    const res = await axios.get<AdminModelLookup>('/api/admin/model-lookup', {
      params: { provider, model },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to look up model.');
  }
};

// Direct model comparison: one prompt through the existing agent on chosen model rows.
// @see #129
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

const AdminModelsService = {
  listModels,
  createModel,
  updateModel,
  deleteModel,
  compareModels,
  lookupModel,
};

export interface ListLogsParams {
  level?: 'info' | 'warn' | 'error';
  q?: string;
  hours?: number;
  limit?: number;
}

// Retained logs: one time-window page from Grafana Cloud Loki; no cursor.
// @see #179
const listLogs = async (params: ListLogsParams = {}): Promise<AdminLogsPayload> => {
  try {
    const res = await axios.get<AdminLogsPayload>('/api/admin/logs', { params });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load logs.');
  }
};

const AdminLogsService = { listLogs };

// PAT list/generate/revoke; the create response carries the plaintext token exactly once.
// @see #184
const listPats = async (): Promise<AdminPatsPayload> => {
  try {
    const res = await axios.get<AdminPatsPayload>('/api/admin/pats');
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load tokens.');
  }
};

const createPat = async (name: string): Promise<AdminPatCreated> => {
  try {
    const res = await axios.post<{ pat: AdminPatCreated }>('/api/admin/pats', { name });
    return res.data.pat;
  } catch (err) {
    throw toAdminError(err, 'Failed to create token.');
  }
};

const revokePat = async (id: string): Promise<void> => {
  try {
    await axios.delete(`/api/admin/pats/${id}`);
  } catch (err) {
    throw toAdminError(err, 'Failed to revoke token.');
  }
};

const AdminPatsService = { listPats, createPat, revokePat };

// LangSmith read view: recent traces with a drill-down tree, and the per-model stats rollup.
// @see #186
export interface ListTracesParams {
  errorsOnly?: boolean;
  model?: string;
}

const listTraces = async (params: ListTracesParams = {}): Promise<AdminTracesPayload> => {
  try {
    const res = await axios.get<AdminTracesPayload>('/api/admin/langsmith/traces', {
      params: {
        ...(params.errorsOnly ? { errorsOnly: 'true' } : {}),
        ...(params.model ? { model: params.model } : {}),
      },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load LangSmith traces.');
  }
};

const getTrace = async (traceId: string): Promise<AdminTraceDetail> => {
  try {
    const res = await axios.get<AdminTraceDetail>(
      `/api/admin/langsmith/traces/${encodeURIComponent(traceId)}`,
    );
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load LangSmith trace.');
  }
};

const listStats = async (days = 7): Promise<AdminLangsmithStatsPayload> => {
  try {
    const res = await axios.get<AdminLangsmithStatsPayload>('/api/admin/langsmith/stats', {
      params: { days },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load LangSmith stats.');
  }
};

// Per-session cost breakdown from our own Message rows (no LangSmith).
// @see #224
const listSessionCosts = async (days = 7): Promise<AdminSessionsCostPayload> => {
  try {
    const res = await axios.get<AdminSessionsCostPayload>('/api/admin/langsmith/sessions', {
      params: { days },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load session costs.');
  }
};

const AdminLangsmithService = { listTraces, getTrace, listStats, listSessionCosts };

// Eval rollup read view: recent suite runs, per-case breakdown, manual "Run now" (starts in the background).
// @see #225
const listEvalRuns = async (limit?: number): Promise<AdminEvalRunsPayload> => {
  try {
    const res = await axios.get<AdminEvalRunsPayload>('/api/admin/evals/runs', {
      params: limit ? { limit } : {},
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load eval runs.');
  }
};

const getEvalRun = async (id: string): Promise<AdminEvalRunDetail> => {
  try {
    const res = await axios.get<AdminEvalRunDetail>(
      `/api/admin/evals/runs/${encodeURIComponent(id)}`,
    );
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load eval run.');
  }
};

const runEvalsNow = async (): Promise<{ id: string }> => {
  try {
    const res = await axios.post<{ id: string }>('/api/admin/evals/run');
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to start eval run.');
  }
};

const AdminEvalsService = { listEvalRuns, getEvalRun, runEvalsNow };

export {
  AdminModelsService,
  AdminLogsService,
  AdminPatsService,
  AdminLangsmithService,
  AdminEvalsService,
};
