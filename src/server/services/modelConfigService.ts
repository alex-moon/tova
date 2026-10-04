import { ProviderRouting } from '../models/ProviderRouting';

export type ModelTier = 'small' | 'large' | 'guard';

export type ProviderName = 'groq' | 'deepinfra' | 'typesafe';

/*
 * Capabilities tracked per `providerroutings` row (#94): `tools` and `vision`
 * mirror the schema flags, `contextLength` the advertised token limit.
 * `undefined` in a required capability means "not required".
 */
export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
}

/*
 * `provider` is not a capability but a hard exclusion (#94, #117): completions
 * may never run on Groq, so a completion-pool filter pins the provider
 * regardless of what stale rows exist in the collection.
 */
export interface ModelFilter extends ModelCapabilities {
  provider?: ProviderName;
}

/*
 * #168: thrown when a tier's pool for the requested filter has rows, but
 * every one of them is cooling off. This is deliberately a throw rather than
 * an envFallback-sized empty result: `completionsPoolFor` pins the provider,
 * so "config exists" and "all cooling off" are only distinguishable here —
 * and silently routing a full outage to the single env model would defeat
 * both the cool-off and the end-user-visible empty-pool error.
 */
export const ALL_MODELS_DISABLED_MESSAGE =
  'All models are temporarily unavailable after failures — they cool off for a few hours and are retried automatically. Please try again later.';

export class AllModelsDisabledError extends Error {
  constructor() {
    super(ALL_MODELS_DISABLED_MESSAGE);
    this.name = 'AllModelsDisabledError';
  }
}

export interface ModelRef extends ModelCapabilities {
  provider: ProviderName;
  model: string;
  /*
   * Advertised context window (`providerroutings.contextLength`), carried so
   * the completion path can size its output-token budget against the routed
   * model (#104). Absent on the env fallback and on legacy rows.
   */
  contextLength?: number;
  /*
   * #199 pricing, USD per 1M tokens. Both optional: absent means "unknown"
   * (distinct from zero). `routingPrice` sums them for the cap comparison.
   */
  inputPrice?: number;
  outputPrice?: number;
}

/*
 * #199 cap: no model whose summed (in + out) price exceeds this may be
 * selected. `inputPrice + outputPrice` in USD per 1M tokens, ignoring cached
 * pricing. Env-tunable for parity with `MODEL_COOL_OFF_HOURS`; a
 * non-finite/non-positive override falls back to the ticket's literal $1.50.
 */
export const MAX_MODEL_PRICE_USD_PER_MTOK = (): number => {
  const raw = process.env.MODEL_MAX_PRICE_USD_PER_MTOK;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.5;
};

/*
 * Summed routing price for a ref, or `undefined` when either component is
 * missing. Unknown is deliberately distinct from 0: a half-priced row is not
 * treated as cheap. Callers decide unknown semantics (see #199 OQ-3).
 *
 * Non-finite components (NaN, Infinity) also read as unknown. A `NaN` sum
 * would make `sum > cap` false and silently pass an over-cap row through the
 * gate, so the helper never returns a non-finite number.
 */
export const routingPrice = (ref: {
  inputPrice?: number;
  outputPrice?: number;
}): number | undefined => {
  const { inputPrice, outputPrice } = ref;
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return undefined;
  return (inputPrice as number) + (outputPrice as number);
};

/*
 * Completions always run tool-carrying (web_search / asset tools / MCP
 * toolsets attach since #52, key-less `current_datetime` included), so the
 * completion pools are resolved with `tools: true` — a row flagged
 * `tools: false` is ruled out deterministically. Guard/classifier/title/
 * followups run tool-free via `createToolFreeCompletion` and resolve pools
 * without capabilities (Groq's free-tier limits never matter there).
 */
const GUARD_ENV: [envVar: string, fallback: string] = ['ROUTER_GUARD_MODEL', 'openai/gpt-oss-20b'];

interface SeedEntry extends ModelRef {
  tier: ModelTier;
  eligible: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
}

