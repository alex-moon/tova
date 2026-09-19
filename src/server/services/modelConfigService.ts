import { ProviderRouting } from '../models/ProviderRouting';

export type ModelTier = 'small' | 'large';

export type ProviderName = 'groq' | 'deepinfra';

/*
 * Capabilities tracked per `providerroutings` row (#94): `tools` and `vision`
 * mirror the schema flags, `contextLength` the advertised token limit.
 * `undefined` in a required capability means "not required".
 */
export interface ModelCapabilities {
  tools?: boolean;
  vision?: boolean;
}

export interface ModelRef extends ModelCapabilities {
  provider: ProviderName;
  model: string;
}

/*
 * Completions always run tool-carrying (web_search / asset tools / MCP
 * toolsets attach since #52, key-less `current_datetime` included), so the
 * completion pools are resolved with `tools: true` — a row flagged
 * `tools: false` is ruled out deterministically. Guard/classifier/title/
 * followups run tool-free via `createToolFreeCompletion` and resolve pools
 * without capabilities.
 */
interface SeedEntry extends ModelRef {
  tier: ModelTier;
  eligible: boolean;
  contextLength?: number;
}

// Single source of truth for the env var and its default per tier, shared by
// seeding and the env fallback so the two can never drift apart. Completion
// tiers default to DeepInfra (#94: Groq is never used for completions — free
// tier token limits mean tool use would never work).
const DEFAULT_MODEL_ENV: Record<ModelTier, [envVar: string, fallback: string]> = {
  small: ['ROUTER_SMALL_MODEL', 'openai/gpt-oss-20b'],
  large: ['ROUTER_LARGE_MODEL', 'openai/gpt-oss-120b'],
};

const envModel = ([envVar, fallback]: readonly [string, string]): string =>
  process.env[envVar] || fallback;

/*
 * Read at seed time (not module load) so env overrides set per-process are
 * honoured when the collection is first populated. Env overrides are seeded
 * as DeepInfra refs: `ROUTER_SMALL_MODEL`/`ROUTER_LARGE_MODEL` must name
 * DeepInfra models (completions never regress to Groq, #94).
 */
const SEED_ENTRIES = (): SeedEntry[] => [
  {
    provider: 'deepinfra',
    model: envModel(DEFAULT_MODEL_ENV.small),
    tier: 'small',
    eligible: true,
    tools: true,
    contextLength: 131072,
  },
  {
    provider: 'deepinfra',
    model: 'google/gemma-3-4b-it',
    tier: 'small',
    eligible: true,
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
  {
    provider: 'deepinfra',
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
];

/*
 * `$setOnInsert` documents must never carry `undefined` keys: the MongoDB
 * driver serialises those as `null`, which would clobber the schema defaults
 * for such rows on first insert and covertly rule them out of tool pools.
 */
const seedDocFrom = ({ eligible, tools, vision, contextLength }: SeedEntry) => {
  const doc: { eligible: boolean; tools?: boolean; vision?: boolean; contextLength?: number } = {
    eligible,
  };
  if (tools !== undefined) doc.tools = tools;
  if (vision !== undefined) doc.vision = vision;
  if (contextLength !== undefined) doc.contextLength = contextLength;
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
 * pools through migrations (`remove-groq-completions-routings` for the
 * completion tiers, then `remove-guard-groq-routings` for the guard tier and
 * every remaining Groq row) — advertently not silently at runtime.
 */
const fromEnv = (tier: ModelTier): ModelRef => ({
  provider: 'deepinfra',
  model: envModel(DEFAULT_MODEL_ENV[tier]),
});

/*
 * Reads a tier's eligible rows ordered `provider, model` (post-seed shape is
 * stable because seeds write in that order). Rows are returned with their
 * capability fields so callers can apply `requiredCapabilities` matching.
 */
const readRows = async (tier: ModelTier) =>
  (await ProviderRouting.find({ tier, eligible: true })
    .sort({ provider: 1, model: 1 })
    .lean()) as Array<{
    provider: ProviderName;
    model: string;
    tools?: boolean;
    vision?: boolean;
    contextLength?: number;
  }>;

/*
 * A row satisfies required capabilities under the schema semantics:
 * `tools` defaults to true — a row without the field is tool-capable, only
 * an explicit `tools: false` rules it out; `vision` defaults to false — a
 * vision requirement is only met when the row is explicitly `vision: true`.
 */
const rowMeetsCapabilities = (
  row: { tools?: boolean; vision?: boolean },
  caps: ModelCapabilities,
) =>
  (caps.tools === undefined || caps.tools === false || row.tools !== false) &&
  (caps.vision === undefined || caps.vision === false || row.vision === true);

/*
 * Seed on first read; idempotent upserts keep concurrent/multi-call seeding
 * safe. Falls back to the tier's env-configured model if the DB is unusable
 * or the tier has no eligible rows (e.g. with the seeding disabled in tests).
 *
 * `requiredCapabilities` filters the resolved rows (capability matching for
 * completions, #94). An empty filter outcome is NOT a fallback: the caller
 * gets `[]` and fails loudly — silently completing with a degenerate env
 * model would defeat the rule-out logic.
 */
export const listByTier = async (
  tier: ModelTier,
  requiredCapabilities?: ModelCapabilities,
): Promise<ModelRef[]> => {
  try {
    let rows = await readRows(tier);
    if (rows.length === 0) {
      await ensureSeed();
      rows = await readRows(tier);
      if (rows.length === 0) return [fromEnv(tier)];
    }
    const filtered = requiredCapabilities
      ? rows.filter((row) => rowMeetsCapabilities(row, requiredCapabilities))
      : rows;
    return filtered.map(({ provider, model, tools, vision, contextLength }) => ({
      provider,
      model,
      ...(tools !== undefined ? { tools } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(contextLength !== undefined ? { contextLength } : {}),
    }));
  } catch (err) {
    console.error('ProviderRouting config read/seed error:', err);
    return [fromEnv(tier)];
  }
};

/*
 * Completions-tier helper: pools with the tools requirement pre-applied, so
 * the router can never route a completion to a tool-incapable model.
 */
export const completionsPoolFor = async (tier: 'small' | 'large'): Promise<ModelRef[]> =>
  listByTier(tier, { tools: true });
