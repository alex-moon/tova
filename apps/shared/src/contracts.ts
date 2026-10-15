// Shared API wire contracts (single source of truth for HTTP JSON bodies).
//
// Rules for this file:
// - Types/interfaces only. No runtime imports, no dependencies — the same
//   file must typecheck under the server config (module: commonjs) and the
//   client config (module: esnext + verbatimModuleSyntax).
// - Shapes are HTTP wire types, not Mongo documents: e.g. `Date` fields
//   appear as ISO strings after res.json() / JSON.parse.

// Public shape of an admin-visible user record, as returned by
// GET /api/admin/users (server projection in apps/server/src/routes/admin.ts).
export interface AdminUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  permissions: string[];
  hasGoogle: boolean;
  createdAt: string;
  updatedAt: string;
}

// Model inventory row, GET /api/admin/models (#234). Each entry is one
// `modelrosters` document: the fixed-roster era registers a MODEL once with a
// paired `providers[]` list, so `id` is the roster _id and `modelId` is the
// stable model key. #115 capability fields: `tools` is schema-defaulted to
// true; `vision` is only ever true when the model explicitly claims it;
// `contextLength` is the advertised limit (omitted when none is known).
// #199 pricing: `inputPrice`/`outputPrice` are USD per 1M tokens, omitted when
// unknown; price is now a soft weighted-score input, not a hard cap.
export interface AdminModel {
  id: string;
  modelId: string;
  label: string;
  eligible: boolean;
  tools: boolean;
  vision: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  providers: AdminModelProvider[];
}