// Single source of truth for the env var and its default per tier, shared by
// seeding and the env fallback so the two can never drift apart. Completion
// tiers default to DeepInfra (#94: Groq is never used for completions — free
// tier token limits mean tool use would never work); the guard tier stays
// Groq, where small tool-free models have the biggest impact.
const DEFAULT_MODEL_ENV: Record<ModelTier, [envVar: string, fallback: string]> = {
  small: ['ROUTER_SMALL_MODEL', 'openai/gpt-oss-20b'],
  large: ['ROUTER_LARGE_MODEL', 'openai/gpt-oss-120b'],
  guard: GUARD_ENV,
};

const envModel = ([envVar, fallback]: readonly [string, string]): string =>
  process.env[envVar] || fallback;

const TIER_PROVIDER: Record<ModelTier, ProviderName> = {
  small: 'deepinfra',
  large: 'deepinfra',
  guard: 'groq',
};

/*
 * Read at seed time (not module load) so env overrides set per-process are
 * honoured when the collection is first populated. Env overrides are seeded
 * with the tier's provider: `ROUTER_SMALL_MODEL`/`ROUTER_LARGE_MODEL` must
 * name DeepInfra models (completions never regress to Groq, #94), the guard
 * env names a Groq model.
 */
const SEED_ENTRIES = (): SeedEntry[] => [
  {
    provider: TIER_PROVIDER.small,
    model: envModel(DEFAULT_MODEL_ENV.small),
    tier: 'small',
    eligible: true,
    tools: true,
    contextLength: 131072,
  },
  /*
   * gemma-3-4b-it: the user vetoed it for ALL turns (#115, 2026-09-20):
   * "too small to be useful for anything at all". The row exists so the seed
   * set stays self-documenting, but `eligible: false` drops it from every
   * pool (listByTier filters eligibility); its vision capability is now
   * decorative. The up-migration matches this for upgraded deployments.
   */
  {
    provider: 'deepinfra',
    model: 'google/gemma-3-4b-it',
    tier: 'small',
    eligible: false,
    tools: true,
    vision: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-14B',
    tier: 'small',
    eligible: true,
    tools: true,
    contextLength: 40960,
  },
  /*
   * #115 image pool: the user routed ALL image turns through the large tier
   * (2026-09-20) and wants two vision models there to compare. Both entries
   * are live-probed on DeepInfra (accept image_url parts and tool calls).
   * Qwen3-VL-8B moved from the small tier here; DeepInfra has no 8B listing
   * — the alias is served by the Qwen3-VL-235B backend, hence the context
   * length.
   */
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-8B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
  },
  {
    provider: TIER_PROVIDER.large,
    model: envModel(DEFAULT_MODEL_ENV.large),
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 262144,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V3.2',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 163840,
  },
  {
    provider: 'deepinfra',
    model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 1048576,
  },
  /*
   * #170: DeepInfra expansion, all `tier: 'large'` (the "<70b ignored" rule
   * bars new small rows; the batch's one 70-170b model joins the large tier
   * where gpt-oss-120b already sits). ZDR is non-negotiable: per
   * docs.deepinfra.com/account/data-privacy only Google and Anthropic models
   * share data with partners — everything here is DeepInfra-served open
   * weights, zero retention. `contextLength`/`vision` come from the live
   * catalog (`/v1/openai/models`, 2026-09-26 dump); capabilities were
   * live-probed the same day — every row accepted an OpenAI-style `tools`
   * request, and every `vision: true` row an `image_url` part in the same
   * request (#115 probe convention). Nemotron-3-Super-120B probes "Model
   * busy" (429) intermittently — capacity, not capability; runtime cool-off
   * (#168) covers it. Discovery while dumping: Maverick and Qwen3-VL-8B
   * above are DELISTED from the catalog (legacy aliases still serve) —
   * retiring them is a follow-up ticket, not #170.
   */
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 1048576,
    inputPrice: 1.3,
    outputPrice: 2.6,
  },
  {
    provider: 'deepinfra',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.2,
    outputPrice: 0.6,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K3',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 2.85,
    outputPrice: 14.25,
  },
  {
    provider: 'deepinfra',
    model: 'moonshotai/Kimi-K2.6',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    inputPrice: 0.75,
    outputPrice: 3.5,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.8-2.4T-A95B',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 262144,
    inputPrice: 2,
    outputPrice: 6,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3.5-397B-A17B',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    inputPrice: 0.45,
    outputPrice: 3,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 262144,
    inputPrice: 0.2,
    outputPrice: 0.88,
  },
  {
    provider: 'deepinfra',
    model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 262144,
    inputPrice: 0.3,
    outputPrice: 1,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 1048576,
    inputPrice: 0.9,
    outputPrice: 4,
  },
  {
    provider: 'deepinfra',
    model: 'zai-org/GLM-5.3-Flash',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.15,
    outputPrice: 0.5,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 262144,
    inputPrice: 0.5,
    outputPrice: 2.2,
  },
  {
    provider: 'deepinfra',
    model: 'XiaomiMiMo/MiMo-V2.6-Pro',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 1048576,
    inputPrice: 0.435,
    outputPrice: 0.87,
  },
  {
    provider: 'deepinfra',
    model: 'MiniMaxAI/MiniMax-M3',
    tier: 'large',
    eligible: true,
    tools: true,
    vision: true,
    contextLength: 524288,
    inputPrice: 0.28,
    outputPrice: 1.1,
  },
  {
    provider: 'deepinfra',
    model: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
    tier: 'large',
    eligible: true,
    tools: true,
    contextLength: 262144,
    inputPrice: 0.085,
    outputPrice: 0.4,
  },
  {
    provider: 'groq',
    model: envModel(GUARD_ENV),
    tier: 'guard',
    eligible: true,
  },
];

