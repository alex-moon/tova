import type { AdminLangsmithModelStats, AdminLangsmithStatsPayload } from '@tova/shared';
import { listRoster, type RosterModel } from './rosterConfig';

/*
 * Estimated LangSmith cost for the admin Traces cache (#224). The job stores
 * token counts only; this module joins them against the in-DB price
 * (roster provider `inputPrice`/`outputPrice`, USD per 1M tokens, #199) at read
 * time so a price fix shows up without waiting for the next poll.
 *
 * Price join key (#235). Under racing one model has two providers with
 * different prices, so the price is keyed by `(model, provider)`: a turn's
 * persisted `Message.provider` (or, for LangSmith, the provider when the trace
 * carries one — see #237) selects the provider entry whose price actually
 * applied. When the provider is unknown/absent (legacy rows, or a trace that
 * only names the model) we fall back to a deterministic model-only pick over
 * the model's provider entries plus the model-root default: prefer a
 * fully-priced entry (#199 unknown ≠ free), then provider name.
 *
 * Unknown price is `null`, distinct from `$0`: a partially-priced row does not
 * produce a half figure (mirrors `routingPrice` in rosterConfig).
 */

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

/*
 * A prebuilt `(model, provider)` price index. `byProvider` holds each model's
 * provider entries keyed by provider name; `fallback` holds the model-only
 * candidates (the model-root default plus every provider entry) for turns whose
 * provider is unknown. Built from the roster once per request so both cost
 * services query the roster a single time.
 */
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
    // Sort provider entries by name so the model-only fallback is deterministic
    // regardless of roster/seed order (matches the pre-#235 tie-break).
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

/*
 * Price for one `(model, provider)` pair. A known provider uses that provider's
 * entry when priced; otherwise (unknown provider, or a provider entry with no
 * price) it falls back to the deterministic model-only pick. Returns `null`
 * when the model has no known price at all.
 */
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

// Load the roster price index once. Mirrors `listRoster`'s empty-collection
// recovery and DB-failure fallback (a broken config read prices nothing rather
// than taking the admin surface down).
export const loadPriceIndex = async (): Promise<PriceIndex> => buildPriceIndex(await listRoster());

/*
 * Price one model's token split. Returns `null` when either side's price is
 * missing or non-finite — a partially-known model is rendered `—`, never a
 * half figure. Zero tokens price to `0` when the price is known.
 */
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

// Load the roster price index, then stamp each row and the totals with the
// estimate. #237: the rollup now carries the provider per row, so a raced
// model prices from the winning provider's entry; the model-only fallback in
// `priceFor` still covers a legacy no-provider row.
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
