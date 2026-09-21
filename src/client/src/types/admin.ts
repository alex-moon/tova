// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users. Re-exported from the shared client/server contract
// (issue #20) in src/shared/contracts.ts; the server projection lives in
// src/server/routes/admin.ts.
export type { AdminUser } from '@shared/contracts';
// Public shape of a read-only admin models row, as returned by
// GET /api/admin/models (issue #33). Re-exported from the shared contract.
export type { AdminModel } from '@shared/contracts';
// Public shape of a log buffer row and the logs response, as returned by
// GET /api/admin/logs (issue #76). Re-exported from the shared contract.
export type { AdminLogEntry, AdminLogsPayload } from '@shared/contracts';
// Model comparison shapes (issue #129), as returned by
// POST /api/admin/model-compare. Re-exported from the shared contract.
export type { ModelComparisonRun, ModelComparisonResult } from '@shared/contracts';
// Per-user entity graph shapes (issue #138), as returned by
// GET /api/admin/graph/*. Re-exported from the shared contract.
export type {
  AdminGraphEntity,
  AdminGraphEdge,
  AdminGraphEntitiesPayload,
  AdminGraphEntityDetail,
  AdminGraphSourceRef,
} from '@shared/contracts';