/*
 * `$setOnInsert` documents must never carry `undefined` keys: the MongoDB
 * driver serialises those as `null`, which would clobber the schema defaults
 * for such rows on first insert and covertly rule them out of tool pools.
 */
const seedDocFrom = ({
  eligible,
  tools,
  vision,
  contextLength,
  inputPrice,
  outputPrice,
}: SeedEntry) => {
  const doc: {
    eligible: boolean;
    tools?: boolean;
    vision?: boolean;
    contextLength?: number;
    inputPrice?: number;
    outputPrice?: number;
    disabledUntil: null;
  } = {
    eligible,
    /*
     * #168: fresh seeds start not cooling off. `null` on purpose (not
     * `undefined` — see the `$setOnInsert` note below) so the field is
     * present-on-insert and read as "not cooling off" everywhere.
     */
    disabledUntil: null,
  };
  if (tools !== undefined) doc.tools = tools;
  if (vision !== undefined) doc.vision = vision;
  if (contextLength !== undefined) doc.contextLength = contextLength;
  if (inputPrice !== undefined) doc.inputPrice = inputPrice;
  if (outputPrice !== undefined) doc.outputPrice = outputPrice;
  return doc;
};

const ensureSeed = async (): Promise<void> => {
  await Promise.all(
    SEED_ENTRIES().map((entry) => {
      const { provider, model, tier } = entry;
      return ProviderRouting.updateOne(
        { provider, model, tier },
        { $setOnInsert: seedDocFrom(entry) },
        {
          upsert: true,
        },
      );
    }),
  );
};

/*
 * Seeding stays an empty-pool recovery (per-process memos would fight test
 * and multi-worker workflows); upgrades get the new DeepInfra completion
 * pools through a migration (`remove-groq-completions-routings`) that also
 * sweeps the stale Groq rows — advertently not silently at runtime.
 */
const fromEnv = (tier: ModelTier): ModelRef => ({
  provider: TIER_PROVIDER[tier],
  model: envModel(DEFAULT_MODEL_ENV[tier]),
});

/*
 * #168 cool-off, applied lazily: a row whose `disabledUntil` is still in
 * the future is cooling off; an expired (or missing/null) timestamp reads
 * as "not disabled", so no timers are needed. Filtering happens in
 * `listByTier` (which needs to distinguish "no rows" from "all cooling
 * off"), not in `readRows`.
 */
