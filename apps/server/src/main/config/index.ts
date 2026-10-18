import { getJwtSecret } from './jwt';
import type { LlmProvider } from '../services/llmTypes';

// Typed config surface; lazy accessors because env loads after import.
// @see #142

export { getJwtSecret, JWT_SECRET_ENV_VAR } from './jwt';

export const config = {
  jwt: {
    get secret(): string {
      return getJwtSecret();
    },
  },

  googleOAuth: {
    get clientId(): string | undefined {
      return process.env.GOOGLE_CLIENT_ID;
    },
    get clientSecret(): string | undefined {
      return process.env.GOOGLE_CLIENT_SECRET;
    },
    get callbackUrl(): string | undefined {
      return process.env.GOOGLE_CALLBACK_URL;
    },
  },

  storage: {
    get bucket(): string {
      return process.env.DO_SPACES_BUCKET || '';
    },
    get key(): string | undefined {
      return process.env.DO_SPACES_KEY;
    },
    get secret(): string | undefined {
      return process.env.DO_SPACES_SECRET;
    },
    get region(): string {
      return process.env.DO_SPACES_REGION || 'lon1';
    },
  },

  langsmith: {
    get apiKey(): string | undefined {
      return process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY;
    },
    get project(): string | undefined {
      return process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT;
    },
  },

  search: {
    get braveApiKey(): string | undefined {
      return process.env.BRAVE_SEARCH_API_KEY;
    },
  },

  // Firecrawl web-data API, the fetch_url fallback for blocked pages.
  // @see #340
  firecrawl: {
    get apiKey(): string | undefined {
      return process.env.FIRECRAWL_API_KEY;
    },
  },

  // TTL in days for agent-side scraped assets; 0 disables expiry.
  // @see #340
  agentAssets: {
    get ttlDays(): number {
      const raw = process.env.AGENT_ASSET_TTL_DAYS;
      if (raw === undefined || raw === '') return 30;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 30;
    },
  },

  // Provider API keys surfaced here; one place for consumers to read them.
  // @see #217
  providers: {
    get deepinfraApiKey(): string | undefined {
      return process.env.DEEPINFRA_API_KEY;
    },
    // Surfaced for parity with the DeepInfra key; Mastra reads it implicitly.
    // @see #232
    get fireworksApiKey(): string | undefined {
      return process.env.FIREWORKS_API_KEY;
    },
  },

  // Grafana Cloud hosted Loki for retained logs; url is the push URL.
  // @see #179
  loki: {
    get url(): string | undefined {
      return process.env.LOKI_URL;
    },
    get username(): string | undefined {
      return process.env.LOKI_USERNAME;
    },
    get password(): string | undefined {
      return process.env.LOKI_PASSWORD;
    },
  },

  safeBrowsing: {
    get apiKey(): string | undefined {
      return process.env.GOOGLE_SAFE_BROWSING_API_KEY || process.env.GOOGLE_API_KEY || undefined;
    },
  },

  // Workspace-memory retrieval across chats and files; off by default.
  // @see #253
  workspaceMemory: {
    get enabled(): boolean {
      const raw = process.env.WORKSPACE_MEMORY_ENABLED;
      if (raw === undefined || raw === '') return false;
      return raw !== '0' && raw.toLowerCase() !== 'false';
    },
  },

  // Aux model for small latency-insensitive calls.
  // @see #238
  aux: {
    get model(): string {
      return process.env.AUX_MODEL || 'openai/gpt-oss-20b';
    },
    get provider(): LlmProvider {
      return (process.env.AUX_PROVIDER as LlmProvider) || 'groq';
    },
  },

  // Helpfulness eval models: judge is a different family than the gate.
  // @see #289
  memoryEval: {
    get judgeModel(): string {
      return process.env.MEMORY_JUDGE_MODEL || 'Qwen/Qwen3-235B-A22B-Instruct-2507';
    },
    get judgeProvider(): LlmProvider {
      return (process.env.MEMORY_JUDGE_PROVIDER as LlmProvider) || 'deepinfra';
    },
    get responderModel(): string | undefined {
      return process.env.MEMORY_RESPONDER_MODEL || undefined;
    },
    get responderProvider(): LlmProvider | undefined {
      return (process.env.MEMORY_RESPONDER_PROVIDER as LlmProvider) || undefined;
    },
    get responderTemperature(): number {
      const raw = process.env.MEMORY_RESPONDER_TEMPERATURE;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    },
    get paceMs(): number {
      const raw = process.env.MEMORY_EVAL_PACE_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
    },
    // Gate pace: keeps a per-case aux burst under the provider RPM.
    get gatePaceMs(): number {
      const raw = process.env.MEMORY_EVAL_GATE_PACE_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
    },
    // Judge pace: keeps the validation burst under Groq's 30 RPM.
    get judgePaceMs(): number {
      const raw = process.env.MEMORY_EVAL_JUDGE_PACE_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
    },
  },

  chat: {
    get maxOutputTokens(): string | undefined {
      return process.env.CHAT_MAX_OUTPUT_TOKENS;
    },
  },

  // Workspace-memory semantic retrieval; dim is pinned by the Atlas index.
  // @see #294
  embeddings: {
    get model(): string {
      return process.env.EMBEDDING_MODEL || 'BAAI/bge-base-en-v1.5';
    },
    get dim(): number {
      const raw = process.env.EMBEDDING_DIM;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 768;
    },
    get backfillTimeoutMs(): number {
      const raw = process.env.EMBEDDING_BACKFILL_TIMEOUT_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
    },
    get timeoutMs(): number {
      const raw = process.env.EMBEDDING_TIMEOUT_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 800;
    },
  },

  // Rerank budget knob; tall enough for cross-encoder latency.
  // @see #305
  rerank: {
    get timeoutMs(): number {
      const raw = process.env.RERANK_TIMEOUT_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3000;
    },
  },

  // Task sequencer budget knobs; malformed env degrades to the default.
  // @see #254 #251
  task: {
    get maxSteps(): number {
      const raw = process.env.TASK_MAX_STEPS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      // Floor before the positivity guard: 0.5 must degrade, not become 0.
      const floored = Math.floor(parsed);
      return Number.isFinite(parsed) && floored > 0 ? floored : 25;
    },
    get maxCostUsd(): number {
      const raw = process.env.TASK_MAX_COST_USD;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
    },
  },

  // Scheduled eval suite; off by default so deploys make no unattended calls.
  // @see #225
  evals: {
    get schedule(): string {
      return process.env.TOVA_EVAL_SCHEDULE || 'off';
    },
    get hourUtc(): string | undefined {
      return process.env.TOVA_EVAL_HOUR_UTC;
    },
    get models(): string | undefined {
      return process.env.TOVA_EVAL_MODELS;
    },
    // Single-model fallback when models is unset; unset pair uses the roster.
    get model(): string | undefined {
      return process.env.TOVA_EVAL_MODEL;
    },
    get provider(): string | undefined {
      return process.env.TOVA_EVAL_PROVIDER;
    },
  },

  runtime: {
    get port(): string | undefined {
      return process.env.PORT;
    },
    get trustProxyHops(): string | undefined {
      return process.env.TRUST_PROXY_HOPS;
    },
    get nodeEnv(): string | undefined {
      return process.env.NODE_ENV;
    },
    get mongodbUrl(): string | undefined {
      return process.env.MONGODB_URL;
    },
    get mongodbHost(): string | undefined {
      return process.env.MONGODB_HOST;
    },
    get mongodbPassword(): string | undefined {
      return process.env.MONGODB_PASSWORD;
    },
  },
};
