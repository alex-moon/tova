import { config } from '../config';

/* Resolve context/pricing/capabilities from provider catalogs, server-side. */
// @see #217 #232 #199

export type LookupProvider = 'deepinfra' | 'fireworks';

/* found: false is a normal outcome; errors are for transport failures. */
// @see #199
export interface ProviderModelDetails {
  provider: LookupProvider;
  model: string;
  contextLength?: number;
  // USD per 1M tokens, matching the roster's `inputPrice`/`outputPrice`.
  inputPrice?: number;
  outputPrice?: number;
  vision?: boolean;
  tools?: boolean;
  description?: string;
}

const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/v1/openai/models';

/* Fireworks' serverless catalog lives under the shared fireworks account. */
// @see #232 #234
const FIREWORKS_ACCOUNT = 'fireworks';
const FIREWORKS_MODELS_URL = `https://api.fireworks.ai/v1/accounts/${FIREWORKS_ACCOUNT}/models`;

const LOOKUP_TIMEOUT_MS = 12_000;

interface CatalogEntry {
  id?: unknown;
  metadata?: {
    description?: unknown;
    context_length?: unknown;
    pricing?: { input_tokens?: unknown; output_tokens?: unknown };
    tags?: unknown;
  };
}

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/* A chat-completion entry reports a context window AND token pricing. */
const toDetails = (entry: CatalogEntry, model: string): ProviderModelDetails | null => {
  const contextLength = asFiniteNumber(entry.metadata?.context_length);
  const inputPrice = asFiniteNumber(entry.metadata?.pricing?.input_tokens);
  const outputPrice = asFiniteNumber(entry.metadata?.pricing?.output_tokens);
  if (contextLength === undefined || inputPrice === undefined || outputPrice === undefined) {
    return null;
  }
  const tags = Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [];
  const vision = tags.some((tag) => tag === 'vision' || tag === 'vlm');
  const description =
    typeof entry.metadata?.description === 'string' ? entry.metadata.description : undefined;
  return {
    provider: 'deepinfra',
    model,
    contextLength,
    inputPrice,
    outputPrice,
    ...(vision ? { vision: true } : {}),
    // DeepInfra's catalog carries no tools flag; roster defaults tools true.
    ...(description ? { description } : {}),
  };
};

const lookupDeepInfra = async (model: string): Promise<ProviderModelDetails | null> => {
  const apiKey = config.providers.deepinfraApiKey;
  if (!apiKey) {
    throw new Error('DEEPINFRA_API_KEY is not configured — cannot look up model details');
  }
  const url = `${DEEPINFRA_MODELS_URL}?sort_by=openclaw&filter=with_meta`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`DeepInfra catalog request failed: ${message}`);
  });
  if (!response.ok) {
    throw new Error(`DeepInfra catalog returned HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const entries = Array.isArray(body?.data) ? (body.data as CatalogEntry[]) : [];
  const entry = entries.find((candidate) => candidate.id === model);
  return entry ? toDetails(entry, model) : null;
};

/* Fireworks list-models entry: name is the full id sent to the provider. */
// @see #234
interface FireworksEntry {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  contextLength?: unknown;
  supportsImageInput?: unknown;
}

/* Fireworks reports capabilities only; no window reads as not-found. */
const toFireworksDetails = (entry: FireworksEntry, model: string): ProviderModelDetails | null => {
  const contextLength = asFiniteNumber(entry.contextLength);
  if (contextLength === undefined) return null;
  const description = typeof entry.description === 'string' ? entry.description : undefined;
  return {
    provider: 'fireworks',
    model,
    contextLength,
    ...(entry.supportsImageInput === true ? { vision: true } : {}),
    ...(description ? { description } : {}),
  };
};

const lookupFireworks = async (model: string): Promise<ProviderModelDetails | null> => {
  const apiKey = config.providers.fireworksApiKey;
  if (!apiKey) {
    throw new Error('FIREWORKS_API_KEY is not configured — cannot look up model details');
  }
  const response = await fetch(FIREWORKS_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Fireworks catalog request failed: ${message}`);
  });
  if (!response.ok) {
    throw new Error(`Fireworks catalog returned HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { models?: unknown } | null;
  const entries = Array.isArray(body?.models) ? (body.models as FireworksEntry[]) : [];
  // Match on the full id, as the roster stores; bare names accepted too.
  const entry = entries.find(
    (candidate) =>
      candidate.name === model || candidate.name === `accounts/fireworks/models/${model}`,
  );
  return entry ? toFireworksDetails(entry, model) : null;
};

/* Resolve provider-owned details; null when the host lacks the model. */
export const lookupProviderModel = async (
  provider: LookupProvider,
  model: string,
): Promise<ProviderModelDetails | null> => {
  switch (provider) {
    case 'deepinfra':
      return lookupDeepInfra(model);
    case 'fireworks':
      return lookupFireworks(model);
    default: {
      // Exhaustiveness guard: a new LookupProvider must be wired here.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported lookup provider: ${String(_exhaustive)}`);
    }
  }
};