const isCoolingOff = (row: ProviderPoolRow, now: Date): boolean =>
  row.disabledUntil instanceof Date && row.disabledUntil.getTime() > now.getTime();

/*
 * Reads a tier's eligible rows ordered `provider, model` (post-seed shape is
 * stable because seeds write in that order). Rows are returned with their
 * capability fields so callers can apply `requiredCapabilities` matching.
 */
const readRows = async (tier: ModelTier): Promise<Array<ProviderPoolRow>> =>
  (await ProviderRouting.find({ tier, eligible: true })
    .sort({ provider: 1, model: 1 })
    .lean()) as Array<ProviderPoolRow>;

interface ProviderPoolRow {
  provider: ProviderName;
  model: string;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
  inputPrice?: number;
  outputPrice?: number;
  disabledUntil?: Date | null;
}

/*
 * A row satisfies required capabilities under the schema semantics:
 * `tools` defaults to true — a row without the field is tool-capable, only
 * an explicit `tools: false` rules it out; `vision` defaults to false — a
 * vision requirement is only met when the row is explicitly `vision: true`.
 */
const rowMeetsFilter = (
  row: { provider: ProviderName; tools?: boolean; vision?: boolean },
  filter: ModelFilter,
) =>
  (filter.provider === undefined || row.provider === filter.provider) &&
  (filter.tools === undefined || filter.tools === false || row.tools !== false) &&
  (filter.vision === undefined || filter.vision === false || row.vision === true);

/*
 * #199 hard cap: a row whose summed (in + out) price EXCEEDS the cap is
 * ruled out of every pool. A row exactly at the cap stays (the ticket says
 * "no models **over** $1.50"). An unset/partial/non-finite price is
 * "unknown", not "expensive": it is admitted (excluding it would empty the
 * small tier, whose pre-#170 rows are all unpriced) and the admin table flags
 * it so it can be priced. Unknown-is-eligible is deliberate — see OQ-3.
 */
const rowWithinPriceCap = (row: { inputPrice?: number; outputPrice?: number }): boolean => {
  const price = routingPrice(row);
  return price === undefined || price <= MAX_MODEL_PRICE_USD_PER_MTOK();
};

/*
 * #168: immediately cool off a failed endpoint. Sets `disabledUntil` on every
 * routing row for the provider+model (a model can serve several tiers); the
 * pool reads above then exclude it until the timestamp expires. Duration is
 * env-tunable, default 6 hours. Returns whether the write landed: the
 * failover loops stop on `false` (re-trying the same broken endpoint against
 * an unchanged pool only adds latency) and surface the original endpoint
 * error instead. Errors are logged, not thrown — the cool-off rides alongside
 * a real failure and must not mask or duplicate it.
 */
const coolOffHours = (): number => {
  const raw = process.env.MODEL_COOL_OFF_HOURS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6;
};

/*
 * #213: endpoint overload ("Model busy, retry later" / `engine_overloaded`) is a
 * per-endpoint saturation that clears in seconds-to-minutes, unlike the 6h
 * cool-off for a genuinely broken endpoint. Overload uses its own short TTL
 * (env-tunable, default 5 minutes) so a healthy backend returns to the pool
 * quickly. Same fallback discipline as the other env knobs.
 */
export const overloadCoolOffMinutes = (): number => {
  const raw = process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
};

/*
 * `ttlMs` (optional) overrides the default 6h cool-off — #213 uses a short TTL
 * for endpoint overload. Callers that omit it keep the pre-#213 behaviour.
 */
export const disableModel = async (
  provider: ProviderName,
  model: string,
  ttlMs?: number,
): Promise<boolean> => {
  try {
    const duration = ttlMs ?? coolOffHours() * 60 * 60 * 1000;
    await ProviderRouting.updateMany(
      { provider, model },
      { disabledUntil: new Date(Date.now() + duration) },
    );
    return true;
  } catch (err) {
    console.error('ProviderRouting cool-off write error:', err);
    return false;
  }
};

