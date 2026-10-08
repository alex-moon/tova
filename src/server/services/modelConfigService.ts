import { ROSTER_SEED, type RosterProvider } from './rosterConfig';

/*
 * #233: this module is the tier-free remnant of the tier-era config service.
 * The tier machinery (`ModelTier`, `SEED_ENTRIES`, `listByTier`,
 * `completionsPoolFor`, env defaults, `ensureSeed`) is deleted with the tier
 * router (#232/#233); routing now resolves from the model roster
 * (`rosterConfig.ts` / `ModelRoster`).
 *
 * What survives is provider-level plumbing still shared by the racing runtime
 * and the app: provider names, the loud all-disabled error, and the overload
 * cool-off TTL. The eval sweep bridge reads the roster seed (importing only
 * from `rosterConfig`, which does not import back — no cycle).
 */

export type ProviderName = 'groq' | 'deepinfra' | 'fireworks' | 'typesafe';

/*
 * #168: thrown when every model that could serve a request is cooling off. The
 * racing runtime surfaces an all-models-unavailable turn with this message so
 * the end-user text stays actionable.
 */
export const ALL_MODELS_DISABLED_MESSAGE =
  'All models are temporarily unavailable after failures — they cool off for a few hours and are retried automatically. Please try again later.';

export class AllModelsDisabledError extends Error {
  constructor() {
    super(ALL_MODELS_DISABLED_MESSAGE);
    this.name = 'AllModelsDisabledError';
  }
}

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
 * #233 bridge: the eval sweep universe (#158) now seeds from the model roster
 * rather than the deleted tier `SEED_ENTRIES`. Returning `{ provider, model }`
 * rows keeps `evalRunService`'s `--models all` path working; #236 ("evals
 * sweep the fixed roster") owns extending it to the actual roster universe.
 */
export interface SweepModelRef {
  provider: RosterProvider;
  model: string;
}

export const sweepModels = (providers?: RosterProvider[]): SweepModelRef[] => {
  const allow = providers && new Set(providers);
  const seen = new Set<string>();
  const models: SweepModelRef[] = [];
  for (const model of ROSTER_SEED) {
    for (const providerRef of model.providers) {
      if (allow && !allow.has(providerRef.provider)) continue;
      const key = `${providerRef.provider}:${providerRef.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ provider: providerRef.provider, model: providerRef.modelId });
    }
  }
  return models;
};
