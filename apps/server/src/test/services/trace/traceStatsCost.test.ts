import {
  applyCostToStats,
  buildPriceIndex,
  estimateCostUsd,
  pickPriceRow,
  priceFor,
  type PriceIndex,
  type PriceLookup,
} from '../../../main/services/trace/traceStatsCost';
import { CHAT_MODEL } from '../../../main/services/model/modelDefaults';
import type { AdminLangsmithStatsPayload } from '@tova/shared';

const basePayload = (models: AdminLangsmithStatsPayload['models']): AdminLangsmithStatsPayload => ({
  since: '2026-09-20T00:00:00.000Z',
  models,
  totals: {
    calls: 0,
    errors: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: null,
  },
});

const row = (
  partial: Partial<AdminLangsmithStatsPayload['models'][number]>,
): AdminLangsmithStatsPayload['models'][number] => ({
  model: 'm',
  provider: null,
  calls: 1,
  errors: 0,
  avgDurationMs: null,
  avgTtftMs: null,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: null,
  ...partial,
});

// Synthetic index over arbitrary models, standing in for the static table.
// @see #387
const makeIndex = (
  models: Record<string, { provider: string; inputPrice: number; outputPrice: number }[]>,
): PriceIndex => {
  const byProvider = new Map<string, Map<string, PriceLookup>>();
  const fallback = new Map<string, PriceLookup[]>();
  for (const [modelId, providers] of Object.entries(models)) {
    const rows = providers.map((p) => ({ inputPrice: p.inputPrice, outputPrice: p.outputPrice }));
    byProvider.set(modelId, new Map(providers.map((p, i) => [p.provider, rows[i]])));
    fallback.set(modelId, rows);
  }
  return { byProvider, fallback };
};

describe('estimateCostUsd (#224)', () => {
  it('multiplies each side by its per-1M price', () => {
    // 1M in at $1 + 2M out at $3 = $7.
    expect(estimateCostUsd(1_000_000, 2_000_000, { inputPrice: 1, outputPrice: 3 })).toBe(7);
  });

  it('prices zero tokens to 0 when the price is known', () => {
    expect(estimateCostUsd(0, 0, { inputPrice: 1, outputPrice: 3 })).toBe(0);
  });

  it('returns null when either price is missing, not a half figure', () => {
    expect(estimateCostUsd(1_000_000, 0, { inputPrice: 1 })).toBeNull();
    expect(estimateCostUsd(0, 1_000_000, { outputPrice: 3 })).toBeNull();
  });

  it('returns null for non-finite prices', () => {
    expect(estimateCostUsd(1, 1, { inputPrice: NaN, outputPrice: 1 })).toBeNull();
    expect(estimateCostUsd(1, 1, { inputPrice: 1, outputPrice: Infinity })).toBeNull();
  });

  it('returns null when no row matched', () => {
    expect(estimateCostUsd(1, 1, null)).toBeNull();
  });

  it('prefers a fully-priced row when a model has several', () => {
    const chosen = pickPriceRow([{ inputPrice: 5 }, { inputPrice: 1, outputPrice: 3 }]);
    expect(chosen).toEqual({ inputPrice: 1, outputPrice: 3 });
  });
});

describe('buildPriceIndex/priceFor (#387 static table)', () => {
  it('prices the chat model on both wired providers', () => {
    const index = buildPriceIndex();
    expect(priceFor(index, CHAT_MODEL, 'deepinfra')).toEqual({
      inputPrice: 0.15,
      outputPrice: 0.5,
    });
    expect(priceFor(index, CHAT_MODEL, 'fireworks')).toEqual({
      inputPrice: 0.15,
      outputPrice: 0.5,
    });
  });

  it('falls back to the model-only row and nulls unknown models', () => {
    const index = buildPriceIndex();
    expect(priceFor(index, CHAT_MODEL)).toEqual({ inputPrice: 0.15, outputPrice: 0.5 });
    expect(priceFor(index, 'unknown/model', 'deepinfra')).toBeNull();
  });
});

describe('applyCostToStats (#224/#235)', () => {
  it('stamps each priced model and the totals', async () => {
    const index = makeIndex({
      'priced/model': [{ provider: 'deepinfra', inputPrice: 1, outputPrice: 2 }],
    });
    const result = await applyCostToStats(
      basePayload([
        row({ model: 'priced/model', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]),
      index,
    );

    expect(result.models[0].estimatedCostUsd).toBe(3);
    expect(result.totals.estimatedCostUsd).toBe(3);
  });

  it('renders an unpriced model as null and keeps totals null when none priced', async () => {
    const result = await applyCostToStats(
      basePayload([row({ model: 'unknown/model', inputTokens: 10, outputTokens: 10 })]),
      makeIndex({}),
    );
    expect(result.models[0].estimatedCostUsd).toBeNull();
    expect(result.totals.estimatedCostUsd).toBeNull();
  });

  it('sums only the priced models and leaves unknown ones null', async () => {
    const index = makeIndex({
      'priced/one': [{ provider: 'deepinfra', inputPrice: 1, outputPrice: 1 }],
    });
    const result = await applyCostToStats(
      basePayload([
        row({ model: 'priced/one', inputTokens: 1_000_000, outputTokens: 0 }),
        row({ model: 'unknown/model', inputTokens: 999, outputTokens: 999 }),
      ]),
      index,
    );

    expect(result.models[0].estimatedCostUsd).toBe(1);
    expect(result.models[1].estimatedCostUsd).toBeNull();
    expect(result.totals.estimatedCostUsd).toBe(1);
  });

  it('treats a partially-priced model as unknown (unknown ≠ 0)', async () => {
    const index = makeIndex({
      'half/model': [{ provider: 'deepinfra', inputPrice: 1, outputPrice: NaN }],
    });
    const result = await applyCostToStats(
      basePayload([row({ model: 'half/model', inputTokens: 1_000_000, outputTokens: 0 })]),
      index,
    );
    expect(result.models[0].estimatedCostUsd).toBeNull();
  });

  it('uses the per-provider row when the rollup names one (#235)', async () => {
    const index = makeIndex({
      'dual/model': [
        { provider: 'deepinfra', inputPrice: 1, outputPrice: 1 },
        { provider: 'fireworks', inputPrice: 10, outputPrice: 10 },
      ],
    });

    const result = await applyCostToStats(
      basePayload([
        row({
          model: 'dual/model',
          provider: 'fireworks',
          inputTokens: 1_000_000,
          outputTokens: 0,
        }),
      ]),
      index,
    );
    expect(result.models[0].estimatedCostUsd).toBe(10);
  });
});
