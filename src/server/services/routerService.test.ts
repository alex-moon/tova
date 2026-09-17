import { pickModelRef, routeQuery } from './routerService';
import { ModelRef } from './modelConfigService';
import { FitWeight } from './modelMetricsStatsService';
import { muteConsoleError } from '../test/muteConsole';

const groqSmall: ModelRef = { provider: 'groq', model: 'test-small-model' };
const groqSmallAlt: ModelRef = { provider: 'groq', model: 'test-small-model-2' };
const groqLarge: ModelRef = { provider: 'groq', model: 'test-large-model' };

const TEST_CONFIG = {
  small: [groqSmall],
  large: [groqLarge],
  guardModel: 'test-guard-model',
};

const routeQueryWithCfg = (query: string) => routeQuery(query, TEST_CONFIG);

const mockGenerate = jest.fn();

jest.mock('@mastra/core/agent', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    generate: (...args: unknown[]) => mockGenerate(...args),
  })),
}));

jest.mock('./modelConfigService', () => ({
  listByTier: jest.fn(),
}));
const mockListByTier = jest.requireMock('./modelConfigService').listByTier as jest.Mock;

const mockAgentCtor = jest.requireMock('@mastra/core/agent').Agent as jest.Mock;

type Routing = Awaited<ReturnType<typeof routeQuery>>;

// The error-path tests intentionally break the mocked classifier; keep that
// expected fallback error out of the test output.
// The error-path tests intentionally break the mocked classifier; keep that
// expected fallback error out of the test output.
let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = muteConsoleError();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const classifyAs = (content: string, error = false) => {
  mockGenerate.mockReset();
  if (error) {
    mockGenerate.mockRejectedValueOnce(new Error('classifier down'));
  } else {
    mockGenerate.mockResolvedValueOnce({ text: content });
  }
};

