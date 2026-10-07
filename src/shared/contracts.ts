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
// string), null when the model is not cooling off. #199: `inputPrice`/
// `outputPrice` are USD per 1M tokens, omitted when unknown; the row's
// routing price is their sum and rows over the admin cap are excluded from
// the routing pools.
export interface AdminModel {
  id: string;
  provider: string;
  model: string;
  tier: 'small' | 'large' | 'guard';
  eligible: boolean;
  tools: boolean;
  vision: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
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

// #217: provider catalog lookup, GET /api/admin/model-lookup. `found: false`
// is a successful "the provider does not host this model" answer; a thrown
// provider/network failure surfaces as a non-200 instead. `contextLength` and
// prices are omitted when the provider does not report them (prices are USD
// per 1M tokens, matching AdminModel); `vision` is present only when the
// catalog tags the model multimodal.
export interface AdminModelLookup {
  found: boolean;
  provider?: string;
  model?: string;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  vision?: boolean;
  description?: string;
}

// One retained log row, GET /api/admin/logs (#179). Sourced from Grafana Cloud
// Loki (which survives deploys) rather than the old in-memory ring buffer.
// `level` is a best-effort classification of the raw line; `id` is derived from
// the line's nanosecond timestamp so React keys stay stable.
export interface AdminLogEntry {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

// Admin PATs (#184): agent/CLI credentials managed in the Access tab.
// `AdminPat` is the list shape — metadata only, no token (the plaintext is
// returned exactly once, in AdminPatCreated at creation).
export interface AdminPat {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  creatorEmail: string | null;
}

export interface AdminPatCreated {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export interface AdminPatsPayload {
  pats: AdminPat[];
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

// Response of GET /api/admin/logs (#179): one time-window page of retained
// logs, newest first. No cursor — the view re-queries the window instead of
// polling incrementally. `configured` is false when Loki env vars are absent;
// `error` carries a human message when the Loki query itself failed.
export interface AdminLogsPayload {
  logs: AdminLogEntry[];
  configured: boolean;
  error?: string;
}

// Admin LangSmith read view (#186): wire types for the Traces tab. Rows and
// runs are trimmed server-side projections of LangSmith run documents.
// `model` is the trace's llm child model (e.g. 'openai/gpt-oss-20b') — null
// when the trace has no llm child (e.g. it errored before the model call);
// chat turns are traced without session metadata today, so the server
// resolves it from the child run name. `appPath`, when present, deep-links
// the run in the LangSmith UI.
export interface AdminTraceRow {
  id: string;
  traceId: string;
  name: string;
  status: string;
  model: string | null;
  startedAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  error: string | null;
  appPath?: string;
}

export interface AdminTracesPayload {
  project: { id: string; name: string };
  traces: AdminTraceRow[];
}

// One node of a trace detail tree. `parentId` is null on the trace's root;
// the client renders depth from the chain. `inputs`/`outputs` are the raw
// LangSmith payloads (JSON values — the tab renders them as formatted JSON),
// included because reading prompts/outputs is the point of the tool; the
// admin route serves the same trust audience as the LangSmith UI itself.
export interface AdminTraceRun {
  id: string;
  parentId: string | null;
  name: string;
  runType: string;
  status: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  error: string | null;
  inputs: unknown;
  outputs: unknown;
}

export interface AdminTraceDetail {
  traceId: string;
  runs: AdminTraceRun[];
}

// Per-model rollup of llm runs in the stats window (#186), aggregated from
// the llm runs directly (model + tokens live there, and a root-based rollup
// would multiply API calls against LangSmith's rate limits). `calls` counts
// llm requests — a tool-using turn makes several to the same model;
// `errors` are llm-level failures; `avgDurationMs` is the mean end-start of
// the calls (null when none finished); `totalTokens` sums the runs' token
// counts. Turns that failed before any llm call do not appear here — the
// traces list's errors-only filter covers turn-level failures.
export interface AdminLangsmithModelStats {
  model: string;
  calls: number;
  errors: number;
  avgDurationMs: number | null;
  totalTokens: number;
}

export interface AdminLangsmithStatsPayload {
  since: string;
  models: AdminLangsmithModelStats[];
  totals: { calls: number; errors: number; totalTokens: number };
}

// #225: admin Evals view. One `AdminEvalRunSummary` per suite execution
// (newest first in the list), with per-score counts so the tab renders a row
// without fetching the per-case breakdown. `status` mirrors the rollup's
// `running|done|error`; `total` is the number of graded cases.
export interface AdminEvalScoreCounts {
  pass: number;
  partial: number;
  fail: number;
  error: number;
}

export interface AdminEvalRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'error';
  models: string[];
  counts: AdminEvalScoreCounts;
  total: number;
  error: string | null;
}

export interface AdminEvalRunsPayload {
  runs: AdminEvalRunSummary[];
}

// One graded case row in a run's breakdown. `score` is stringly typed as the
// runner always produced it: `error` is a run-level crash recorded in sweep
// mode, distinct from a genuine graded `fail`.
export interface AdminEvalCaseResult {
  caseId: string;
  model: string;
  provider: string;
  score: 'pass' | 'partial' | 'fail' | 'error';
  report: string;
}

export interface AdminEvalRunDetail extends AdminEvalRunSummary {
  results: AdminEvalCaseResult[];
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
