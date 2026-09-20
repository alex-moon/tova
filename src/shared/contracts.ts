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

// Model inventory row, GET /api/admin/models (issues #33/#104). Each entry
// is one `providerroutings` document — a provider/model pair can repeat
// across tiers, so `id` is the Mongo _id and rows are per-tier. `stats`
// carries the feedback tallies captured in ModelMetricStat (up/down), keyed
// by model name.
export interface AdminModel {
  id: string;
  provider: string;
  model: string;
  tier: 'small' | 'large' | 'guard';
  eligible: boolean;
  tools: boolean;
  vision: boolean;
  contextLength?: number;
  stats: { band: string; up: number; down: number }[];
}

// One in-memory log buffer row, GET /api/admin/logs (issue #76). `id` is a
// monotonic cursor the client passes back for incremental polling.
export interface AdminLogEntry {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

// Direct model comparison (issue #129): one prompt run against the existing
// agent on chosen routing rows. `answer` is null with `error` set when that
// model's completion failed; `latencyMs` covers the full agent call.
export interface ModelComparisonResult {
  provider: string;
  model: string;
  answer: string | null;
  latencyMs: number;
  error?: string;
}

export interface ModelComparisonRun {
  prompt: string;
  results: ModelComparisonResult[];
}

// Response of GET /api/admin/logs (issue #76).
export interface AdminLogsPayload {
  logs: AdminLogEntry[];
  nextCursor: number;
}

// `location` is the coarse country-level geolocation (issue #50): only the
// country name and 2-letter code are exposed, and only once resolved.
export interface AuthUserLocation {
  country: string;
  countryCode: string;
}

// User payload returned by GET /api/auth/me (includes permissions).
// `name`/`avatarUrl`/`customInstructions` are optional: omitted from the wire
// payload until set. `name` is the Google-owned full name; `preferredName`
// is user-owned; `customInstructions` is the user's per-chat prompt override.
export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  permissions: string[];
  name?: string;
  avatarUrl?: string;
  preferredName?: string;
  customInstructions?: string;
  theme?: 'light' | 'dark';
  startupChat?: 'recent' | 'new';
  confirmDeletes?: { chat: boolean; file: boolean };
  location?: AuthUserLocation;
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
