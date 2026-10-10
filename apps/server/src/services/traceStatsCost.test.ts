import { ModelRoster } from '../models/ModelRoster';
import { applyCostToStats, estimateCostUsd, pickPriceRow } from './traceStatsCost';
import type { AdminLangsmithStatsPayload } from '@tova/shared';

const basePayload = (models: AdminLangsmithStatsPayload['models']): AdminLangsmithStatsPayload => ({
  since: '2026-09-20T00:00:00.000Z',
  models,
  totals: { calls: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 },
});

const row = (partial: Partial<AdminLangsmithStatsPayload['models'][number]>) => ({
  model: 'm',
  calls: 1,
  errors: 0,
  avgDurationMs: null,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: null,
  ...partial,
});

// #235: a roster model carrying two priced providers (the dual-price case).
const seedModel = (
  modelId: string,
  providers: { provider: string; inputPrice?: number; outputPrice?: number }[],
) =>
  ModelRoster.create({
    modelId,
    label: modelId,
    tools: true,
    vision: true,
    eligible: true,
    providers: providers.map((p) => ({ ...p, modelId, enabled: true, disabledUntil: null })),
  });

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

describe('applyCostToStats (#224/#235)', () => {
  it('stamps each priced model and the totals', async () => {
    await seedModel('priced/model', [{ provider: 'deepinfra', inputPrice: 1, outputPrice: 2 }]);

    const result = await applyCostToStats(
      basePayload([
        row({ model: 'priced/model', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ]),
    );

    expect(result.models[0].estimatedCostUsd).toBe(3);
    expect(result.totals.estimatedCostUsd).toBe(3);
  });

  it('renders an unpriced model as null and keeps totals null when none priced', async () => {
    const result = await applyCostToStats(
      basePayload([row({ model: 'unknown/model', inputTokens: 10, outputTokens: 10 })]),
    );
    expect(result.models[0].estimatedCostUsd).toBeNull();
    expect(result.totals.estimatedCostUsd).toBeNull();
  });

  it('sums only the priced models and leaves unknown ones null', async () => {
    await seedModel('priced/one', [{ provider: 'deepinfra', inputPrice: 1, outputPrice: 1 }]);

    const result = await applyCostToStats(
      basePayload([
        row({ model: 'priced/one', inputTokens: 1_000_000, outputTokens: 0 }),
        row({ model: 'unknown/model', inputTokens: 999, outputTokens: 999 }),
      ]),
    );

    expect(result.models[0].estimatedCostUsd).toBe(1);
    expect(result.models[1].estimatedCostUsd).toBeNull();
    expect(result.totals.estimatedCostUsd).toBe(1);
  });

  it('treats a partially-priced model as unknown (unknown ≠ 0)', async () => {
    await seedModel('half/model', [{ provider: 'deepinfra', inputPrice: 1 }]);

    const result = await applyCostToStats(
      basePayload([row({ model: 'half/model', inputTokens: 1_000_000, outputTokens: 0 })]),
    );
    expect(result.models[0].estimatedCostUsd).toBeNull();
  });

  it('uses the model-only fallback when the rollup names a dual-priced model (#235)', async () => {
    // The LangSmith rollup is model-keyed; with two priced providers the
    // fallback prefers the fully-priced, alphabetically-first provider
    // (`deepinfra`). The rollup cannot split by provider until #237 exports it.
    await seedModel('dual/model', [
      { provider: 'fireworks', inputPrice: 10, outputPrice: 10 },
      { provider: 'deepinfra', inputPrice: 1, outputPrice: 1 },
    ]);

    const result = await applyCostToStats(
      basePayload([row({ model: 'dual/model', inputTokens: 1_000_000, outputTokens: 0 })]),
    );
    expect(result.models[0].estimatedCostUsd).toBe(1);
  });
});
