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
  AdminGraphEntitiesPayload,
  AdminGraphEntityDetail,
  AdminTracesPayload,
  AdminTraceDetail,
  AdminLangsmithStatsPayload,
  AdminSessionsCostPayload,
} from '../types/admin';

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
// nothing (DELETE); callers refetch for the authoritative list. #168: the
// list also carries per-model error diagnostics (deploy wipes logs, so the
// shapes accumulate in Mongo instead).
export type ModelInput = Partial<
  Omit<AdminModel, 'id' | 'stats' | 'contextLength' | 'inputPrice' | 'outputPrice'>
> & {
  contextLength?: number | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
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

// #217: provider catalog lookup. The provider is fixed to DeepInfra (the
// dropdown was removed — see docs/plan-217-provider-model-lookup.md); the
// response's `found: false` is a normal miss, not an error.
const lookupModel = async (model: string): Promise<AdminModelLookup> => {
  try {
    const res = await axios.get<AdminModelLookup>('/api/admin/model-lookup', {
      params: { provider: 'deepinfra', model },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to look up model.');
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

// Retained logs (#179): one time-window page from Grafana Cloud Loki. No
// cursor — the view re-queries the window; `configured`/`error` describe
// degradation when Loki is absent or unreachable.
const listLogs = async (params: ListLogsParams = {}): Promise<AdminLogsPayload> => {
  try {
    const res = await axios.get<AdminLogsPayload>('/api/admin/logs', { params });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load logs.');
  }
};

const AdminLogsService = { listLogs };

// Per-user entity graph read view (issue #138, plan task 5): the Graph tab
// picks a user, lists their nodes paginated, and drills into one node for
// its edges with the other endpoint's name already resolved by the server.
const listGraphEntities = async (userId: string, page = 1): Promise<AdminGraphEntitiesPayload> => {
  try {
    const res = await axios.get<AdminGraphEntitiesPayload>('/api/admin/graph/entities', {
      params: { userId, page },
    });
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load graph entities.');
  }
};

const getGraphEntity = async (id: string): Promise<AdminGraphEntityDetail> => {
  try {
    const res = await axios.get<AdminGraphEntityDetail>(`/api/admin/graph/entities/${id}`);
    return res.data;
  } catch (err) {
    throw toAdminError(err, 'Failed to load graph entity.');
  }
};

const AdminGraphService = { listGraphEntities, getGraphEntity };

// PAT management (#184): the Access tab's list/generate/revoke. The create
// response carries the plaintext token exactly once — nothing here ever
// stores or re-fetches it.
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

// LangSmith read view (#186): recent traces with a drill-down tree, and the
// per-model stats rollup — the evidence-first routing loop, in-app.
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

// #224: per-session cost breakdown from our own Message rows (no LangSmith).
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

export {
  AdminModelsService,
  AdminLogsService,
  AdminGraphService,
  AdminPatsService,
  AdminLangsmithService,
};
