import { config } from '../config';

/*
 * Provider model lookup (#217): resolve a model's context window, pricing and
 * capabilities straight from the provider's catalog so the admin can add a
 * routing row without hand-researching it. Server-side only — the API key must
 * never reach the browser.
 *
 * Scope today is DeepInfra and Fireworks, the two roster providers (#232).
 * DeepInfra's OpenAI-compatible catalog endpoint
 * (`/v1/openai/models?sort_by=openclaw&filter=with_meta`) publishes context,
 * prices and vision; prices arrive already in the repo's USD-per-1M-tokens
 * convention (#199), so no scaling is applied. Fireworks' list-models endpoint
 * (`/v1/accounts/fireworks/models`) publishes context/vision/tools but no
 * pricing. Groq is a known follow-up: its list endpoint carries no pricing.
 */

export type LookupProvider = 'deepinfra' | 'fireworks';

/*
 * Normalised lookup result. `found: false` is a normal outcome (the provider
 * answered and does not host the model); thrown errors are reserved for
 * provider/network/transport failures so the route can distinguish "checked,
 * absent" from "could not check".
 *
 * Prices are optional because not every provider publishes them: DeepInfra's
 * catalog carries per-token pricing, Fireworks' list-models endpoint does not
 * (verified 2026-10-08). A missing price is serde-omitted and stays "unknown"
 * (neutral in the weighted score), never 0.
 */
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

/*
 * #232/#234: Fireworks' model list. The serverless catalog lives under the
 * shared `fireworks` account, so the account id is a constant, not config —
 * user deployments under other accounts are out of scope for a roster model.
 */
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
    // DeepInfra's catalog carries no tools flag; the roster schema defaults
    // `tools` to true, so an absent tag reads as tool-capable capability-wise.
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
 * #234: Fireworks list-models entry. `name` is the full `accounts/fireworks/
 * models/...` id sent to the provider verbatim. Capabilities + context are
 * reported; token pricing is not on this endpoint.
 */
interface FireworksEntry {
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  contextLength?: unknown;
  supportsImageInput?: unknown;
}

/*
 * Fireworks reports capabilities only. Unlike DeepInfra there is no pricing, so
 * the returned details omit prices entirely (they stay "unknown", neutral in
 * the score). A non-chat entry that reports no context window reads as "not
 * found" — resolving one as a roster model would write a useless row.
 */
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
  // Match on the full id (`accounts/fireworks/models/...`), which is what the
  // roster stores and sends; a bare short name is accepted too for operator
  // convenience.
  const entry = entries.find(
    (candidate) =>
      candidate.name === model || candidate.name === `accounts/fireworks/models/${model}`,
  );
  return entry ? toFireworksDetails(entry, model) : null;
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
    case 'fireworks':
      return lookupFireworks(model);
    default: {
      // Exhaustiveness guard: a new LookupProvider must be wired here.
      const _exhaustive: never = provider;
      throw new Error(`Unsupported lookup provider: ${String(_exhaustive)}`);
    }
  }
};