/*
 * Seed on first read; idempotent upserts keep concurrent/multi-call seeding
 * safe. Three outcomes for a failing pool read (#168):
 * - DB unusable → env fallback (existing behaviour, preserved);
 * - no eligible rows for the tier even after seeding → env fallback;
 * - eligible rows exist for the requested provider but every one is cooling
 *   off → `AllModelsDisabledError`, NO env fallback: the env model is a
 *   single point that would quietly absorb 100% of the traffic and defeat
 *   both the cool-off and the loud empty-pool error.
 *
 * The cool-off check runs on the provider-filtered rows (before capability
 * matching) so the pinned `deepinfra` pools of `completionsPoolFor` still
 * report "all cooling off" when only Groq rows elsewhere in the tier stay
 * healthy. A capability rule-out on live rows is NOT a fallback: the caller
 * gets `[]` and fails loudly — silently completing with a degenerate env
 * model would defeat the rule-out logic.
 */
export const listByTier = async (
  tier: ModelTier,
  requiredFilter?: ModelFilter,
): Promise<ModelRef[]> => {
  try {
    let rows = await readRows(tier);
    if (rows.length === 0) {
      await ensureSeed();
      rows = await readRows(tier);
      if (rows.length === 0) return [fromEnv(tier)];
    }
    const now = new Date();
    const providerPin = requiredFilter?.provider;
    const providerRows =
      providerPin === undefined ? rows : rows.filter((row) => row.provider === providerPin);
    if (providerRows.length > 0 && !providerRows.some((row) => !isCoolingOff(row, now))) {
      throw new AllModelsDisabledError();
    }
    const active = rows.filter((row) => !isCoolingOff(row, now));
    /*
     * #199: the price cap is a rule-out, not a fallback — over-cap rows are
     * dropped before capability matching, and a filtered-empty pool returns
     * `[]` so callers fail loudly (same semantics as a capability rule-out).
     */
    const withinCap = active.filter((row) => rowWithinPriceCap(row));
    const filtered = requiredFilter
      ? withinCap.filter((row) => rowMeetsFilter(row, requiredFilter))
      : withinCap;
    return filtered.map(
      ({ provider, model, tools, vision, contextLength, inputPrice, outputPrice }) => ({
        provider,
        model,
        ...(tools !== undefined ? { tools } : {}),
        ...(vision !== undefined ? { vision } : {}),
        ...(contextLength !== undefined ? { contextLength } : {}),
        ...(inputPrice !== undefined ? { inputPrice } : {}),
        ...(outputPrice !== undefined ? { outputPrice } : {}),
      }),
    );
  } catch (err) {
    // Deliberate pool-exhaustion signal, not a read failure — let it escape.
    if (err instanceof AllModelsDisabledError) throw err;
    console.error('ProviderRouting config read/seed error:', err);
    return [fromEnv(tier)];
  }
};

/*
 * Completions-tier helper: pools with the tools requirement pre-applied, so
 * the router can never route a completion to a tool-incapable model. DeepInfra
 * is pinned in code (#94, #117): even a stale Groq row in the collection is
 * excluded here, so a 429'd tool-carrying completion on Groq's free tier
 * cannot recur from stale DB state.
 */
export const completionsPoolFor = async (tier: 'small' | 'large'): Promise<ModelRef[]> =>
  listByTier(tier, { tools: true, provider: 'deepinfra' });

/*
 * Enumerates the eval sweep universe (#158) WITHOUT touching Mongo: the
 * eligible seed+env rows only. DB-admin overrides on a live DB are a real
 * config source but make a sweep non-reproducible, so the seed list is the
 * declared universe; callers further restrict to providers they actually
 * have connectors wired for.
 */
export const sweepModels = (providers?: ProviderName[]): Array<ModelRef & { tier: ModelTier }> => {
  const allow = providers && new Set(providers);
  const seen = new Set<string>();
  const models: Array<ModelRef & { tier: ModelTier }> = [];
  for (const { eligible, tier, ...rest } of SEED_ENTRIES()) {
    if (!eligible) continue;
    if (allow && !allow.has(rest.provider)) continue;
    const key = `${rest.provider}:${rest.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ ...rest, tier });
  }
  return models;
};
