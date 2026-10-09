import { config, getJwtSecret, JWT_SECRET_ENV_VAR } from './index';

const keys = [
  'JWT_SECRET',
  'NODE_ENV',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
  'GOOGLE_SAFE_BROWSING_API_KEY',
  'GOOGLE_API_KEY',
  'DO_SPACES_BUCKET',
  'DO_SPACES_KEY',
  'DO_SPACES_SECRET',
  'DO_SPACES_REGION',
  'LANGSMITH_API_KEY',
  'LANGCHAIN_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGCHAIN_PROJECT',
  'BRAVE_SEARCH_API_KEY',
  'ENTITY_GRAPH_ENABLED',
  'ENTITY_GRAPH_PROMPT_INJECTION',
  'CHAT_MAX_OUTPUT_TOKENS',
  'PORT',
  'TRUST_PROXY_HOPS',
  'MONGODB_URL',
  'MONGODB_HOST',
  'MONGODB_PASSWORD',
  'TOVA_EVAL_SCHEDULE',
  'TOVA_EVAL_HOUR_UTC',
  'TOVA_EVAL_MODELS',
  'TOVA_EVAL_MODEL',
  'TOVA_EVAL_PROVIDER',
] as const;

const backup: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of keys) {
    backup[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of keys) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe('config/index', () => {
  describe('complete env', () => {
    beforeEach(() => {
      process.env.JWT_SECRET = 'jwt-secret';
      process.env.GOOGLE_CLIENT_ID = 'cid';
      process.env.GOOGLE_CLIENT_SECRET = 'csecret';
      process.env.GOOGLE_CALLBACK_URL = 'http://cb';
      process.env.GOOGLE_SAFE_BROWSING_API_KEY = 'sb';
      process.env.DO_SPACES_BUCKET = 'tova';
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_REGION = 'nyc1';
      process.env.LANGSMITH_API_KEY = 'ls-key';
      process.env.LANGSMITH_PROJECT = 'tova-dev';
      process.env.BRAVE_SEARCH_API_KEY = 'brave';
      process.env.ENTITY_GRAPH_ENABLED = 'true';
      process.env.ENTITY_GRAPH_PROMPT_INJECTION = 'true';
      process.env.CHAT_MAX_OUTPUT_TOKENS = '2048';
      process.env.PORT = '4000';
      process.env.TRUST_PROXY_HOPS = '1';
      process.env.MONGODB_URL = 'mongodb://example/tova';
      process.env.MONGODB_HOST = 'example';
      process.env.MONGODB_PASSWORD = 'pw';
      process.env.TOVA_EVAL_SCHEDULE = 'daily';
      process.env.TOVA_EVAL_HOUR_UTC = '3';
      process.env.TOVA_EVAL_MODELS = 'groq:openai/gpt-oss-20b';
      process.env.TOVA_EVAL_MODEL = 'openai/gpt-oss-20b';
      process.env.TOVA_EVAL_PROVIDER = 'groq';
    });

    it('returns every set value as consumed today (||/?? chains absent)', () => {
      expect(config.jwt.secret).toBe('jwt-secret');
      expect(config.googleOAuth.clientId).toBe('cid');
      expect(config.googleOAuth.clientSecret).toBe('csecret');
      expect(config.googleOAuth.callbackUrl).toBe('http://cb');
      expect(config.safeBrowsing.apiKey).toBe('sb');
      expect(config.storage.bucket).toBe('tova');
      expect(config.storage.key).toBe('k');
      expect(config.storage.secret).toBe('s');
      expect(config.storage.region).toBe('nyc1');
      expect(config.langsmith.apiKey).toBe('ls-key');
      expect(config.langsmith.project).toBe('tova-dev');
      expect(config.search.braveApiKey).toBe('brave');
      expect(config.entityGraph.extractionEnabled).toBe(true);
      expect(config.entityGraph.promptInjectionEnabled).toBe(true);
      expect(config.chat.maxOutputTokens).toBe('2048');
      expect(config.runtime.port).toBe('4000');
      expect(config.runtime.trustProxyHops).toBe('1');
      expect(config.runtime.mongodbUrl).toBe('mongodb://example/tova');
      expect(config.runtime.mongodbHost).toBe('example');
      expect(config.runtime.mongodbPassword).toBe('pw');
      expect(config.evals.schedule).toBe('daily');
      expect(config.evals.hourUtc).toBe('3');
      expect(config.evals.models).toBe('groq:openai/gpt-oss-20b');
      expect(config.evals.model).toBe('openai/gpt-oss-20b');
      expect(config.evals.provider).toBe('groq');
    });
  });

  describe('missing/fallback env', () => {
    it('langsmith falls back to the LANGCHAIN_* aliases via ??', () => {
      process.env.LANGCHAIN_API_KEY = 'chain-key';
      process.env.LANGCHAIN_PROJECT = 'chain-project';
      expect(config.langsmith.apiKey).toBe('chain-key');
      expect(config.langsmith.project).toBe('chain-project');
    });

    it('langsmith key prefers LANGSMITH_* when both are set', () => {
      process.env.LANGSMITH_API_KEY = 'ls-key';
      process.env.LANGCHAIN_API_KEY = 'chain-key';
      expect(config.langsmith.apiKey).toBe('ls-key');
    });

    it('storage defaults region to lon1 and bucket to empty string (||)', () => {
      expect(config.storage.bucket).toBe('');
      expect(config.storage.region).toBe('lon1');
    });

    it('safe browsing falls back to GOOGLE_API_KEY then undefined (|| ... || undefined)', () => {
      expect(config.safeBrowsing.apiKey).toBeUndefined();
      process.env.GOOGLE_API_KEY = 'gk';
      expect(config.safeBrowsing.apiKey).toBe('gk');
    });

    it('booleans are truthiness checks, not string comparisons', () => {
      expect(config.entityGraph.extractionEnabled).toBe(false);
      process.env.ENTITY_GRAPH_ENABLED = 'false';
      expect(config.entityGraph.extractionEnabled).toBe(true);
      process.env.DO_SPACES_KEY = 'k';
      process.env.DO_SPACES_SECRET = 's';
      process.env.DO_SPACES_BUCKET = '';
      const isStorageConfigured = (): boolean =>
        Boolean(config.storage.key && config.storage.secret && config.storage.bucket);
      expect(isStorageConfigured()).toBe(false);
      process.env.DO_SPACES_BUCKET = 'b';
      expect(isStorageConfigured()).toBe(true);
    });

    it('evals schedule defaults to off and the model pair stays undefined (||)', () => {
      expect(config.evals.schedule).toBe('off');
      expect(config.evals.hourUtc).toBeUndefined();
      expect(config.evals.models).toBeUndefined();
      expect(config.evals.model).toBeUndefined();
      expect(config.evals.provider).toBeUndefined();
    });

    it('raw string accessors stay raw (no parsing in the module)', () => {
      process.env.CHAT_MAX_OUTPUT_TOKENS = 'garbage';
      expect(config.chat.maxOutputTokens).toBe('garbage');
    });
  });

  describe('jwt fail-fast parity with config/jwt.ts', () => {
    it('production without JWT_SECRET throws the same message', () => {
      process.env.NODE_ENV = 'production';
      expect(() => config.jwt.secret).toThrow(
        `${JWT_SECRET_ENV_VAR} must be set when NODE_ENV is 'production'`,
      );
      expect(() => getJwtSecret()).toThrow(
        `${JWT_SECRET_ENV_VAR} must be set when NODE_ENV is 'production'`,
      );
    });

    it('development without JWT_SECRET warns once and falls back', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('./jwt') as { getJwtSecret(): string };
        expect(fresh.getJwtSecret()).toBe('fallback_secret');
        expect(fresh.getJwtSecret()).toBe('fallback_secret');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          '%s is not set; using an insecure fallback secret (development only)',
          JWT_SECRET_ENV_VAR,
        );
      });
    });

    it('an empty-string JWT_SECRET in production throws (truthiness, not presence)', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = '';
      expect(() => getJwtSecret()).toThrow(/must be set/);
    });
  });
});