describe('Router Service', () => {
  describe('Deterministic Routing', () => {
    it('should route short greetings to the smaller model', async () => {
      const result = await routeQueryWithCfg('Hello');
      expect(result.model).toBe('test-small-model');
      expect(result.reason).toBe('deterministic-short');
    });

    it('should recognize other greeting/confirmation variants', async () => {
      for (const query of ['Hey', 'thanks', 'OK', 'Yes, do it', 'thank you']) {
        const result = await routeQueryWithCfg(query);
        expect(result.reason).toBe('deterministic-short');
      }
    });

    it('should route requests for code to the larger model', async () => {
      const result = await routeQueryWithCfg('Write a Python function to sort a list');
      expect(result.model).toBe('test-large-model');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should match code keywords case-insensitively', async () => {
      const result = await routeQueryWithCfg('Help me write a SCRIPT');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should route fenced code blocks to the larger model', async () => {
      const result = await routeQueryWithCfg('What does this do?\n```js\nconsole.log(1);\n```');
      expect(result.reason).toBe('deterministic-code');
    });

    it('should not treat a long greeting as a deterministic rule', async () => {
      classifyAs('simple');
      const result = await routeQueryWithCfg('Hello there, how are you doing today?');
      // Longer than 20 chars: falls through to the classifier.
      expect(result.reason).toBe('classifier-simple');
    });

    it('should send a short non-greeting query to the classifier', async () => {
      classifyAs('simple');
      const result = await routeQueryWithCfg('2 + 2');
      expect(result.reason).toBe('classifier-simple');
    });
  });

  describe('Classifier Routing', () => {
    it('should route queries classified as complex to the larger model', async () => {
      classifyAs('complex');
      const result = await routeQueryWithCfg(
        'Explain the tradeoffs of event sourcing in distributed systems',
      );
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-complex',
        provider: 'groq',
      });
    });

    it('should route queries classified as simple to the smaller model', async () => {
      classifyAs('simple');
      const result = await routeQueryWithCfg('Give me a one-line haiku about rain');
      expect(result).toEqual({
        model: 'test-small-model',
        reason: 'classifier-simple',
        provider: 'groq',
      });
    });

    it('should normalize classifier output when deciding', async () => {
      classifyAs('  COMPLEX\n  ');
      const result = await routeQueryWithCfg('Advise a go-to-market plan for a new SaaS product');
      expect(result.reason).toBe('classifier-complex');
    });

    it('should fall back to the larger model when the classifier errors', async () => {
      classifyAs('', true);
      const result = await routeQueryWithCfg('Should I buy this car or that car?');
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'classifier-error',
        provider: 'groq',
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Classifier error:',
        expect.objectContaining({ message: 'classifier down' }),
      );
    });

    it('should fall back to the smaller model on an unrecognized classification', async () => {
      classifyAs('unsure');
      const result = await routeQueryWithCfg('Tell me about classic cars');
      expect(result).toEqual({
        model: 'test-small-model',
        reason: 'classifier-simple',
        provider: 'groq',
      });
    });

    it('sends the query to the guard classifier', async () => {
      classifyAs('simple');
      await routeQueryWithCfg('Give me investment advice');
      const [messages, options] = mockGenerate.mock.calls[0] as unknown as [
        { role: string; content: string }[],
        { modelSettings: { temperature: number } },
      ];
      const ctorArgs = mockAgentCtor.mock.calls[mockAgentCtor.mock.calls.length - 1] as unknown[];
      const ctorCall = (ctorArgs?.[0] ?? {}) as { model: string };
      expect(ctorCall.model).toBe('groq/test-guard-model');
      expect(options.modelSettings.temperature).toBe(0);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toMatch(/simple|complex/i);
    });
  });

  describe('ε-random tier pools (#4 task 7)', () => {
    const pool = (
      models: ModelRef[],
    ): { small: ModelRef[]; large: ModelRef[]; guardModel: string } => ({
      small: models,
      large: models,
      guardModel: 'test-guard-model',
    });

    it('uses the single qualifying model deterministically', () => {
      expect(pickModelRef([groqSmall], 'small', 1, () => 0)).toBe(groqSmall);
      expect(pickModelRef([groqSmall], 'small', 1, () => 0.999)).toBe(groqSmall);
    });

    it('throws loudly when a tier has no eligible models (#4 G)', () => {
      expect(() => pickModelRef([], 'small', 1, () => 0)).toThrow(
        'No eligible models configured for tier: small',
      );
    });

    it('picks uniformly at random within a multi-model pool (eps default 1)', () => {
      const models = [groqSmall, groqLarge];
      const a = pickModelRef(models, 'small', 1, () => 0);
      const b = pickModelRef(models, 'small', 1, () => 0.49);
      const c = pickModelRef(models, 'small', 1, () => 0.51);
      expect(a).toBe(groqSmall);
      expect(b).toBe(groqSmall);
      expect(c).toBe(groqLarge);
    });

    it('exploits the first entry when the draw beats epsilon (eps < 1)', () => {
      const models = [groqSmall, groqLarge];
      // draw >= eps → exploit (first entry); draw < eps → explore (uniform,
      // from an independent draw so the explore/index probabilities decouple).
      expect(pickModelRef(models, 'small', 0.3, () => 0.31)).toBe(groqSmall);
      // First draw 0.2 < eps=0.3 explores; second draw selects the second entry.
      const draws = [0.2, 0.6];
      let i = 0;
      expect(pickModelRef(models, 'small', 0.3, () => draws[i++] ?? 0)).toBe(groqLarge);
    });

    it('is deterministic across eps=0', () => {
      const models = [groqSmall, groqLarge];
      expect(pickModelRef(models, 'small', 0, () => 0.99)).toBe(groqSmall);
    });

    it('routes a multi-model tier through the pool for a deterministic rule', async () => {
      const result = await routeQuery(
        'Hello',
        pool([{ ...groqSmall }, { ...groqLarge }]),
        () => 0.9,
      );
      expect(result).toEqual({
        model: 'test-large-model',
        reason: 'deterministic-short',
        provider: 'groq',
      });
    });

    it('records the picked provider from the pool, not a hard-coded groq', async () => {
      // Non-trivial pool with a DeepInfra entry selected by the injected PRNG.
      const result = await routeQuery(
        'Hello',
        pool([groqSmall, { provider: 'deepinfra', model: 'gemma-test' }]),
        () => 0.9,
      );
      expect(result.model).toBe('gemma-test');
      expect(result.provider).toBe('deepinfra');
    });
  });

  describe('Feedback weighting (#18, re-implemented on tier pools)', () => {
    const twoPool = (
      small: ModelRef[] = [groqSmall],
      large: ModelRef[] = [groqLarge, groqSmallAlt],
    ): { small: ModelRef[]; large: ModelRef[]; guardModel: string } => ({
      small,
      large,
      guardModel: 'test-guard-model',
    });

    const emptyStat = (): FitWeight => ({ weight: 1, ups: 0, downs: 0 });
    const stat = (ups: number, downs: number): FitWeight => ({
      weight: (ups + 1) / (ups + downs + 2),
      ups,
      downs,
    });

    const randomAt = (value: number) => () => value;

    it('is a pure perturbation: no tallies anywhere keeps ε behavior and no suffix', async () => {
      classifyAs('complex');
      const result = await routeQuery('Design a caching strategy', twoPool(), randomAt(0.1), {
        band: 'medium|code',
        getFitWeight: async () => emptyStat(),
      });
      expect(result.model).toBe('test-large-model');
      expect(result.reason).toBe('classifier-complex');
    });

    it('forces the best-fit pool entry when the leader ratio clears the flip ratio', async () => {
      classifyAs('complex');
      // Large pool: classifier-pick candidate has heavily negative data, the
      // rival cell is strongly positive → forced onto the rival.
      const result = await routeQuery(
        'Explain event sourcing tradeoffs',
        twoPool([groqSmall], [groqLarge, groqSmallAlt]),
        randomAt(0.9),
        {
          band: 'long|prose',
          getFitWeight: async (_band, model) =>
            model === 'test-small-model-2' ? stat(12, 2) : stat(0, 12),
        },
      );
      expect(result.model).toBe('test-small-model-2');
      expect(result.reason).toContain('classifier-complex');
      expect(result.reason).toContain(';feedback-weight:');
    });

    it('does not force a flip when the evidence is under the ratio', async () => {
      classifyAs('complex');
      // Leader (neutral empty cell, weight 1) vs 3/0 fit (weight 0.67):
      // ratio 1.5 ≥ 1.25 would force — set the leader score lower instead.
      const result = await routeQuery('Design a caching strategy', twoPool(), randomAt(0.9), {
        band: 'medium|code',
        getFitWeight: async (_band, model) =>
          model === 'test-small-model-2' ? stat(3, 0) : emptyStat(),
      });
      expect(result.model).toBe('test-large-model');
      // No flip, but the leader's tallies still surface in the reason.
      expect(result.reason).toContain('classifier-complex');
      expect(result.reason).toContain(';feedback-weight:1.00:0/0');
    });

    it('leaves deterministic rules and classifier-error untouched by feedback', async () => {
      const greet = await routeQueryWithCfg('Hello');
      expect(greet.reason).toBe('deterministic-short');
      const code = await routeQueryWithCfg('write code');
      expect(code.reason).toBe('deterministic-code');
      classifyAs('', true);
      const errored = await routeQuery(
        'Should I buy this or that car?',
        twoPool([groqSmall], [groqLarge, groqSmallAlt]),
        randomAt(0.9),
        { band: 'medium|prose', getFitWeight: async () => stat(20, 0) },
      );
      expect(errored.reason).toBe('classifier-error');
    });

    it('still works when no band is supplied', async () => {
      classifyAs('simple');
      const result = await routeQuery('Give me investment advice now', TEST_CONFIG, randomAt(0.5), {
        getFitWeight: async () => emptyStat(),
      });
      expect(result).toEqual({
        model: 'test-small-model',
        reason: 'classifier-simple',
        provider: 'groq',
      });
    });
  });

  describe('DB-config routing (#4 task 7)', () => {
    it('resolves tier pools from modelConfigService when no config is passed', async () => {
      mockListByTier.mockImplementation(async (tier: string) =>
        tier === 'small'
          ? [groqSmall, { provider: 'deepinfra', model: 'gemma-test' }]
          : [groqLarge],
      );
      classifyAs('simple');
      const result = await routeQuery('Tell me about classic cars', null, () => 0.9);
      expect(mockListByTier).toHaveBeenCalledWith('small');
      expect(mockListByTier).toHaveBeenCalledWith('large');
      expect(result.model).toBe('gemma-test');
      expect(result.reason).toBe('classifier-simple');
      expect(result.provider).toBe('deepinfra');
    });

    it('fails loudly when the DB-config tier resolves empty (#4 G)', async () => {
      mockListByTier.mockResolvedValue([]);
      await expect(routeQuery('Hello')).rejects.toThrow('No eligible models configured for tier');
    });
  });

  describe('Routing metadata contract', () => {
    it('always returns a model and a human-readable reason', async () => {
      const cases: Promise<Routing>[] = [
        routeQueryWithCfg('Hello'),
        routeQueryWithCfg('write code'),
        (async () => {
          classifyAs('complex');
          return routeQueryWithCfg('Design a caching strategy');
        })(),
        (async () => {
          classifyAs('', true);
          return routeQueryWithCfg('Pick a color for me out of two options');
        })(),
      ];
      const results = await Promise.all(cases);
      for (const { model, reason, provider } of results) {
        expect(model).toMatch(/^test-(small|large)-model(-2)?$/);
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
        expect(provider).toBe('groq');
      }
    });
  });
});