// One backend of a roster model. `disabledUntil` is the system-owned per-
// provider cool-off expiry (#168/#213), an ISO wire string or null when not
// cooling off. `ttftMs`/`ttftSamples` are the rolling mean first-token latency
// and its observation count (OQ3: the exact figure `pickPrimary` scores on);
// both omitted when the provider has never won a race. `enabled` lets an
// operator take one backend out of the race without removing the model (OQ5).
export interface AdminModelProvider {
  provider: string;
  modelId: string;
  enabled: boolean;
  ttftMs?: number;
  ttftSamples?: number;
  ttftUpdatedAt?: string;
  disabledUntil: string | null;
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

// GET /api/admin/models payload. `errors` is keyed provider+model.
export interface AdminModelsPayload {
  models: AdminModel[];
  errors: AdminModelError[];
}

// #217/#234: provider catalog lookup, GET /api/admin/model-lookup. `found:
// false` is a successful "the provider does not host this model" answer; a
// thrown provider/network failure surfaces as a non-200 instead.
// `contextLength` and prices are omitted when the provider does not report them
// (prices are USD per 1M tokens, matching AdminModel); `vision` is present only
// when the catalog tags the model multimodal. DeepInfra reports context,
// prices and vision; Fireworks reports context/vision/tools but no prices.
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
  // #237: the provider that served the trace's llm run, from the run's
  // `ls_provider` span metadata (mapped to the app name, e.g. `fireworks`).
  // Null when the trace has no llm child or predates provider export.
  provider: string | null;
  startedAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  error: string | null;
  appPath?: string;
  // #308: workspace-memory facts for the turn, read from the root run's
  // metadata (the enrichment guard outcome and the rendered block's slice
  // count). Absent on traces from before the metadata existed.
  workspaceGate?: 'yes' | 'no' | 'timeout' | 'off';
  workspaceHits?: number;
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
  // #237: provider that served this llm run (`ls_provider` metadata), null on
  // non-llm runs or a trace exported before provider export.
  provider: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  // #237: time-to-first-token (`first_token_time - start_time`), null when the
  // run is non-streaming or carries no first-token instant.
  ttftMs: number | null;
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
// `inputTokens`/`outputTokens` are the prompt/completion split (#224) used to
// price a model; a run that reported no split contributes 0 to both, while
// `totalTokens` still holds whatever the run itself reported.
export interface AdminLangsmithModelStats {
  model: string;
  // #237: the provider this row covers, from the run's `ls_provider` metadata;
  // null for a legacy run with no provider. Under racing a model has one row
  // per provider, so the row is keyed by `(model, provider)`.
  provider: string | null;
  calls: number;
  errors: number;
  avgDurationMs: number | null;
  // #237: mean time-to-first-token (`first_token_time - start_time`) across
  // the row's streamed calls; null when none carried a first-token instant.
  avgTtftMs: number | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  // #224/#235: estimated USD spend for this (model, provider), joined from the
  // roster's per-provider price at read time (`null` = either side's price is
  // unknown, distinct from $0 — #199 semantics). With the provider on the row
  // (#237) a dual-priced model prices from the winning provider's entry; a
  // legacy no-provider row keeps the deterministic model-only fallback.
  // The UI renders null as `—`.
  estimatedCostUsd: number | null;
}

export interface AdminLangsmithStatsPayload {
  since: string;
  models: AdminLangsmithModelStats[];
  totals: {
    calls: number;
    errors: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    // Sum of the priced models' costs; null when no model in the window has a
    // known price.
    estimatedCostUsd: number | null;
  };
  // When the rollup was computed. Present on a cache hit; absent on a live
  // fallback (which is freshly computed).
  computedAt?: string;
  // True when the payload came from a live sweep (no cache yet, or the cache
  // is older than the staleness threshold).
  stale?: boolean;
}

// Per-session cost breakdown for the admin Traces tab (#224). Unlike the model
// rollup (which comes from LangSmith llm runs), this is computed from our own
// `Message` rows: message-in = `role:'user'`, message-out = `role:'assistant'`.
// Token totals and cost cover only assistant messages that carry `usage`
// (logged from #224 onward), so the counts and the token/cost totals describe
// different rows for a while — the UI labels this as a known skew.
export interface AdminSessionCostRow {
  sessionId: string;
  title: string;
  messagesIn: number;
  messagesOut: number;
  inputTokens: number;
  outputTokens: number;
  // Estimated USD spend for the session (#235), priced per turn by the
  // `(model, provider)` that actually served it — a dual-priced model bills
  // each turn at its winning provider's rate. The figure is blended across the
  // session's providers (no provider dimension on the row by choice: a session
  // may race either backend). `null` when no assistant message in the session
  // has a known price (distinct from $0 — #199). UI renders `—`.
  estimatedCostUsd: number | null;
  // Latest message timestamp in the session, used for ordering/display.
  lastActivityAt: string;
}

export interface AdminSessionsCostPayload {
  since: string;
  sessions: AdminSessionCostRow[];
  totals: {
    sessions: number;
    messagesIn: number;
    messagesOut: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
  };
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

// #289: a run is either the tool-use golden suite or the workspace-memory eval.
// Memory runs reuse the same `evalruns` collection (D9) with a `kind` badge and
// a continuous `metrics` rollup that does not fit the per-case `pass|partial|
// fail|error` scores.
export type AdminEvalRunKind = 'tool-use' | 'memory';

export interface AdminEvalRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'error';
  models: string[];
  kind: AdminEvalRunKind;
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

// #289 memory-eval rollup. Precision/recall@k/win-rate are continuous, so they
// live here rather than in the per-case `results` rows (which carry a
// drill-down score). Every stage field is optional: a scheduled retrieval-only
// run writes no `gate`/`helpfulness`.
export interface AdminEvalSubtypeRecall {
  total: number;
  truePos: number;
  falseNeg: number;
  recall: number | null;
}

export interface AdminEvalGateMetrics {
  total: number;
  evaluated: number;
  truePos: number;
  falsePos: number;
  trueNeg: number;
  falseNeg: number;
  precision: number | null;
  recall: number | null;
  fireRate: number;
  errors: number;
  timeouts: number;
  recallBySubtype: Record<string, AdminEvalSubtypeRecall>;
}

export interface AdminEvalRetrievalMetrics {
  total: number;
  surfaced: number;
  expectedMet: number;
  expectedMetRate: number;
  surfacedRate: number;
  /** #305: retrieval cases that ended empty-after-cut (graceful refusal). */
  cutEmpty?: number;
  byCategory: Record<string, { total: number; surfaced: number; expectedMet: number }>;
}

export interface AdminEvalHelpfulnessMetrics {
  total: number;
  judged: number;
  wins: number;
  losses: number;
  ties: number;
  errors: number;
  winRate: number | null;
  blockIdRate: number;
  factHitRate: number;
  counterfactualHits: number;
  deterministicWins: number;
}

export interface AdminEvalMemoryMetrics {
  /** Stages this run executed, so a partial run is self-describing. */
  stages: string[];
  /** SHA-256 over the canonical corpus (D15), so a corpus change is visible. */
  corpusHash: string;
  /** #310: the gate is retired — these are absent on runs after it, and read
   * only from historical rollups. */
  gateModel?: string;
  gateProvider?: string;
  /** Responder/judge identities (D15/OQ29); absent on a retrieval-only run. */
  responderModel?: string;
  responderProvider?: string;
  judgeModel?: string;
  judgeProvider?: string;
  gate?: AdminEvalGateMetrics;
  retrieval?: AdminEvalRetrievalMetrics;
  helpfulness?: AdminEvalHelpfulnessMetrics;
}

export interface AdminEvalRunDetail extends AdminEvalRunSummary {
  results: AdminEvalCaseResult[];
  /** Present on `kind:'memory'` runs; absent (null) on tool-use runs. */
  metrics?: AdminEvalMemoryMetrics | null;
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
  // IANA timezone from the browser (#261): omitted until captured, so the
  // prompt falls back to UTC for users who have never reported one.
  timezone?: string;
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
