import { getJwtSecret } from './jwt';
import type { LlmProvider } from '../services/llmTypes';

/*
 * Central, typed server config surface (issue #142). One module over every
 * env var currently read in src/server. Semantics are byte-identical to the
 * call sites: same `||`/`??` operators, same fallbacks, same truthiness —
 * no new validation, no new required vars, no parsing (consumers keep their
 * own Number.parseInt/NaN handling until the follow-up sweep).
 *
 * Accessors are lazy functions, not module-scope constants: some entrypoints
 * load env after import and tests mutate process.env directly (see
 * storageService.ts for the original write-up of that constraint).
 */

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

  // Provider API keys. Mastra reads these implicitly for inference; the
  // model-lookup service (#217) reads DeepInfra's catalog directly, so the
  // key is surfaced here rather than reached for ad hoc.
  providers: {
    get deepinfraApiKey(): string | undefined {
      return process.env.DEEPINFRA_API_KEY;
    },
    // #232: Mastra reads FIREWORKS_API_KEY implicitly for inference; surfaced
    // here for parity with the DeepInfra key so config consumers have one
    // place to read provider credentials.
    get fireworksApiKey(): string | undefined {
      return process.env.FIREWORKS_API_KEY;
    },
  },

  // #179: Grafana Cloud (hosted Loki) for retained logs. `url` is the full
  // push URL (as supplied by Grafana Cloud); the read side strips the
  // /loki/api/v1/push suffix to reach the query API on the same host.
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

  entityGraph: {
    get extractionEnabled(): boolean {
      return Boolean(process.env.ENTITY_GRAPH_ENABLED);
    },
    get promptInjectionEnabled(): boolean {
      return Boolean(process.env.ENTITY_GRAPH_PROMPT_INJECTION);
    },
  },

  // #238: the aux model source for the small, latency-insensitive LLM calls
  // (chat title, entity extraction, follow-ups, prompt metrics, enrichment).
  // Replaces the tier-era `ROUTER_SMALL_MODEL`/`ROUTER_GUARD_MODEL` reads. The
  // owner retired small models for *chat routing* only; a single cheap fixed
  // aux model is kept. Default is the retired guard model on its old provider
  // so the wire behaviour is unchanged.
  aux: {
    get model(): string {
      return process.env.AUX_MODEL || 'openai/gpt-oss-20b';
    },
    get provider(): LlmProvider {
      return (process.env.AUX_PROVIDER as LlmProvider) || 'groq';
    },
    // #238: hard cap on the serial enrichment pre-pass so a slow aux call
    // degrades to "no block" instead of delaying the chat turn.
    get enrichmentTimeoutMs(): number {
      const raw = process.env.ENRICHMENT_TIMEOUT_MS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
    },
  },

  chat: {
    get maxOutputTokens(): string | undefined {
      return process.env.CHAT_MAX_OUTPUT_TOKENS;
    },
  },

  // #254 (epic #251): the task sequencer's budget knobs. `maxSteps` is the
  // step cap (above the chat cap of 12, below a runaway); `maxCostUsd` is the
  // per-task spend ceiling. Both parse+fallback like `aux.enrichmentTimeoutMs`
  // so a malformed env degrades to the default rather than a NaN budget.
  task: {
    get maxSteps(): number {
      const raw = process.env.TASK_MAX_STEPS;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      // Floor *before* the positivity guard: `0.5` is positive but floors to a
      // zero-step budget, which must degrade to the default, not become 0.
      const floored = Math.floor(parsed);
      return Number.isFinite(parsed) && floored > 0 ? floored : 25;
    },
    get maxCostUsd(): number {
      const raw = process.env.TASK_MAX_COST_USD;
      const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
    },
  },

  // #225: scheduled eval suite. Off by default — a fresh deploy must not
  // start live provider calls unattended (OQ4). `schedule` is `off|daily`;
  // `hourUtc` is the earliest UTC hour a daily run may start. Names follow
  // the runner's existing singular `TOVA_EVAL_*` family (TOVA_EVAL_MODEL).
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
    // Single-model fallback when `models` is unset (the runner's existing
    // `TOVA_EVAL_MODEL` / `TOVA_EVAL_PROVIDER` pair). An unset pair resolves to
    // a roster default (cheapest roster model) in `resolveScheduledModels`.
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
