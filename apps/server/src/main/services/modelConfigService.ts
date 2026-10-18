import { ROSTER_SEED, type RosterProvider } from './rosterConfig';

/* Provider-level plumbing shared by the racing runtime and the app. */
// @see #233 #232

/* Thrown when every model that could serve a request is cooling off. */
// @see #168
export const ALL_MODELS_DISABLED_MESSAGE =
  'All models are temporarily unavailable after failures — they cool off for a few hours and are retried automatically. Please try again later.';

export class AllModelsDisabledError extends Error {
  constructor() {
    super(ALL_MODELS_DISABLED_MESSAGE);
    this.name = 'AllModelsDisabledError';
  }
}

/* Overload is a short saturation, unlike a broken endpoint's 6h cool-off. */
// @see #213
export const overloadCoolOffMinutes = (): number => {
  const raw = process.env.MODEL_OVERLOAD_COOL_OFF_MINUTES;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
};

/* Bridge: the eval sweep universe seeds from the model roster. */
// @see #233 #158 #236
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
