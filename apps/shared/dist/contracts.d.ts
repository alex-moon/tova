export interface AdminUser {
    id: string;
    email: string;
    role: 'user' | 'admin';
    permissions: string[];
    hasGoogle: boolean;
    createdAt: string;
    updatedAt: string;
}
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
export interface AdminModelProvider {
    provider: string;
    modelId: string;
    enabled: boolean;
    ttftMs?: number;
    ttftSamples?: number;
    ttftUpdatedAt?: string;
    disabledUntil: string | null;
}
export interface AdminModelError {
    provider: string;
    model: string;
    status: number | null;
    category: string;
    count: number;
    lastMessage: string;
    lastSeenAt: string;
}
export interface AdminModelsPayload {
    models: AdminModel[];
    errors: AdminModelError[];
}
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
export interface AdminLogEntry {
    id: string;
    ts: string;
    level: 'info' | 'warn' | 'error';
    msg: string;
}
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
export interface AdminLogsPayload {
    logs: AdminLogEntry[];
    configured: boolean;
    error?: string;
}
export interface AdminTraceRow {
    id: string;
    traceId: string;
    name: string;
    status: string;
    model: string | null;
    provider: string | null;
    startedAt: string;
    durationMs: number | null;
    totalTokens: number | null;
    error: string | null;
    appPath?: string;
}
export interface AdminTracesPayload {
    project: {
        id: string;
        name: string;
    };
    traces: AdminTraceRow[];
}
export interface AdminTraceRun {
    id: string;
    parentId: string | null;
    name: string;
    runType: string;
    status: string;
    model: string | null;
    provider: string | null;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
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
export interface AdminLangsmithModelStats {
    model: string;
    provider: string | null;
    calls: number;
    errors: number;
    avgDurationMs: number | null;
    avgTtftMs: number | null;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
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
        estimatedCostUsd: number | null;
    };
    computedAt?: string;
    stale?: boolean;
}
export interface AdminSessionCostRow {
    sessionId: string;
    title: string;
    messagesIn: number;
    messagesOut: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
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
export interface AuthUserLocation {
    country: string;
    countryCode: string;
}
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
    zdr?: boolean;
    incognitoByDefault?: boolean;
    confirmDeletes?: {
        chat: boolean;
        file: boolean;
    };
    location?: AuthUserLocation;
}
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
