import type { AdminLangsmithModelStats, AdminLangsmithStatsPayload } from '@tova/shared';
import { listRoster, type RosterModel } from './rosterConfig';

/* Cost for the Traces cache: joins stored tokens against roster prices. */
// @see #224 #199 #235 #237

export interface PriceLookup {
  inputPrice?: number;
  outputPrice?: number;
}

// Deterministic best-row pick from the rows sharing one model string.
export const pickPriceRow = (rows: PriceLookup[]): PriceLookup | null => {
  const bothKnown = rows.filter(
    (r) => Number.isFinite(r.inputPrice) && Number.isFinite(r.outputPrice),
  );
  const candidates = bothKnown.length > 0 ? bothKnown : rows;
  if (candidates.length === 0) return null;
  return candidates[0];
};

/* Prebuilt (model, provider) price index plus model-only fallbacks. */
export interface PriceIndex {
  byProvider: Map<string, Map<string, PriceLookup>>;
  fallback: Map<string, PriceLookup[]>;
}

const priceOf = (ref: { inputPrice?: number; outputPrice?: number }): PriceLookup | null =>
  ref.inputPrice !== undefined || ref.outputPrice !== undefined
    ? { inputPrice: ref.inputPrice, outputPrice: ref.outputPrice }
    : null;

export const buildPriceIndex = (roster: RosterModel[]): PriceIndex => {
  const byProvider = new Map<string, Map<string, PriceLookup>>();
  const fallback = new Map<string, PriceLookup[]>();

  for (const model of roster) {
    const providers = new Map<string, PriceLookup>();
    const candidates: PriceLookup[] = [];
    const modelDefault = priceOf(model);
    if (modelDefault) candidates.push(modelDefault);
    // Sort by provider name so the fallback pick is deterministic.
    for (const p of model.providers.slice().sort((a, b) => a.provider.localeCompare(b.provider))) {
      const price = priceOf(p);
      if (!price) continue;
      providers.set(p.provider, price);
      candidates.push(price);
    }
    if (providers.size > 0) byProvider.set(model.modelId, providers);
    if (candidates.length > 0) fallback.set(model.modelId, candidates);
  }

  return { byProvider, fallback };
};

/* Price for one (model, provider), with deterministic model-only fallback. */
export const priceFor = (
  index: PriceIndex,
  modelId: string,
  provider?: string,
): PriceLookup | null => {
  if (provider) {
    const hit = index.byProvider.get(modelId)?.get(provider);
    if (hit) return hit;
  }
  return pickPriceRow(index.fallback.get(modelId) ?? []);
};

// Load the roster price index; mirrors listRoster's fallback semantics.
export const loadPriceIndex = async (): Promise<PriceIndex> => buildPriceIndex(await listRoster());

/* Price one token split; null when either price is missing. */
export const estimateCostUsd = (
  inputTokens: number,
  outputTokens: number,
  price: PriceLookup | null,
): number | null => {
  if (!price) return null;
  const { inputPrice, outputPrice } = price;
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null;
  return (
    (inputTokens / 1e6) * (inputPrice as number) + (outputTokens / 1e6) * (outputPrice as number)
  );
};

// Stamp each row and the totals; raced models price from the winner.
// @see #237
export const applyCostToStats = async (
  payload: AdminLangsmithStatsPayload,
  index?: PriceIndex,
): Promise<AdminLangsmithStatsPayload> => {
  if (payload.models.length === 0) {
    return { ...payload, totals: { ...payload.totals, estimatedCostUsd: null } };
  }

  const priceIndex = index ?? (await loadPriceIndex());

  let anyKnown = false;
  let costSum = 0;

  const models: AdminLangsmithModelStats[] = payload.models.map((m) => {
    const cost = estimateCostUsd(
      m.inputTokens,
      m.outputTokens,
      priceFor(priceIndex, m.model, m.provider ?? undefined),
    );
    if (cost !== null) {
      anyKnown = true;
      costSum += cost;
    }
    return { ...m, estimatedCostUsd: cost };
  });

  return {
    ...payload,
    models,
    totals: { ...payload.totals, estimatedCostUsd: anyKnown ? costSum : null },
  };
};
