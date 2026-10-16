import {
  pickPrimary,
  routingPrice,
  rosterScore,
  rosterModelsForTurn,
  recordTtft,
  ROSTER_SEED,
  RosterModel,
} from '../../main/services/rosterConfig';
import { ModelRoster } from '../../main/models/ModelRoster';

/*
 * #232 weighted primary pick and roster gating (pure functions; no Mongo).
 */

const model = (overrides: Partial<RosterModel>): RosterModel => ({
  modelId: 'm',
  label: 'M',
  tools: true,
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

describe('rosterModelsForTurn (#232, #316)', () => {
  it('keeps every model with a live provider — no vision gating', () => {
    const a = model({ modelId: 'a' });
    const b = model({ modelId: 'b', providers: [{ provider: 'fireworks', modelId: 'fw' }] });
    const candidates = rosterModelsForTurn([a, b]);
    expect(candidates.map((m) => m.modelId)).toEqual(['a', 'b']);
  });

  it('drops a model whose providers are all cooling off', () => {
    const cooling = model({
      modelId: 'cooling',
      providers: [
        { provider: 'deepinfra', modelId: 'di', disabledUntil: new Date(Date.now() + 60_000) },
      ],
    });
    expect(rosterModelsForTurn([cooling])).toEqual([]);
  });

  it('keeps a model with at least one live provider', () => {
    const halfCooling = model({
      modelId: 'half',
      providers: [
        { provider: 'deepinfra', modelId: 'di', disabledUntil: new Date(Date.now() + 60_000) },
        { provider: 'fireworks', modelId: 'fw' },
      ],
    });
    const candidates = rosterModelsForTurn([halfCooling]);
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
  it('defines exactly the two owner-locked models (#316: MiniMax is out)', () => {
    expect(ROSTER_SEED.map((m) => m.modelId)).toEqual([
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'zai-org/GLM-5.3-Flash',
    ]);
  });

  it('gives every model both serverless providers', () => {
    for (const m of ROSTER_SEED) {
      expect(m.providers.map((p) => p.provider).sort()).toEqual(['deepinfra', 'fireworks']);
    }
  });

  it('prices every provider entry (#235 per-provider price)', () => {
    for (const m of ROSTER_SEED) {
      for (const p of m.providers) {
        expect(Number.isFinite(p.inputPrice)).toBe(true);
        expect(Number.isFinite(p.outputPrice)).toBe(true);
      }
    }
  });
});

describe('recordTtft (#320 windowed mean)', () => {
  const modelId = 'test-ttft-window-model';

  const seedDoc = async (ttftMs: number | undefined, samples: number | undefined) => {
    await ModelRoster.deleteOne({ modelId });
    await ModelRoster.create({
      modelId,
      label: 'Window test',
      providers: [
        { provider: 'deepinfra', modelId: 'di-test', ttftMs, ttftSamples: samples },
        { provider: 'fireworks', modelId: 'fw-test' },
      ],
    });
  };

  const deepinfraEntry = async () => {
    const doc = await ModelRoster.findOne({ modelId }).lean();
    const providers = doc?.providers as unknown as
      | { provider: string; ttftMs?: number; ttftSamples?: number; disabledUntil?: Date | null }[]
      | undefined;
    return providers?.find((p) => p.provider === 'deepinfra');
  };

  afterEach(async () => {
    await ModelRoster.deleteOne({ modelId });
    delete process.env.ROSTER_TTFT_WINDOW;
  });

  it('takes the first observation exactly (no prior samples)', async () => {
    await seedDoc(undefined, undefined);
    await recordTtft(modelId, 'deepinfra', 250);
    const entry = await deepinfraEntry();
    expect(entry?.ttftMs).toBe(250);
    expect(entry?.ttftSamples).toBe(1);
  });

  it('caps the sample count at the window and forgets old observations', async () => {
    process.env.ROSTER_TTFT_WINDOW = '3';
    // Seeded history: mean 100 over 2 samples. First fold-in fills the window.
    await seedDoc(100, 2);
    await recordTtft(modelId, 'deepinfra', 1000);
    let entry = await deepinfraEntry();
    expect(entry?.ttftSamples).toBe(3);
    expect(entry?.ttftMs).toBeCloseTo((100 * 2 + 1000) / 3);

    // Second fold-in: the old mean's weight is capped at W-1 = 2, so the
    // seeded history decays out instead of weighing in forever.
    await recordTtft(modelId, 'deepinfra', 1000);
    entry = await deepinfraEntry();
    expect(entry?.ttftSamples).toBe(3);
    expect(entry?.ttftMs).toBeCloseTo((400 * 2 + 1000) / 3);
  });

  it('records providers independently', async () => {
    await seedDoc(undefined, undefined);
    await recordTtft(modelId, 'deepinfra', 250);
    await recordTtft(modelId, 'fireworks', 750);
    const doc = await ModelRoster.findOne({ modelId }).lean();
    const providers = doc?.providers as unknown as {
      provider: string;
      ttftMs?: number;
    }[];
    expect(providers.find((p) => p.provider === 'deepinfra')?.ttftMs).toBe(250);
    expect(providers.find((p) => p.provider === 'fireworks')?.ttftMs).toBe(750);
  });

  it('clears a cool-off on observation (#232 semantics preserved)', async () => {
    await seedDoc(undefined, undefined);
    await ModelRoster.updateOne(
      { modelId, 'providers.provider': 'deepinfra' },
      { $set: { 'providers.$.disabledUntil': new Date(Date.now() + 60_000) } },
    );
    await recordTtft(modelId, 'deepinfra', 250);
    const entry = await deepinfraEntry();
    expect(entry?.disabledUntil).toBeNull();
  });
});
