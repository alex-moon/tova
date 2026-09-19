import { inferenceService } from './inferenceService';
import { LlmProvider } from './llmTypes';
import { completionsPoolFor, ModelRef } from './modelConfigService';
import { FitWeight, getFitWeight } from './modelMetricsStatsService';

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

// Feedback-weighting injectables (issue #18): `band` is the deterministic
// routing band of the user turn; `getFitWeight` returns the empirical
// up/down fit for a (band, model) cell. Tests inject stubs so no Mongo is
// needed.
export interface RouterDeps {
  band?: string;
  getFitWeight?: (band: string, model: string) => Promise<FitWeight>;
}

const defaultGetFitWeight = getFitWeight;

const epsilonFromEnv = (): number => {
  const raw = process.env.ROUTER_EPSILON;
  if (raw === undefined || raw === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 1;
};

/*
 * Feedback weighting (issue #18), re-implemented on the #4 tier pools: the
 * qualifying tier's pool is re-ordered by empirical fit for the band
 * (highest first, stable ties keep DB order). When the leader's fit beats
 * the pool's worst cell by `FEEDBACK_FLIP_RATIO`, the pick is FORCED to the
 * leader — strong evidence overrides randomness, preserving #18's
 * documentable flip even under the default even distribution. Otherwise the
 * ε-greedy pick runs normally against the ordered pool, so exploitation
 * tends to the best fit while exploration still samples uniformly. The old
 * cross-tier flip is gone by design: pools are tier-partitioned and the
 * tier decision belongs wholly to the classifier/rules. The appended reason
 * keeps the `;feedback-weight:<w>:<ups>/<downs>` shape LangSmith (#5)
 * consumes; no data for the band → no re-ordering, no suffix, pure ε pick.
 */
const FEEDBACK_FLIP_RATIO = 1.25;

const orderPoolByFit = async (
  pool: ModelRef[],
  band: string,
  readWeight: (band: string, model: string) => Promise<FitWeight>,
): Promise<{ pool: ModelRef[]; forced?: ModelRef; reasonSuffix: string }> => {
  if (!band || pool.length < 2) return { pool, reasonSuffix: '' };
  const weights = await Promise.all(
    pool.map(async (modelRef) => ({ modelRef, fit: await readWeight(band, modelRef.model) })),
  );
  const anyData = weights.some(({ fit }) => fit.ups + fit.downs > 0);
  if (!anyData) {
    return { pool, reasonSuffix: '' };
  }
  const ordered = [...weights].sort((a, b) => b.fit.weight - a.fit.weight);
  const leader = ordered[0];
  const worst = ordered[ordered.length - 1];
  const ratio = worst.fit.weight > 0 ? leader.fit.weight / worst.fit.weight : Infinity;
  const forced: ModelRef | undefined = ratio >= FEEDBACK_FLIP_RATIO ? leader.modelRef : undefined;
  const suffix = `;feedback-weight:${leader.fit.weight.toFixed(2)}:${leader.fit.ups}/${leader.fit.downs}`;
  return {
    pool: ordered.map(({ modelRef }) => modelRef),
    forced,
    reasonSuffix: suffix,
  };
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
 * pools are authoritative once seeded). Pools are resolved with the
 * required capabilities of the completion path (#94): completions always
 * carry tools, so rows flagged `tools: false` are excluded. If that leaves a
 * pool empty, `pickModelRef` throws — no silent Groq fallback: the env
 * fallback in `modelConfigService` only applies to unusable/empty DB tiers
 * and now names DeepInfra models only.
 *
 * The guard-model choice is not part of the pools: the classifier call stays
 * env-bound to a Groq small model (#94) — aux tasks only, tool-free by
 * construction of `createToolFreeCompletion`.
 */
const defaultConfig = async (): Promise<RouterConfig> => {
  const [small, large] = await Promise.all([
    completionsPoolFor('small'),
    completionsPoolFor('large'),
  ]);
  return {
    small,
    large,
    guardModel: process.env.ROUTER_GUARD_MODEL || 'openai/gpt-oss-20b',
  };
};

export const routeQuery = async (
  query: string,
  config: RouterConfig | null = null,
  random: () => number = Math.random,
  deps: RouterDeps = {},
): Promise<RoutingResult> => {
  const { small: smallPoolRaw, large: largePool, guardModel } = config ?? (await defaultConfig());
  const epsilon = epsilonFromEnv();
  const readWeight = deps.getFitWeight ?? defaultGetFitWeight;
  const band = deps.band ?? '';

  // Tier 1: Deterministic Rules

  // Rule 1: Short queries (greetings, simple confirmations)
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|thanks|thank you)/i.test(query)) {
    const modelRef = pickModelRef(smallPoolRaw, 'small', epsilon, random);
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
    // #77: a tool-free agent — the guard model may reject tool-carrying
    // requests entirely, and this call needs plain text only (issue #41).
    const response = await inferenceService.createToolFreeCompletion({
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
      const { pool, forced, reasonSuffix } = await orderPoolByFit(largePool, band, readWeight);
      const modelRef = forced ?? pickModelRef(pool, 'large', epsilon, random);
      return {
        model: modelRef.model,
        reason: `classifier-complex${reasonSuffix}`,
        provider: modelRef.provider,
      };
    }
  } catch (err) {
    console.error('Classifier error:', err);
    // Fallback to large model on error for safety (raw pool order — the
    // classifier is down, so its feedback weighting waits for a retry).
    const modelRef = pickModelRef(largePool, 'large', epsilon, random);
    return { model: modelRef.model, reason: 'classifier-error', provider: modelRef.provider };
  }

  const { pool, forced, reasonSuffix } = await orderPoolByFit(smallPoolRaw, band, readWeight);
  const modelRef = forced ?? pickModelRef(pool, 'small', epsilon, random);
  return {
    model: modelRef.model,
    reason: `classifier-simple${reasonSuffix}`,
    provider: modelRef.provider,
  };
};
