import { ProviderRouting } from '../models/ProviderRouting';

export type ModelTier = 'small' | 'large' | 'guard';

export type ProviderName = 'groq' | 'deepinfra';

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

/*
 * Defaults come from the same envs the router uses today, so a deployment
 * with no DB config seeds exactly today's behaviour. DeepInfra entries:
 * `google/gemma-3-4b-it` was verified in the plan-17 model-eval pass; other
 * DeepInfra identities are provisional seed data, editable in the DB.
 */
interface SeedEntry extends ModelRef {
  tier: ModelTier;
  eligible: boolean;
  tools?: boolean;
  vision?: boolean;
  contextLength?: number;
}

// Single source of truth for the env var and its default per tier, shared by
// seeding and the env fallback so the two can never drift apart.
const DEFAULT_MODEL_ENV: Record<ModelTier, [envVar: string, fallback: string]> = {
  small: ['ROUTER_SMALL_MODEL', 'openai/gpt-oss-20b'],
  large: ['ROUTER_LARGE_MODEL', 'openai/gpt-oss-120b'],
  guard: ['ROUTER_GUARD_MODEL', 'allam-2-7b'],
};

const envModel = ([envVar, fallback]: readonly [string, string]): string =>
  process.env[envVar] || fallback;

// Read at seed time (not module load) so env overrides set per-process are
// honoured when the collection is first populated.
const SEED_ENTRIES = (): SeedEntry[] => [
  { provider: 'groq', model: envModel(DEFAULT_MODEL_ENV.small), tier: 'small', eligible: true },
  { provider: 'groq', model: envModel(DEFAULT_MODEL_ENV.large), tier: 'large', eligible: true },
  { provider: 'groq', model: envModel(DEFAULT_MODEL_ENV.guard), tier: 'guard', eligible: true },
  {
    provider: 'deepinfra',
    model: 'google/gemma-3-4b-it',
    tier: 'small',
    eligible: true,
    vision: true,
  },
  { provider: 'deepinfra', model: 'Qwen/Qwen2.5-72B-Instruct', tier: 'large', eligible: true },
];

const ensureSeed = async (): Promise<void> => {
  await Promise.all(
    SEED_ENTRIES().map(({ provider, model, tier, eligible, ...capabilities }) =>
      ProviderRouting.updateOne(
        { provider, model, tier },
        { $setOnInsert: { eligible, ...capabilities } },
        {
          upsert: true,
        },
      ),
    ),
  );
};

const fromEnv = (tier: ModelTier): ModelRef[] => [
  { provider: 'groq', model: envModel(DEFAULT_MODEL_ENV[tier]) },
];

/*
 * Seed on first read; idempotent upserts keep concurrent/multi-call seeding
 * safe. Falls back to the env-configured default model for the tier if the
 * collection stays empty (e.g. with the seeding disabled in tests).
 */
export const listByTier = async (tier: ModelTier): Promise<ModelRef[]> => {
  const read = async () =>
    (await ProviderRouting.find({ tier, eligible: true }).lean()) as Array<{
      provider: ProviderName;
      model: string;
    }>;

  let entries: Awaited<ReturnType<typeof read>>;
  try {
    entries = await read();
    if (entries.length === 0) {
      await ensureSeed();
      entries = await read();
    }
  } catch (err) {
    console.error('ProviderRouting config read/seed error:', err);
    return fromEnv(tier);
  }
  if (entries.length === 0) return fromEnv(tier);
  return entries.map(({ provider, model }) => ({ provider, model }));
};
