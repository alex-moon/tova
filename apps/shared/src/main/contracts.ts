// Shared API wire contracts: HTTP wire shapes, not Mongo documents.

// Public shape of an admin-visible user record from GET /api/admin/users.
export interface AdminUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  permissions: string[];
  hasGoogle: boolean;
  createdAt: string;
  updatedAt: string;
}

// Fixed serving model row (read-only): the env-pinned per-function model.
// @see #387
export interface AdminFixedModel {
  model: string;
  provider: string;
  contextLength?: number;
}

// Per-model endpoint-error tallies: (provider, model, status, category).
// @see #168 #175
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
  models: AdminFixedModel[];
  errors: AdminModelError[];
}

// One retained log row from Grafana Cloud Loki.
// @see #179
export interface AdminLogEntry {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

// Admin PATs: metadata-only list shape; plaintext token shown once.
// @see #184
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

// Direct model comparison: one prompt against chosen routing rows.
// @see #129
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

// One time-window page of retained logs, newest first; no cursor.
// @see #179
export interface AdminLogsPayload {
  logs: AdminLogEntry[];
  configured: boolean;
  error?: string;
}

// Admin LangSmith read view: trimmed server-side run projections.
// @see #186
export interface AdminTraceRow {
  id: string;
  traceId: string;
  name: string;
  status: string;
  model: string | null;
  // Provider of the trace's llm run (`ls_provider`); null when absent.
  // @see #237
  provider: string | null;
  startedAt: string;
  durationMs: number | null;
  totalTokens: number | null;
  error: string | null;
  appPath?: string;
  // Workspace-memory facts from the root run; absent on older traces.
  // @see #308
  workspaceGate?: 'yes' | 'no' | 'timeout' | 'off';
  workspaceHits?: number;
}

export interface AdminTracesPayload {
  project: { id: string; name: string };
  traces: AdminTraceRow[];
}

// One node of a trace detail tree; raw LangSmith payloads.
export interface AdminTraceRun {
  id: string;
  parentId: string | null;
  name: string;
  runType: string;
  status: string;
  model: string | null;
  // Provider of this llm run (`ls_provider`); null on non-llm runs.
  // @see #237
  provider: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  // Time-to-first-token, null when the run is non-streaming.
  // @see #237
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

// Per-model rollup of llm runs in the stats window.
// @see #186 #224
export interface AdminLangsmithModelStats {
  model: string;
  // Provider this row covers (`ls_provider`); keyed by (model, provider).
  // @see #237
  provider: string | null;
  calls: number;
  errors: number;
  avgDurationMs: number | null;
  // Mean time-to-first-token across the row's streamed calls; null when none.
  // @see #237
  avgTtftMs: number | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  // Estimated USD spend from the roster price; null (unknown) ≠ $0.
  // @see #224 #235 #199 #237
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
    // Sum of the priced models' costs; null when no model has a known price.
    estimatedCostUsd: number | null;
  };
  // When the rollup was computed; absent on a live fallback.
  computedAt?: string;
  // True when the payload came from a live sweep rather than the cache.
  stale?: boolean;
}

// Per-session cost breakdown computed from our own Message rows.
// @see #224
export interface AdminSessionCostRow {
  sessionId: string;
  title: string;
  messagesIn: number;
  messagesOut: number;
  inputTokens: number;
  outputTokens: number;
  // Estimated USD spend by (model, provider); null (unknown) ≠ $0.
  // @see #235 #199
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

// Admin Evals view: one summary per suite execution with per-score counts.
// @see #225
export interface AdminEvalScoreCounts {
  pass: number;
  partial: number;
  fail: number;
  error: number;
}

// A run is the tool-use golden suite or the memory eval, same collection.
// @see #289
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

// One graded case row; `error` is a crash, distinct from a graded `fail`.
export interface AdminEvalCaseResult {
  caseId: string;
  model: string;
  provider: string;
  score: 'pass' | 'partial' | 'fail' | 'error';
  report: string;
}

// Memory-eval rollup: continuous metrics here, not per-case rows.
// @see #289
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
  /** Retrieval cases that ended empty-after-cut (graceful refusal). */
  // @see #305
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
  /** SHA-256 over the canonical corpus (D15). */
  corpusHash: string;
  /** The gate is retired; these are absent on runs after it. */
  // @see #310
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

// Coarse country-level geolocation: only the country name and 2-letter code.
// @see #50
export interface AuthUserLocation {
  country: string;
  countryCode: string;
}

// User payload from GET /api/auth/me; optionals omitted until set.
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
  // Zero-data-retention opt-in: omitted until enabled.
  // @see #116
  zdr?: boolean;
  // 'Incognito by default' alias of `zdr`; new chats start incognito.
  // @see #144
  incognitoByDefault?: boolean;
  confirmDeletes?: { chat: boolean; file: boolean };
  location?: AuthUserLocation;
  // IANA timezone from the browser; omitted until captured.
  // @see #261
  timezone?: string;
}

// Login/register payload: narrower than AuthUser (no permissions).
// @see #20
export interface LoginUserPayload {
  id: string;
  email: string;
  role: 'user' | 'admin';
}
