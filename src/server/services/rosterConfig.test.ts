import {
  pickPrimary,
  routingPrice,
  rosterScore,
  rosterModelsForTurn,
  ROSTER_SEED,
  RosterModel,
} from './rosterConfig';

/*
 * #232 weighted primary pick and roster gating (pure functions; no Mongo).
 */

const model = (overrides: Partial<RosterModel>): RosterModel => ({
  modelId: 'm',
  label: 'M',
  tools: true,
  vision: true,
  providers: [{ provider: 'deepinfra', modelId: 'di' }],
  ...overrides,
});

describe('rosterScore (#232: f(TTFT) x price penalty)', () => {
  afterEach(() => {
    delete process.env.ROSTER_DEFAULT_TTFT_MS;
    delete process.env.ROSTER_PRICE_PENALTY_K;
  });

  it('scores a lower TTFT lower, all else equal', () => {
    const fast = rosterScore({ ttftMs: 100, inputPrice: 0.2, outputPrice: 0.6 });
    const slow = rosterScore({ ttftMs: 400, inputPrice: 0.2, outputPrice: 0.6 });
    expect(fast).toBeLessThan(slow);
  });

  it('penalises a higher price at equal TTFT', () => {
    const cheap = rosterScore({ ttftMs: 200, inputPrice: 0.15, outputPrice: 0.5 });
    const pricey = rosterScore({ ttftMs: 200, inputPrice: 0.28, outputPrice: 1.1 });
    expect(cheap).toBeLessThan(pricey);
  });

  it('uses the neutral default TTFT when no observation exists', () => {
    process.env.ROSTER_DEFAULT_TTFT_MS = '500';
    expect(rosterScore({ inputPrice: 0 })).toBe(500);
  });

  it('treats unknown/partial price as neutral (penalty 1)', () => {
    process.env.ROSTER_PRICE_PENALTY_K = '0.5';
    const unknown = rosterScore({ ttftMs: 100 });
    const zero = rosterScore({ ttftMs: 100, inputPrice: 0, outputPrice: 0 });
    expect(unknown).toBe(zero);
    expect(unknown).toBe(100);
  });

  it('honors the price-penalty slope', () => {
    process.env.ROSTER_PRICE_PENALTY_K = '1';
    // price 1 + 1 = 2, penalty 1 + 2 = 3.
    expect(rosterScore({ ttftMs: 100, inputPrice: 1, outputPrice: 1 })).toBe(300);
  });
});

describe('pickPrimary (#232)', () => {
  it('picks the lowest-scoring model', () => {
    const fastCheap = model({
      modelId: 'fast-cheap',
      inputPrice: 0.1,
      outputPrice: 0.1,
      providers: [{ provider: 'deepinfra', modelId: 'di', ttftMs: 100 }],
    });
    const slow = model({
      modelId: 'slow',
      inputPrice: 0.1,
      outputPrice: 0.1,
      providers: [{ provider: 'deepinfra', modelId: 'di', ttftMs: 900 }],
    });
    expect(pickPrimary([slow, fastCheap])?.modelId).toBe('fast-cheap');
  });

  it('breaks ties by roster order (stable)', () => {
    const a = model({
      modelId: 'a',
      providers: [{ provider: 'deepinfra', modelId: 'di', ttftMs: 100 }],
    });
    const b = model({
      modelId: 'b',
      providers: [{ provider: 'deepinfra', modelId: 'di', ttftMs: 100 }],
    });
    expect(pickPrimary([a, b])?.modelId).toBe('a');
    expect(pickPrimary([b, a])?.modelId).toBe('b');
  });

  it('returns null for an empty roster', () => {
    expect(pickPrimary([])).toBeNull();
  });
});

describe('rosterModelsForTurn (#232)', () => {
  it('excludes text-only models from image turns', () => {
    const textOnly = model({ modelId: 'text', vision: false });
    const vision = model({ modelId: 'vision', vision: true });
    const candidates = rosterModelsForTurn([textOnly, vision], true);
    expect(candidates.map((m) => m.modelId)).toEqual(['vision']);
  });

  it('keeps all models for text turns', () => {
    const textOnly = model({ modelId: 'text', vision: false });
    const vision = model({ modelId: 'vision', vision: true });
    const candidates = rosterModelsForTurn([textOnly, vision], false);
    expect(candidates.map((m) => m.modelId)).toEqual(['text', 'vision']);
  });

  it('drops a model whose providers are all cooling off', () => {
    const cooling = model({
      modelId: 'cooling',
      providers: [
        { provider: 'deepinfra', modelId: 'di', disabledUntil: new Date(Date.now() + 60_000) },
      ],
    });
    expect(rosterModelsForTurn([cooling], false)).toEqual([]);
  });

  it('keeps a model with at least one live provider', () => {
    const halfCooling = model({
      modelId: 'half',
      providers: [
        { provider: 'deepinfra', modelId: 'di', disabledUntil: new Date(Date.now() + 60_000) },
        { provider: 'fireworks', modelId: 'fw' },
      ],
    });
    const candidates = rosterModelsForTurn([halfCooling], false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].providers.map((p) => p.provider)).toEqual(['fireworks']);
  });
});

describe('routingPrice (#199, moved with the roster in #233)', () => {
  it('sums input and output price when both are present', () => {
    expect(routingPrice({ inputPrice: 1.3, outputPrice: 2.6 })).toBeCloseTo(3.9);
    expect(routingPrice({ inputPrice: 0.085, outputPrice: 0.4 })).toBeCloseTo(0.485);
  });

  it('treats a missing component as unknown, not zero', () => {
    expect(routingPrice({ outputPrice: 2.6 })).toBeUndefined();
    expect(routingPrice({ inputPrice: 1.3 })).toBeUndefined();
    expect(routingPrice({})).toBeUndefined();
  });

  it('treats a non-finite component as unknown', () => {
    expect(routingPrice({ inputPrice: NaN, outputPrice: 1 })).toBeUndefined();
    expect(routingPrice({ inputPrice: 1, outputPrice: NaN })).toBeUndefined();
    expect(routingPrice({ inputPrice: Infinity, outputPrice: 1 })).toBeUndefined();
    expect(routingPrice({ inputPrice: 1, outputPrice: -Infinity })).toBeUndefined();
  });
});

describe('ROSTER_SEED (#232 owner-locked roster)', () => {
  it('defines exactly the three owner-locked models', () => {
    expect(ROSTER_SEED.map((m) => m.modelId)).toEqual([
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'zai-org/GLM-5.3-Flash',
      'MiniMaxAI/MiniMax-M3',
    ]);
  });

  it('gives every model both serverless providers', () => {
    for (const m of ROSTER_SEED) {
      expect(m.providers.map((p) => p.provider).sort()).toEqual(['deepinfra', 'fireworks']);
    }
  });

  it('marks MiniMax M3 text-only and excludes it from image turns', () => {
    const minimax = ROSTER_SEED.find((m) => m.modelId === 'MiniMaxAI/MiniMax-M3');
    expect(minimax?.vision).toBe(false);
    expect(rosterModelsForTurn(ROSTER_SEED, true).map((m) => m.modelId)).not.toContain(
      'MiniMaxAI/MiniMax-M3',
    );
  });
});
