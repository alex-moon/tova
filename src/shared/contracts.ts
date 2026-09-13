// Shared API wire contracts (single source of truth for HTTP JSON bodies).
//
// Rules for this file:
// - Types/interfaces only. No runtime imports, no dependencies — the same
//   file must typecheck under the server config (module: commonjs) and the
//   client config (module: esnext + verbatimModuleSyntax).
// - Shapes are HTTP wire types, not Mongo documents: e.g. `Date` fields
//   appear as ISO strings after res.json() / JSON.parse.

// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users (server projection in src/server/routes/admin.ts).
export interface AdminUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  permissions: string[];
  hasGoogle: boolean;
  createdAt: string;
  updatedAt: string;
}

// Read-only model inventory row, GET /api/admin/models (issue #33).
// `id` is '<provider>/<model>' for stable React keys; `stats` carries the
// feedback tallies captured in ModelMetricStat (up/down).
export interface AdminModel {
  id: string;
  provider: string;
  model: string;
  tiers: string[];
  stats: { band: string; up: number; down: number }[];
}

// User payload returned by GET /api/auth/me (includes permissions).
// `name`/`avatarUrl` are optional: omitted from the wire payload until set.
// `name` is the Google-owned full name; `preferredName` is user-owned.
export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  permissions: string[];
  name?: string;
  avatarUrl?: string;
  preferredName?: string;
}

// User payload returned by POST /api/auth/login and /register.
// NOTE: narrower than AuthUser — these routes omit `permissions`. The
// client's AuthContext currently types a wider User than these routes
// return (drift documented on issue #20; two-type default until resolved).
export interface LoginUserPayload {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}
