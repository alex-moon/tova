import { ModelRoster } from '../models/ModelRoster';

/*
 * #232: the fixed model roster and its weighted primary pick.
 *
 * This module is the data layer for the racing runtime (`racingService.ts`):
 * it owns the roster definition, the rolling-TTFT reads/writes, the per-provider
 * cool-off, and the weighted score that selects the primary model for a turn.
 *
 * It deliberately COEXISTS with the tier machinery (`modelConfigService` /
 * `routerService`); the tier deletion is #233. Nothing here imports the tier
 * router, and the tier router does not import this.
 */

/** Providers a roster model can be raced across (serverless, pay-per-token). */
export type RosterProvider = 'deepinfra' | 'fireworks';

/** Every provider the racing path can talk to. */
export const ROSTER_PROVIDERS: RosterProvider[] = ['deepinfra', 'fireworks'];

/*
 * A single roster model plus the provider entry selected as its primary. The
 * runtime races across ALL enabled providers of the model, so the provider
 * entry is carried for tracing/cost and for the winner bookkeeping; the race
 * itself fans out over `providers`.
 */
export interface RosterProviderRef {
  provider: RosterProvider;
  modelId: string;
  inputPrice?: number;
  outputPrice?: number;
  ttftMs?: number;
  ttftSamples?: number;
  disabledUntil?: Date | null;
}

export interface RosterModel {
  modelId: string;
  label: string;
  tools: boolean;
  vision: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  providers: RosterProviderRef[];
}

/*
 * Seed definition (owner-locked roster, verified live 2026-10-08). Kept here
 * as the single source of truth for both the migration and empty-collection
 * recovery, mirroring the SEED_ENTRIES discipline of `modelConfigService`.
 *
 * Constraints recorded in #232: every model >120B total params, serverless on
 * BOTH providers. MiniMax M3 is text-only on Fireworks
 * (`supports_image_input: false`), so it is excluded from image turns.
 */
export const ROSTER_SEED: RosterModel[] = [
  {
    modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    label: 'DeepSeek V4.1 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.2,
    outputPrice: 0.6,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
        inputPrice: 0.2,
        outputPrice: 0.6,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
        inputPrice: 0.3,
        outputPrice: 1.2,
      },
    ],
  },
  {
    modelId: 'zai-org/GLM-5.3-Flash',
    label: 'GLM 5.3 Flash',
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.15,
    outputPrice: 0.5,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'zai-org/GLM-5.3-Flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/glm-5p3-flash',
        inputPrice: 0.15,
        outputPrice: 0.5,
      },
    ],
  },
  {
    modelId: 'MiniMaxAI/MiniMax-M3',
    label: 'MiniMax M3',
    tools: true,
    // Text-only: Fireworks reports supports_image_input false; the
    // conservative reading excludes it from image turns (owner decision).
    vision: false,
    contextLength: 524288,
    inputPrice: 0.28,
    outputPrice: 1.1,
    providers: [
      {
        provider: 'deepinfra',
        modelId: 'MiniMaxAI/MiniMax-M3',
        inputPrice: 0.28,
        outputPrice: 1.1,
      },
      {
        provider: 'fireworks',
        modelId: 'accounts/fireworks/models/minimax-m3',
        inputPrice: 0.3,
        outputPrice: 1.2,
      },
    ],
  },
];

/*
 * Summed routing price for a ref, or `undefined` when either component is
 * missing (#199). Unknown is deliberately distinct from 0: a half-priced model
 * is not treated as cheap. Moved here with the roster (#233); the tier-era
 * config service that used to own it is gone. Non-finite components also read
 * as unknown so a `NaN` can never slip past a comparison.
 */
export const routingPrice = (ref: {
  inputPrice?: number;
  outputPrice?: number;
}): number | undefined => {
  const { inputPrice, outputPrice } = ref;
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return undefined;
  return (inputPrice as number) + (outputPrice as number);
};

/* ----------------------------------------------------------------------------
 * Weighted score (owner decision OQ3): score = f(TTFT) * price penalty.
 * Lower is better. Env-tunable so the relative influence can be measured
 * before it is fixed (TTFT and price are not reliably inverse — provider load
 * dominates TTFT far more than parameter count).
 * ------------------------------------------------------------------------- */

/*
 * Neutral TTFT used when a provider has no observation yet: the roster is
 * raced from the first turn, and an unpriced/unmeasured provider must be
 * neither starved nor favoured. Default 1000ms — roughly a mid-range
 * first-token latency for these frontier Flash models.
 */
export const defaultTtftMs = (): number => {
  const raw = process.env.ROSTER_DEFAULT_TTFT_MS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
};

/*
 * Price-penalty slope `k` in `penalty = 1 + k * price`. The summed (in+out)
 * price is in USD/1Mtok; with a small `k` (default 0.1) a price difference of
 * $1/mtok shifts the score by 10% of TTFT, so price breaks near-ties without
 * overwhelming a genuine latency gap. Env-tunable.
 */
