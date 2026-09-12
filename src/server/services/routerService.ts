import { inferenceService } from './inferenceService';
import { LlmProvider } from './llmTypes';
import { listByTier, ModelRef } from './modelConfigService';

/*
 * Routing tiers resolve to an ELIGIBLE pool of models (MongoDB-backed,
 * `modelConfigService`) instead of a single env-config model. When exactly
 * one model qualifies for a tier, that model always runs (deterministic).
 * When several qualify, the choice is ε-random with a uniform distribution
 * so per-model feedback accrues (#4 D): `ROUTER_EPSILON` (default 1) is the
 * probability of picking uniformly at random instead of always the first
 * entry. An empty pool — no available model at all — fails loudly (#4 G).
 */

export interface RouterConfig {
  small: ModelRef[];
  large: ModelRef[];
  guardModel: string;
}

export interface RoutingResult {
  model: string;
  reason: string;
  /*
   * Provider rides beside the model, never inside it (env default model
   * strings contain slashes — Mastra's router parses ids on the first slash
   * only). The provider comes from the picked `ModelRef`, so un-tagged env
   * path entries resolve to `groq` (they are seeded that way).
   */
  provider: LlmProvider;
}

const epsilonFromEnv = (): number => {
  const raw = process.env.ROUTER_EPSILON;
  if (raw === undefined || raw === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
};

/*
 * ε-random pick within one tier's pool. `random` is injectable so tests can
 * pin exact selections deterministically.
 */
export const pickModelRef = (
  pool: ModelRef[],
  tier: string,
  epsilon: number,
  random: () => number,
): ModelRef => {
  if (pool.length === 0) {
    throw new Error(`No eligible models configured for tier: ${tier}`);
  }
  // Explore: an independent draw keeps the within-pool choice uniform —
  // reusing the epsilon draw would skew the distribution toward the start
  // of the pool whenever epsilon < uniform mass of the first entry.
  if (pool.length === 1 || random() >= epsilon) {
    return pool[0];
  }
  return pool[Math.floor(random() * pool.length) % pool.length];
};

/*
 * Fetch both tier pools up front (they resolve from the DB config so the
 * pools are authoritative once seeded). The guard-model choice is not part
 * of the pools: the classifier call stays env-bound (see #4 task 8).
 */
const defaultConfig = async (): Promise<RouterConfig> => {
  const [small, large] = await Promise.all([listByTier('small'), listByTier('large')]);
  return {
    small,
    large,
    guardModel: process.env.ROUTER_GUARD_MODEL || 'allam-2-7b',
  };
};

export const routeQuery = async (
  query: string,
  config: RouterConfig | null = null,
  random: () => number = Math.random,
): Promise<RoutingResult> => {
  const { small: smallPool, large: largePool, guardModel } = config ?? (await defaultConfig());
  const epsilon = epsilonFromEnv();

  // Tier 1: Deterministic Rules

  // Rule 1: Short queries (greetings, simple confirmations)
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|thanks|thank you)/i.test(query)) {
    const modelRef = pickModelRef(smallPool, 'small', epsilon, random);
    return { model: modelRef.model, reason: 'deterministic-short', provider: modelRef.provider };
  }

  // Rule 2: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    const modelRef = pickModelRef(largePool, 'large', epsilon, random);
    return { model: modelRef.model, reason: 'deterministic-code', provider: modelRef.provider };
  }

  // Tier 2: Guard model classification
  try {
    const response = await inferenceService.createCompletion({
      model: guardModel,
      messages: [
        {
          role: 'user',
          content: `Classify the following user query into "simple" or "complex". Reply with only one word.\n\nQuery: ${query}`,
        },
      ],
      temperature: 0,
      max_tokens: 10,
    });

    const classification = response.choices[0]?.message?.content?.trim().toLowerCase();

    if (classification === 'complex') {
      const modelRef = pickModelRef(largePool, 'large', epsilon, random);
      return { model: modelRef.model, reason: 'classifier-complex', provider: modelRef.provider };
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety
    const modelRef = pickModelRef(largePool, 'large', epsilon, random);
    return { model: modelRef.model, reason: 'classifier-error', provider: modelRef.provider };
  }

  const modelRef = pickModelRef(smallPool, 'small', epsilon, random);
  return { model: modelRef.model, reason: 'classifier-simple', provider: modelRef.provider };
};
