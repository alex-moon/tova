import { config } from '../config';

/* Provider model lookup: resolve context/pricing/capabilities straight from the provider catalogs so the admin need not hand-research; server-side only (the API key never reaches the browser). */
// @see #217 #232 #199

export type LookupProvider = 'deepinfra' | 'fireworks';

/* Normalised lookup result: `found: false` is a normal outcome; thrown errors are reserved for transport failures; a missing price stays "unknown" (neutral), never 0. */
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

/* Fireworks' serverless catalog lives under the shared `fireworks` account — a constant, not config. */
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

/* A catalog entry is a chat-completion model only when it reports a token context window AND token pricing; non-chat entries read as "not found" rather than writing a useless routing row. */
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
    // DeepInfra's catalog carries no tools flag; the roster schema defaults `tools` to true.
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

/* Fireworks list-models entry: `name` is the full id sent to the provider verbatim; no pricing on this endpoint. */
// @see #234
interface FireworksEntry {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  contextLength?: unknown;
  supportsImageInput?: unknown;
}

/* Fireworks reports capabilities only; a non-chat entry with no context window reads as "not found". */
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
  // Match on the full id, which is what the roster stores and sends; a bare short name is accepted for operator convenience.
  const entry = entries.find(
    (candidate) =>
      candidate.name === model || candidate.name === `accounts/fireworks/models/${model}`,
  );
  return entry ? toFireworksDetails(entry, model) : null;
};

/* Resolve a model's provider-owned details; null when the provider hosts no such (chat) model, throws on transport/auth failures. */
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
