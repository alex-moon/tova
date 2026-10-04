import { config } from '../config';

/*
 * Provider model lookup (#217): resolve a model's context window, pricing and
 * capabilities straight from the provider's catalog so the admin can add a
 * routing row without hand-researching it. Server-side only — the API key must
 * never reach the browser.
 *
 * Scope today is DeepInfra, whose OpenAI-compatible catalog endpoint
 * (`/v1/openai/models?sort_by=openclaw&filter=with_meta`) publishes everything
 * the admin form used to ask for by hand. Prices arrive already in the repo's
 * USD-per-1M-tokens convention (#199), so no scaling is applied. Groq is a
 * known follow-up: its list endpoint carries no pricing.
 */

export type LookupProvider = 'deepinfra';

/*
 * Normalised lookup result. `found: false` is a normal outcome (the provider
 * answered and does not host the model); thrown errors are reserved for
 * provider/network/transport failures so the route can distinguish "checked,
 * absent" from "could not check".
 */
export interface ProviderModelDetails {
  provider: LookupProvider;
  model: string;
  contextLength?: number;
  // USD per 1M tokens, matching `providerroutings.inputPrice`/`outputPrice`.
  inputPrice?: number;
  outputPrice?: number;
  vision?: boolean;
  description?: string;
}

const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/v1/openai/models';

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

/*
 * A catalog entry is treated as a chat-completion model only when it reports a
 * token context window and token pricing. Non-chat entries (tts, image, etc.)
 * carry character/second pricing and a null context length; resolving one as a
 * routing row would write a useless row, so they read as "not found".
 */
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

/*
 * Resolve a model's provider-owned details. Returns `null` when the provider
 * hosts no such (chat) model; throws on transport/auth failures.
 */
export const lookupProviderModel = async (
  provider: LookupProvider,
  model: string,
): Promise<ProviderModelDetails | null> => {
  switch (provider) {
    case 'deepinfra':
      return lookupDeepInfra(model);
    default: {
      // Exhaustiveness guard: a new LookupProvider must be wired here.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported lookup provider: ${String(_exhaustive)}`);
    }
  }
};
