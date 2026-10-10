"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.JWT_SECRET_ENV_VAR = exports.getJwtSecret = void 0;
const jwt_1 = require("./jwt");
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
var jwt_2 = require("./jwt");
Object.defineProperty(exports, "getJwtSecret", { enumerable: true, get: function () { return jwt_2.getJwtSecret; } });
Object.defineProperty(exports, "JWT_SECRET_ENV_VAR", { enumerable: true, get: function () { return jwt_2.JWT_SECRET_ENV_VAR; } });
exports.config = {
    jwt: {
        get secret() {
            return (0, jwt_1.getJwtSecret)();
        },
    },
    googleOAuth: {
        get clientId() {
            return process.env.GOOGLE_CLIENT_ID;
        },
        get clientSecret() {
            return process.env.GOOGLE_CLIENT_SECRET;
        },
        get callbackUrl() {
            return process.env.GOOGLE_CALLBACK_URL;
        },
    },
    storage: {
        get bucket() {
            return process.env.DO_SPACES_BUCKET || '';
        },
        get key() {
            return process.env.DO_SPACES_KEY;
        },
        get secret() {
            return process.env.DO_SPACES_SECRET;
        },
        get region() {
            return process.env.DO_SPACES_REGION || 'lon1';
        },
    },
    langsmith: {
        get apiKey() {
            var _a;
            return (_a = process.env.LANGSMITH_API_KEY) !== null && _a !== void 0 ? _a : process.env.LANGCHAIN_API_KEY;
        },
        get project() {
            var _a;
            return (_a = process.env.LANGSMITH_PROJECT) !== null && _a !== void 0 ? _a : process.env.LANGCHAIN_PROJECT;
        },
    },
    search: {
        get braveApiKey() {
            return process.env.BRAVE_SEARCH_API_KEY;
        },
    },
    // Provider API keys. Mastra reads these implicitly for inference; the
    // model-lookup service (#217) reads DeepInfra's catalog directly, so the
    // key is surfaced here rather than reached for ad hoc.
    providers: {
        get deepinfraApiKey() {
            return process.env.DEEPINFRA_API_KEY;
        },
        // #232: Mastra reads FIREWORKS_API_KEY implicitly for inference; surfaced
        // here for parity with the DeepInfra key so config consumers have one
        // place to read provider credentials.
        get fireworksApiKey() {
            return process.env.FIREWORKS_API_KEY;
        },
    },
    // #179: Grafana Cloud (hosted Loki) for retained logs. `url` is the full
    // push URL (as supplied by Grafana Cloud); the read side strips the
    // /loki/api/v1/push suffix to reach the query API on the same host.
    loki: {
        get url() {
            return process.env.LOKI_URL;
        },
        get username() {
            return process.env.LOKI_USERNAME;
        },
        get password() {
            return process.env.LOKI_PASSWORD;
        },
    },
    safeBrowsing: {
        get apiKey() {
            return process.env.GOOGLE_SAFE_BROWSING_API_KEY || process.env.GOOGLE_API_KEY || undefined;
        },
    },
    entityGraph: {
        get extractionEnabled() {
            return Boolean(process.env.ENTITY_GRAPH_ENABLED);
        },
        get promptInjectionEnabled() {
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
        get model() {
            return process.env.AUX_MODEL || 'openai/gpt-oss-20b';
        },
        get provider() {
            return process.env.AUX_PROVIDER || 'groq';
        },
        // #238: hard cap on the serial enrichment pre-pass so a slow aux call
        // degrades to "no block" instead of delaying the chat turn.
        get enrichmentTimeoutMs() {
            const raw = process.env.ENRICHMENT_TIMEOUT_MS;
            const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
        },
    },
    chat: {
        get maxOutputTokens() {
            return process.env.CHAT_MAX_OUTPUT_TOKENS;
        },
    },
    // #225: scheduled eval suite. Off by default — a fresh deploy must not
    // start live provider calls unattended (OQ4). `schedule` is `off|daily`;
    // `hourUtc` is the earliest UTC hour a daily run may start. Names follow
    // the runner's existing singular `TOVA_EVAL_*` family (TOVA_EVAL_MODEL).
    evals: {
        get schedule() {
            return process.env.TOVA_EVAL_SCHEDULE || 'off';
        },
        get hourUtc() {
            return process.env.TOVA_EVAL_HOUR_UTC;
        },
        get models() {
            return process.env.TOVA_EVAL_MODELS;
        },
        // Single-model fallback when `models` is unset (the runner's existing
        // `TOVA_EVAL_MODEL` / `TOVA_EVAL_PROVIDER` pair). An unset pair resolves to
        // a roster default (cheapest roster model) in `resolveScheduledModels`.
        get model() {
            return process.env.TOVA_EVAL_MODEL;
        },
        get provider() {
            return process.env.TOVA_EVAL_PROVIDER;
        },
    },
    runtime: {
        get port() {
            return process.env.PORT;
        },
        get trustProxyHops() {
            return process.env.TRUST_PROXY_HOPS;
        },
        get nodeEnv() {
            return process.env.NODE_ENV;
        },
        get mongodbUrl() {
            return process.env.MONGODB_URL;
        },
        get mongodbHost() {
            return process.env.MONGODB_HOST;
        },
        get mongodbPassword() {
            return process.env.MONGODB_PASSWORD;
        },
    },
};
