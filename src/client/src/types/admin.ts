// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users. Re-exported from the shared client/server contract
// (issue #20) in src/shared/contracts.ts; the server projection lives in
// src/server/routes/admin.ts.
export type { AdminUser } from '@shared/contracts';
// Public shape of a read-only admin models row, as returned by
// GET /api/admin/models (issue #33). Re-exported from the shared contract.
export type { AdminModel } from '@shared/contracts';