export const pricePenaltyK = (): number => {
  const raw = process.env.ROSTER_PRICE_PENALTY_K;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.1;
};

export interface RosterScoreInput {
  ttftMs?: number;
  inputPrice?: number;
  outputPrice?: number;
}

/*
 * Weighted score for one roster model: `f(TTFT) * (1 + k * price)`. Missing
 * TTFT uses the neutral default; missing/partial price uses a neutral price of
 * 0 (penalty 1), so an unmeasured model is scored purely on latency and is
 * neither penalised nor advantaged for unknown price (mirrors #199's
 * "unknown ≠ free" stance: it is simply not a differentiator).
 */
export const rosterScore = (input: RosterScoreInput): number => {
  const ttft =
    Number.isFinite(input.ttftMs) && (input.ttftMs as number) >= 0
      ? (input.ttftMs as number)
      : defaultTtftMs();
  const price = routingPrice(input) ?? 0;
  return ttft * (1 + pricePenaltyK() * price);
};

/*
 * The best TTFT observed across a model's enabled providers — the latency
 * signal that matters for the primary pick (the race will use the fastest
 * healthy backend anyway, so the model's effective latency is its best one).
 */
const bestTtft = (model: RosterModel): number | undefined => {
  const values = model.providers
    .filter((p) => p.ttftMs !== undefined && Number.isFinite(p.ttftMs))
    .map((p) => p.ttftMs as number);
  return values.length ? Math.min(...values) : undefined;
};

/*
 * Pick the primary model by the weighted score over last-known TTFT and price
 * (owner decision). Ties keep roster order (stable) — the seed order is the
 * owner's preference ranking.
 */
export const pickPrimary = (models: RosterModel[]): RosterModel | null => {
  if (models.length === 0) return null;
  let best = models[0];
  let bestScore = rosterScore({
    ttftMs: bestTtft(best),
    inputPrice: best.inputPrice,
    outputPrice: best.outputPrice,
  });
  for (const model of models.slice(1)) {
    const score = rosterScore({
      ttftMs: bestTtft(model),
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
    });
    if (score < bestScore) {
      best = model;
      bestScore = score;
    }
  }
  return best;
};

/* ----------------------------------------------------------------------------
 * Reads / writes
 * ------------------------------------------------------------------------- */

const isCoolingOff = (entry: RosterProviderRef, now: Date): boolean =>
  entry.disabledUntil instanceof Date && entry.disabledUntil.getTime() > now.getTime();

interface RosterDoc {
  modelId: string;
  label: string;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  eligible?: boolean;
  providers?: Array<{
    provider: RosterProvider;
    modelId: string;
    enabled?: boolean;
    inputPrice?: number;
    outputPrice?: number;
    ttftMs?: number;
    ttftSamples?: number;
    disabledUntil?: Date | null;
  }>;
}

const toRosterModel = (doc: RosterDoc): RosterModel => ({
  modelId: doc.modelId,
  label: doc.label,
  tools: doc.tools !== false,
  vision: doc.vision === true,
  ...(doc.contextLength !== undefined ? { contextLength: doc.contextLength } : {}),
  ...(doc.inputPrice !== undefined ? { inputPrice: doc.inputPrice } : {}),
  ...(doc.outputPrice !== undefined ? { outputPrice: doc.outputPrice } : {}),
  providers: (doc.providers ?? []).map((p) => ({
    provider: p.provider,
    modelId: p.modelId,
    ...(p.inputPrice !== undefined ? { inputPrice: p.inputPrice } : {}),
    ...(p.outputPrice !== undefined ? { outputPrice: p.outputPrice } : {}),
    ...(p.ttftMs !== undefined ? { ttftMs: p.ttftMs } : {}),
    ...(p.ttftSamples !== undefined ? { ttftSamples: p.ttftSamples } : {}),
    disabledUntil: p.disabledUntil ?? null,
  })),
});

const ensureSeed = async (): Promise<void> => {
  await Promise.all(
    ROSTER_SEED.map((model) =>
      ModelRoster.updateOne(
        { modelId: model.modelId },
        {
          $setOnInsert: {
            modelId: model.modelId,
            label: model.label,
            tools: model.tools,
            vision: model.vision,
            ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
            ...(model.inputPrice !== undefined ? { inputPrice: model.inputPrice } : {}),
            ...(model.outputPrice !== undefined ? { outputPrice: model.outputPrice } : {}),
            eligible: true,
            providers: model.providers.map((p) => ({
              provider: p.provider,
              modelId: p.modelId,
              enabled: true,
              ...(p.inputPrice !== undefined ? { inputPrice: p.inputPrice } : {}),
              ...(p.outputPrice !== undefined ? { outputPrice: p.outputPrice } : {}),
              disabledUntil: null,
            })),
          },
        },
        { upsert: true },
      ),
    ),
  );
};

