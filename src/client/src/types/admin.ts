// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users. Re-exported from the shared client/server contract
// (issue #20) in src/shared/contracts.ts; the server projection lives in
// src/server/routes/admin.ts.
export type { AdminUser } from '@shared/contracts';
