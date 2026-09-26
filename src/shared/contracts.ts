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
// by model name. #115 badge fields: `tools` is schema-defaulted to true;
// `vision` is only ever true when the row explicitly claims it;
// `contextLength` is the advertised limit (omitted when none is known).
// #168: `disabledUntil` is the system-owned cool-off expiry (ISO wire
// string), null when the model is not cooling off.
export interface AdminModel {
  id: string;
  provider: string;
  model: string;
  tier: 'small' | 'large' | 'guard';
  eligible: boolean;
  tools: boolean;
  vision: boolean;
  contextLength?: number;
  disabledUntil: string | null;
  stats: { band: string; up: number; down: number }[];
}

// #168 per-model endpoint-error diagnostics (Alex, 2026-09-26): every
// completion failure is tallied at the inferenceService choke point into the
// #175 `modelrouteerrors` collection, so real connector error shapes
// accumulate in Mongo and survive deploys. One row per
// (provider, model, status, category) cell; `status` is null when the
// failure carried no HTTP status; `lastMessage` is a redacted, capped
// excerpt of the most recent failure.
export interface AdminModelError {
  provider: string;
  model: string;
  status: number | null;
  category: string;
  count: number;
  lastMessage: string;
  lastSeenAt: string;
}

// GET /api/admin/models payload. `errors` is keyed provider+model (one model
// can serve several tiers, so a per-row join would duplicate rows).
export interface AdminModelsPayload {
  models: AdminModel[];
  errors: AdminModelError[];
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

// Per-user entity graph read view (issue #138). Wire types for the admin
// "Graph" tab: `AdminGraphEntity` is one node with its `sourceRefs` kept as
// plain id strings for audit linking; `AdminGraphEdge` links two entities by
// id plus a human summary; the detail response pairs an entity with the
// edges touching it (either side), with the other endpoint's name resolved
// so the tab can render without a second lookup.
export interface AdminGraphSourceRef {
  sessionId: string;
  messageId?: string;
}

export interface AdminGraphEntity {
  id: string;
  userId: string;
  name: string;
  kind: string;
  summary?: string;
  mentionCount: number;
  // Plan-138 task 7: confidence is surfaced so threshold behaviour stays
  // auditable in the tab (retrieval only admits nodes >= HIGH_CONFIDENCE).
  confidence: number;
  salience: 'low' | 'high';
  lastMentionedAt: string;
  sourceRefs: AdminGraphSourceRef[];
}

export interface AdminGraphEdge {
  id: string;
  kind: string;
  summary?: string;
  fromEntityId: string;
  toEntityId: string;
  fromName: string;
  toName: string;
  sourceRefs: AdminGraphSourceRef[];
}

export interface AdminGraphEntitiesPayload {
  entities: AdminGraphEntity[];
  page: number;
  limit: number;
  total: number;
}

export interface AdminGraphEntityDetail {
  entity: AdminGraphEntity;
  edges: AdminGraphEdge[];
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
  // Zero-data-retention opt-in (issue #116): omitted until the user enabled
  // it, so the client only branches on the flag once it is explicitly true.
  zdr?: boolean;
  // 'Incognito by default' (#144) alias: the same flag as `zdr`, exposed in
  // lockstep once truthy. New chats start incognito when either is set.
  incognitoByDefault?: boolean;
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