/*
 * Read the eligible roster, ordered as seeded (the seed order is the owner's
 * preference ranking; ties in the weighted score keep it). A DB read failure
 * falls back to the seed definition so a broken config read never takes chat
 * down; an EMPTY collection is seeded first (empty-pool recovery, mirroring
 * `listByTier`).
 */
export const listRoster = async (): Promise<RosterModel[]> => {
  try {
    let docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
    if (docs.length === 0) {
      await ensureSeed();
      docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
      if (docs.length === 0) return ROSTER_SEED;
    }
    // Preserve seed order: the collection is queried unordered, so sort by the
    // seed index. Unknown rows (admin-added) land after the known ones.
    const order = new Map(ROSTER_SEED.map((m, i) => [m.modelId, i]));
    docs.sort((a, b) => (order.get(a.modelId) ?? 99) - (order.get(b.modelId) ?? 99));
    return docs.map(toRosterModel);
  } catch (err) {
    console.error('ModelRoster read/seed error:', err);
    return ROSTER_SEED;
  }
};

/*
 * The enabled, non-cooling-off providers of a model — the set the runtime
 * actually races. `hasImage` restricts to vision-capable models upstream (see
 * `rosterModelsForTurn`), but a provider entry may still be cooling off.
 */
export const liveProviders = (model: RosterModel, now: Date = new Date()): RosterProviderRef[] =>
  model.providers.filter((p) => !isCoolingOff(p, now));

/*
 * Roster candidates for a turn: eligible models that still have at least one
 * live provider. Image turns keep only `vision: true` models (MiniMax M3 is
 * text-only and is excluded). The weighted primary is picked from these.
 */
export const rosterModelsForTurn = (
  roster: RosterModel[],
  hasImage: boolean,
  now: Date = new Date(),
): RosterModel[] =>
  roster
    .filter((model) => (hasImage ? model.vision : true))
    .map((model) => ({ ...model, providers: liveProviders(model, now) }))
    .filter((model) => model.providers.length > 0);

/*
 * Record a winning TTFT observation as a rolling mean. The Mongo pipeline
 * update keeps the mean in the database (no read-modify-write race between
 * concurrent turns): newMean = (oldMean*oldSamples + ttft) / (oldSamples + 1).
 * A provider entry with no prior samples treats the old mean as 0 and old
 * samples as 0, so the first observation is exact.
 */
export const recordTtft = async (
  modelId: string,
  provider: RosterProvider,
  ttftMs: number,
): Promise<void> => {
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return;
  try {
    await ModelRoster.updateOne({ modelId, 'providers.provider': provider }, [
      {
        $set: {
          providers: {
            $map: {
              input: '$providers',
              as: 'p',
              in: {
                $cond: [
                  { $eq: ['$$p.provider', provider] },
                  {
                    $mergeObjects: [
                      '$$p',
                      {
                        ttftMs: {
                          $divide: [
                            {
                              $add: [
                                {
                                  $multiply: [
                                    { $ifNull: ['$$p.ttftMs', 0] },
                                    { $ifNull: ['$$p.ttftSamples', 0] },
                                  ],
                                },
                                ttftMs,
                              ],
                            },
                            { $add: [{ $ifNull: ['$$p.ttftSamples', 0] }, 1] },
                          ],
                        },
                        ttftSamples: { $add: [{ $ifNull: ['$$p.ttftSamples', 0] }, 1] },
                        ttftUpdatedAt: '$$NOW',
                        disabledUntil: null,
                      },
                    ],
                  },
                  '$$p',
                ],
              },
            },
          },
        },
      },
    ]);
  } catch (err) {
    // A metrics write must never fail the turn.
    console.error('ModelRoster TTFT write error:', err);
  }
};

/*
 * Per-provider cool-off, mirroring `disableModel` (#168/#213): `ttlMs`
 * overrides the default 6h for endpoint overload (#213 short TTL). Errors are
 * logged, not thrown — the cool-off rides alongside a real failure.
 */
const coolOffHours = (): number => {
  const raw = process.env.MODEL_COOL_OFF_HOURS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
};

export const disableRosterProvider = async (
  modelId: string,
  provider: RosterProvider,
  ttlMs?: number,
): Promise<boolean> => {
  try {
    const duration = ttlMs ?? coolOffHours() * 60 * 60 * 1000;
    await ModelRoster.updateOne(
      { modelId, 'providers.provider': provider },
      {
        $set: {
          'providers.$[p].disabledUntil': new Date(Date.now() + duration),
        },
      },
      { arrayFilters: [{ 'p.provider': provider }] },
    );
    return true;
  } catch (err) {
    console.error('ModelRoster cool-off write error:', err);
    return false;
  }
};
