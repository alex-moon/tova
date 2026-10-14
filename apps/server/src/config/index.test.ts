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
  'TASK_MAX_STEPS',
  'TASK_MAX_COST_USD',
  'MEMORY_JUDGE_MODEL',
  'MEMORY_JUDGE_PROVIDER',
  'MEMORY_RESPONDER_MODEL',
  'MEMORY_RESPONDER_PROVIDER',
  'MEMORY_RESPONDER_TEMPERATURE',
  'MEMORY_EVAL_PACE_MS',
  'MEMORY_EVAL_GATE_PACE_MS',
  'MEMORY_EVAL_JUDGE_PACE_MS',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIM',
  'EMBEDDING_TIMEOUT_MS',
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

    it('storage configuration is a truthiness check, not a string comparison', () => {
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

    it('task budgets default when unset, malformed, empty, or non-positive (#254)', () => {
      expect(config.task.maxSteps).toBe(25);
      expect(config.task.maxCostUsd).toBe(5);
      for (const bad of ['garbage', '', '0', '-3', 'Infinity']) {
        process.env.TASK_MAX_STEPS = bad;
        process.env.TASK_MAX_COST_USD = bad;
        expect(config.task.maxSteps).toBe(25);
        expect(config.task.maxCostUsd).toBe(5);
      }
    });

    it('floors the step cap and defaults a value that floors to zero (#254)', () => {
      // `0.5` is positive but floors to a zero-step budget; it must degrade to
      // the default rather than become 0. A fractional cost is legitimate, so
      // the two getters deliberately differ here.
      process.env.TASK_MAX_STEPS = '0.5';
      process.env.TASK_MAX_COST_USD = '0.5';
      expect(config.task.maxSteps).toBe(25);
      expect(config.task.maxCostUsd).toBe(0.5);
    });

    it('task budgets parse a positive env value, flooring the step cap (#254)', () => {
      process.env.TASK_MAX_STEPS = '40.9';
      process.env.TASK_MAX_COST_USD = '2.5';
      expect(config.task.maxSteps).toBe(40);
      expect(config.task.maxCostUsd).toBe(2.5);
    });

    it('memory-eval judge defaults are pinned; responder overrides stay undefined (#289)', () => {
      expect(config.memoryEval.judgeModel).toBe('openai/gpt-oss-120b');
      expect(config.memoryEval.judgeProvider).toBe('groq');
      // Unset responder overrides fall through to the roster default in the
      // runner (T14c), so the getters must return undefined, not a pin.
      expect(config.memoryEval.responderModel).toBeUndefined();
      expect(config.memoryEval.responderProvider).toBeUndefined();
      expect(config.memoryEval.responderTemperature).toBe(0);
      expect(config.memoryEval.paceMs).toBe(1000);
      expect(config.memoryEval.gatePaceMs).toBe(2000);
      expect(config.memoryEval.judgePaceMs).toBe(2000);
    });

    it('memory-eval responder overrides and pacing parse from env (#289)', () => {
      process.env.MEMORY_RESPONDER_MODEL = 'openai/gpt-oss-20b';
      process.env.MEMORY_RESPONDER_PROVIDER = 'groq';
      process.env.MEMORY_RESPONDER_TEMPERATURE = '0.4';
      process.env.MEMORY_EVAL_PACE_MS = '250';
      process.env.MEMORY_EVAL_GATE_PACE_MS = '500';
      process.env.MEMORY_EVAL_JUDGE_PACE_MS = '750';
      expect(config.memoryEval.responderModel).toBe('openai/gpt-oss-20b');
      expect(config.memoryEval.responderProvider).toBe('groq');
      expect(config.memoryEval.responderTemperature).toBe(0.4);
      expect(config.memoryEval.paceMs).toBe(250);
      expect(config.memoryEval.gatePaceMs).toBe(500);
      expect(config.memoryEval.judgePaceMs).toBe(750);
    });

    it('memory-eval temperature and pacing fall back on malformed or negative values (#289)', () => {
      for (const bad of ['garbage', '', '-1', 'Infinity']) {
        process.env.MEMORY_RESPONDER_TEMPERATURE = bad;
        process.env.MEMORY_EVAL_PACE_MS = bad;
        process.env.MEMORY_EVAL_GATE_PACE_MS = bad;
        process.env.MEMORY_EVAL_JUDGE_PACE_MS = bad;
        expect(config.memoryEval.responderTemperature).toBe(0);
        expect(config.memoryEval.paceMs).toBe(1000);
        expect(config.memoryEval.gatePaceMs).toBe(2000);
        expect(config.memoryEval.judgePaceMs).toBe(2000);
      }
    });

    it('embeddings default model/dim/timeout when unset or malformed (#294)', () => {
      expect(config.embeddings.model).toBe('BAAI/bge-base-en-v1.5');
      expect(config.embeddings.dim).toBe(768);
      expect(config.embeddings.timeoutMs).toBe(800);
      for (const bad of ['garbage', '', '0', '-3', 'Infinity']) {
        process.env.EMBEDDING_DIM = bad;
        process.env.EMBEDDING_TIMEOUT_MS = bad;
        expect(config.embeddings.dim).toBe(768);
        expect(config.embeddings.timeoutMs).toBe(800);
      }
    });

    it('embeddings parse a positive env value, flooring the dimension (#294)', () => {
      process.env.EMBEDDING_MODEL = 'BAAI/bge-m3';
      process.env.EMBEDDING_DIM = '1024.9';
      process.env.EMBEDDING_TIMEOUT_MS = '1500';
      expect(config.embeddings.model).toBe('BAAI/bge-m3');
      expect(config.embeddings.dim).toBe(1024);
      expect(config.embeddings.timeoutMs).toBe(1500);
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
