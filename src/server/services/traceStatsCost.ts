import { ProviderRouting } from '../models/ProviderRouting';
import type { AdminLangsmithModelStats, AdminLangsmithStatsPayload } from '../../shared/contracts';

/*
 * Estimated LangSmith cost for the admin Traces cache (#224). The job stores
 * token counts only; this module joins them against the in-DB price
 * (`ProviderRouting.inputPrice`/`outputPrice`, USD per 1M tokens, #199) at
 * read time so a price fix shows up without waiting for the next poll.
 *
 * Price join key (plan OQ-3). `ProviderRouting` is unique on
 * `{tier, provider, model}`, so in principle one model string can appear on
 * several rows; the trace's `llm` child carries `ls_provider` only on *some*
 * runs (verified against `tova-dev` 2026-10-07), so `(provider, model)` is not
 * reliably available. We therefore key on `model` and pick one row
 * deterministically: prefer a row with both prices known (#199 unknown ≠ free),
 * then provider name. Today no model string is duplicated, so the tie-break is
 * a guard against future collisions, not a live behaviour.
 *
 * Unknown price is `null`, distinct from `$0`: a partially-priced row does not
 * produce a half figure (mirrors `routingPrice` in modelConfigService).
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

// Load one price row per distinct model in the payload, then stamp each row
// and the totals with the estimate. Escapes out-of-range/non-finite names by
// querying with an allowlist rather than interpolating.
export const applyCostToStats = async (
  payload: AdminLangsmithStatsPayload,
): Promise<AdminLangsmithStatsPayload> => {
  const modelNames = [...new Set(payload.models.map((m) => m.model))];
  if (modelNames.length === 0) {
    return { ...payload, totals: { ...payload.totals, estimatedCostUsd: null } };
  }

  const rows = await ProviderRouting.find({ model: { $in: modelNames } })
    .select({ model: 1, provider: 1, inputPrice: 1, outputPrice: 1 })
    .lean<{ model: string; provider?: string; inputPrice?: number; outputPrice?: number }[]>();

  const byModel = new Map<string, PriceLookup[]>();
  const sorted = rows.slice().sort((a, b) => (a.provider ?? '').localeCompare(b.provider ?? ''));
  for (const row of sorted) {
    const bucket = byModel.get(row.model) ?? [];
    bucket.push(row);
    byModel.set(row.model, bucket);
  }

  let anyKnown = false;
  let costSum = 0;

  const models: AdminLangsmithModelStats[] = payload.models.map((m) => {
    const cost = estimateCostUsd(
      m.inputTokens,
      m.outputTokens,
      pickPriceRow(byModel.get(m.model) ?? []),
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
