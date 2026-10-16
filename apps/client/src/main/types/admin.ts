// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users. Re-exported from the shared client/server contract
// (issue #20) in apps/shared/src/contracts.ts; the server projection lives in
// apps/server/src/routes/admin.ts.
export type { AdminUser } from '@shared/contracts';
// Public shape of a read-only admin models row, as returned by
// GET /api/admin/models (issue #33). Re-exported from the shared contract.
export type { AdminModel, AdminModelProvider } from '@shared/contracts';
// #168: per-model error diagnostics rows and the full models payload.
export type { AdminModelError, AdminModelsPayload } from '@shared/contracts';
// #217: provider catalog lookup response (GET /api/admin/model-lookup).
export type { AdminModelLookup } from '@shared/contracts';
// Public shape of a log buffer row and the logs response, as returned by
// GET /api/admin/logs (issue #76). Re-exported from the shared contract.
export type { AdminLogEntry, AdminLogsPayload } from '@shared/contracts';
// Model comparison shapes (issue #129), as returned by
// POST /api/admin/model-compare. Re-exported from the shared contract.
export type { ModelComparisonRun, ModelComparisonResult } from '@shared/contracts';
// PAT shapes (#184): list rows (metadata only) and the one-time creation
// response, as returned by GET/POST/DELETE /api/admin/pats.
export type { AdminPat, AdminPatCreated, AdminPatsPayload } from '@shared/contracts';
// LangSmith read view shapes (#186), as returned by
// GET /api/admin/langsmith/traces, /langsmith/traces/:id, /langsmith/stats.
export type {
  AdminTraceRow,
  AdminTracesPayload,
  AdminTraceRun,
  AdminTraceDetail,
  AdminLangsmithModelStats,
  AdminLangsmithStatsPayload,
  AdminSessionCostRow,
  AdminSessionsCostPayload,
} from '@shared/contracts';
// Eval rollup shapes (#225), as returned by GET /api/admin/evals/runs and
// GET /api/admin/evals/runs/:id.
export type {
  AdminEvalScoreCounts,
  AdminEvalRunSummary,
  AdminEvalRunsPayload,
  AdminEvalCaseResult,
  AdminEvalRunDetail,
} from '@shared/contracts';
