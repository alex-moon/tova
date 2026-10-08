import { getJwtSecret } from './jwt';

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

  chat: {
    get maxOutputTokens(): string | undefined {
      return process.env.CHAT_MAX_OUTPUT_TOKENS;
    },
  },

  mcp: {
    get toolBudgetTokens(): string | undefined {
      return process.env.MCP_TOOL_BUDGET_TOKENS;
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
