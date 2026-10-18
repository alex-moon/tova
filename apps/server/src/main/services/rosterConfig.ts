import { ModelRoster } from '../models/ModelRoster';

/* Fixed model roster + weighted primary pick; routing data layer. */
// @see #232 #233

/** Every provider the racing path can talk to. */
export type RosterProvider = 'deepinfra' | 'fireworks';

/* A roster model plus its selected primary; the race fans over providers. */
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

/* Owner-locked seed: every model >120B params, on BOTH providers. */
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

/* Summed routing price; undefined when either side is missing. */
// @see #199 #233
export const routingPrice = (ref: {
  inputPrice?: number;
  outputPrice?: number;
}): number | undefined => {
  const { inputPrice, outputPrice } = ref;
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return undefined;
  return (inputPrice as number) + (outputPrice as number);
};

/* Weighted score (lower is better): TTFT * price penalty. */

/* Neutral TTFT with no observation yet: neither starved nor favoured. */
export const defaultTtftMs = (): number => {
  const raw = process.env.ROSTER_DEFAULT_TTFT_MS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
};

/* Price-penalty slope k: price breaks near-ties, not latency gaps. */
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

/* Weighted score; unknown price is neutral (penalty 1). */
// @see #199
export const rosterScore = (input: RosterScoreInput): number => {
  const ttft =
    Number.isFinite(input.ttftMs) && (input.ttftMs as number) >= 0
      ? (input.ttftMs as number)
      : defaultTtftMs();
  const price = routingPrice(input) ?? 0;
  return ttft * (1 + pricePenaltyK() * price);
};

/* Best TTFT across providers: latency is the fastest backend. */
const bestTtft = (model: RosterModel): number | undefined => {
  const values = model.providers
    .filter((p) => p.ttftMs !== undefined && Number.isFinite(p.ttftMs))
    .map((p) => p.ttftMs as number);
  return values.length ? Math.min(...values) : undefined;
};

/* Pick primary by weighted score; ties keep roster (seed) order. */
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

/* Eligible roster in seed order; DB failure falls back to the seed. */
export const listRoster = async (): Promise<RosterModel[]> => {
  try {
    let docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
    if (docs.length === 0) {
      await ensureSeed();
      docs = (await ModelRoster.find({ eligible: true }).lean()) as unknown as RosterDoc[];
      if (docs.length === 0) return ROSTER_SEED;
    }
    // Preserve seed order: sort by seed index; admin rows land last.
    const order = new Map(ROSTER_SEED.map((m, i) => [m.modelId, i]));
    docs.sort((a, b) => (order.get(a.modelId) ?? 99) - (order.get(b.modelId) ?? 99));
    return docs.map(toRosterModel);
  } catch (err) {
    console.error('ModelRoster read/seed error:', err);
    return ROSTER_SEED;
  }
};

/* Enabled, non-cooling-off providers — the set the runtime races. */
export const liveProviders = (model: RosterModel, now: Date = new Date()): RosterProviderRef[] =>
  model.providers.filter((p) => !isCoolingOff(p, now));

/* Turn candidates: eligible models with at least one live provider. */
// @see #316
export const rosterModelsForTurn = (roster: RosterModel[], now: Date = new Date()): RosterModel[] =>
  roster
    .map((model) => ({ ...model, providers: liveProviders(model, now) }))
    .filter((model) => model.providers.length > 0);

/* Winning TTFT as a windowed mean via one pipeline update (no RMW race). */
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
                                    // Cap the old mean's weight (decay).
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

/* Per-provider cool-off; ttlMs overrides the default 6h. */
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
