import { ModelRoster } from '../models/ModelRoster';

/* The fixed model roster and its weighted primary pick: the routing data layer for the racing runtime. */
// @see #232 #233

/** Every provider the racing path can talk to. */
export type RosterProvider = 'deepinfra' | 'fireworks';

/* A roster model plus the provider entry selected as its primary; the race itself fans out over `providers`. */
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
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  providers: RosterProviderRef[];
}

/* Seed definition (owner-locked roster): every model >120B params, serverless on BOTH providers; dropped models stay out of recovery paths. */
// @see #232 #316
export const ROSTER_SEED: RosterModel[] = [
  {
    modelId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    label: 'DeepSeek V4.1 Flash',
    tools: true,
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
];

/* Summed routing price for a ref, or undefined when either component is missing (unknown ≠ 0); non-finite reads as unknown. */
// @see #199 #233
export const routingPrice = (ref: {
  inputPrice?: number;
  outputPrice?: number;
}): number | undefined => {
  const { inputPrice, outputPrice } = ref;
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return undefined;
  return (inputPrice as number) + (outputPrice as number);
};

/* Weighted score (lower is better): score = f(TTFT) * price penalty; env-tunable so the influence can be measured before it is fixed. */

/* Neutral TTFT for a provider with no observation yet: neither starved nor favoured. */
export const defaultTtftMs = (): number => {
  const raw = process.env.ROSTER_DEFAULT_TTFT_MS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
};

/* Price-penalty slope `k` in `penalty = 1 + k * price`: price breaks near-ties without overwhelming a genuine latency gap. */
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

/* Weighted score for one roster model; unknown price is neutral (penalty 1), not a differentiator. */
// @see #199
export const rosterScore = (input: RosterScoreInput): number => {
  const ttft =
    Number.isFinite(input.ttftMs) && (input.ttftMs as number) >= 0
      ? (input.ttftMs as number)
      : defaultTtftMs();
  const price = routingPrice(input) ?? 0;
  return ttft * (1 + pricePenaltyK() * price);
};

/* The best TTFT across a model's enabled providers — a model's effective latency is its fastest healthy backend. */
const bestTtft = (model: RosterModel): number | undefined => {
  const values = model.providers
    .filter((p) => p.ttftMs !== undefined && Number.isFinite(p.ttftMs))
    .map((p) => p.ttftMs as number);
  return values.length ? Math.min(...values) : undefined;
};

/* Pick the primary model by weighted score; ties keep roster order (the seed order is the owner's preference ranking). */
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

const isCoolingOff = (entry: RosterProviderRef, now: Date): boolean =>
  entry.disabledUntil instanceof Date && entry.disabledUntil.getTime() > now.getTime();

interface RosterDoc {
  modelId: string;
  label: string;
  tools?: boolean;
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

/* Read the eligible roster in seed order; a DB failure falls back to the seed, an empty collection is seeded first. */
export const listRoster = async (): Promise<RosterModel[]> => {
  try {
    let docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
    if (docs.length === 0) {
      await ensureSeed();
      docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
      if (docs.length === 0) return ROSTER_SEED;
    }
    // Preserve seed order: sort by seed index; admin-added rows land after the known ones.
    const order = new Map(ROSTER_SEED.map((m, i) => [m.modelId, i]));
    docs.sort((a, b) => (order.get(a.modelId) ?? 99) - (order.get(b.modelId) ?? 99));
    return docs.map(toRosterModel);
  } catch (err) {
    console.error('ModelRoster read/seed error:', err);
    return ROSTER_SEED;
  }
};

/* The enabled, non-cooling-off providers of a model — the set the runtime actually races. */
export const liveProviders = (model: RosterModel, now: Date = new Date()): RosterProviderRef[] =>
  model.providers.filter((p) => !isCoolingOff(p, now));

/* Roster candidates for a turn: eligible models with at least one live provider; no vision gate remains. */
// @see #316
export const rosterModelsForTurn = (roster: RosterModel[], now: Date = new Date()): RosterModel[] =>
  roster
    .map((model) => ({ ...model, providers: liveProviders(model, now) }))
    .filter((model) => model.providers.length > 0);

/* Record a winning TTFT as a windowed mean via a single Mongo pipeline update (no read-modify-write race); TTFT is load-dominated, so the mean must track RECENT latency. */
// @see #320
const windowSize = (): number => {
  const raw = process.env.ROSTER_TTFT_WINDOW;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isInteger(parsed) && (parsed as number) >= 1 ? (parsed as number) : 20;
};

export const recordTtft = async (
  modelId: string,
  provider: RosterProvider,
  ttftMs: number,
): Promise<void> => {
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return;
  try {
    const window = windowSize();
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
                                    // Cap the old mean's weight so the oldest observation decays out one sample at a time.
                                    { $min: [{ $ifNull: ['$$p.ttftSamples', 0] }, window - 1] },
                                  ],
                                },
                                ttftMs,
                              ],
                            },
                            {
                              $add: [
                                { $min: [{ $ifNull: ['$$p.ttftSamples', 0] }, window - 1] },
                                1,
                              ],
                            },
                          ],
                        },
                        ttftSamples: {
                          $add: [{ $min: [{ $ifNull: ['$$p.ttftSamples', 0] }, window - 1] }, 1],
                        },
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

/* Per-provider cool-off; `ttlMs` overrides the default 6h for endpoint overload. Errors are logged, not thrown. */
// @see #213
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
