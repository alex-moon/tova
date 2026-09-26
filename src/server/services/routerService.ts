import { inferenceService } from './inferenceService';
import { LlmProvider } from './llmTypes';
import { completionsPoolFor, ModelRef } from './modelConfigService';
import { redactForLog } from './logRedaction';
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
  /*
   * Advertised context window of the picked model (#104): the chat routes
   * size their `max_tokens` against it. Absent only for legacy pools.
   */
  contextLength?: number;
}

// Feedback-weighting injectables (issue #18): `band` is the deterministic
// routing band of the user turn; `getFitWeight` returns the empirical
// up/down fit for a (band, model) cell. Tests inject stubs so no Mongo is
// needed.
export interface RouterDeps {
  band?: string;
  /*
   * #115: true when this turn carries an image attachment. The large pool is
   * then restricted to `vision: true` rows before any pick, and the text-only
   * guard classifier is skipped (it is blind to the pixels anyway) — image
   * turns are large-tier-only by user decision. An empty large vision pool
   * is a loud failure — routing an image to a non-vision model would be
   * worse than failing the turn.
   */
  hasImage?: boolean;
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

// `RoutingResult.contextLength` rides only when the pool ref carries one (env
// fallback refs do not) — never emit explicit `undefined` keys.
const spreadRef = (modelRef: ModelRef): Omit<RoutingResult, 'model' | 'reason'> => ({
  provider: modelRef.provider,
  ...(modelRef.contextLength !== undefined ? { contextLength: modelRef.contextLength } : {}),
});

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

/*
 * Tier 2 classifier prompt (#129). Evidence first: LangSmith traces from
 * `tova-dev` (2026-09-20, all retained classify runs) show the guard model —
 * a reasoning model (`openai/gpt-oss-20b`) — spending its entire token
 * budget on reasoning and returning an EMPTY text answer (`text: ''`) at the
 * old `max_tokens: 10`. Every such empty reply classifies as "simple" and
 * routes conversational turns to the small tier. Two changes follow:
 *   1. the prompt now spells out what counts as complex (narrative /
 *      conversational prose, multiple distinct questions, references to
 *      prior context or personal experience) so the guard does not need to
 *      spend tokens deciding criteria;
 *   2. the token budget is env-tunable (`ROUTER_GUARD_MAX_TOKENS`) and
 *      defaults to 256 — reasoning content is emitted ahead of the answer
 *      word, so the reply contract (a single lowercase word) is unchanged
 *      but the answer is no longer truncated away.
 *
 * #169 (2026-09-26): inverted the decision boundary — the LARGE tier is now
 * the default route and the small tier is the explicit exception. The reply
 * contract and these verdict words stay `simple | complex` (keeps the parse
 * regex, reason strings, and `(band, model)` feedback history keys stable),
 * but their meaning shifts: `simple` = "trivially conversational — the user
 * does not need a smart model" (greetings, thanks, chit-chat one-liners,
 * short single factual questions), `complex` = "substantive — anything else
 * a user might actually want a real answer to". The prompt text below was
 * already written with this asymmetry in #129 (`simple` is defined narrowly
 * with "only when", `complex` covers all conversational/work prose), so no
 * wording change was needed; this comment records the boundary semantics.
 * Note a consequence of the semantics: pure chit-chat that is longer than a
 * greeting (e.g. multi-sentence small talk) classifies complex and routes
 * large — by design, per the ticket, small models are the exception.
 */

export const classifyPrompt = (query: string): string =>
  `Classify the user query below into "simple" or "complex".

A query is "complex" when ANY of these apply:
- it is conversational or narrative prose: the user shares context, tells a story, or writes several sentences in a personal tone
- it asks more than one distinct question, even casually embedded in the prose
- it refers to prior conversation, personal experience, named places, people, or events
- it wants a recommendation, comparison, or multi-part answer

A query is "simple" only when it is a short, single factual question, a one-line command, or a greeting/thanks.

Reply with only one word: complex or simple.

Query: ${query}`;

const guardMaxTokens = (): number => {
  const raw = process.env.ROUTER_GUARD_MAX_TOKENS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
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

  // Image turns (#115): capability first — only `vision: true` rows in the
  // LARGE tier survive, the classifier (text-only) is skipped. The user
  // routed all image chats to the large tier (2026-09-20) so the two vision
  // models seeded there can be compared; small vision rows never serve
  // image turns. Empty large vision pool is a loud failure — routing an
  // image to a non-vision model would be worse than failing the turn.
  if (deps.hasImage) {
    const visionLarge = largePool.filter((ref) => ref.vision === true);
    if (visionLarge.length === 0) {
      throw new Error('No vision-capable models configured for image attachments');
    }
    const {
      pool: ordered,
      forced,
      reasonSuffix,
    } = await orderPoolByFit(visionLarge, band, readWeight);
    const modelRef = forced ?? pickModelRef(ordered, 'large', epsilon, random);
    return {
      model: modelRef.model,
      reason: `image-attachment${reasonSuffix}`,
      provider: modelRef.provider,
    };
  }

  // Tier 1: Deterministic Rules. The code rule runs first: a short prompt
  // that starts with a greeting token but asks for code ('hi, write code')
  // is never trivially conversational, so the greeting rule must not shadow
  // it into the exception tier (#169).

  // Rule 1: Code blocks or explicit coding requests
  if (
    query.toLowerCase().includes('code') ||
    query.toLowerCase().includes('function') ||
    query.toLowerCase().includes('script') ||
    /```/.test(query)
  ) {
    const modelRef = pickModelRef(largePool, 'large', epsilon, random);
    return { model: modelRef.model, reason: 'deterministic-code', ...spreadRef(modelRef) };
  }

  // Rule 2: Short queries (greetings, simple confirmations)
  // #169: require a word boundary after the greeting token — a bare prefix
  // match was sending non-trivial short prompts ('hit me', 'nope, and...',
  // 'okapi facts') to the small tier, which under the inverted boundary is
  // reserved for trivially conversational intent only.
  if (query.length < 20 && /^(hello|hi|hey|yes|no|ok|okay|thanks|thank you)\b/i.test(query)) {
    const modelRef = pickModelRef(smallPoolRaw, 'small', epsilon, random);
    return { model: modelRef.model, reason: 'deterministic-short', ...spreadRef(modelRef) };
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
          content: classifyPrompt(query),
        },
      ],
      temperature: 0,
      max_tokens: guardMaxTokens(),
    });

    // Take the LAST word-boundary match: some guard models emit their
    // reasoning ahead of the verdict in `content` (or reply with trailing
    // punctuation), so an exact-equality check would misclassify that as
    // simple. A reply with NO verdict at all is exactly the LangSmith-
    // observed failure mode (reasoning consumed the budget, `text: ''`) —
    // treat it like a classifier error and fall back to the large tier
    // instead of silently defaulting to small.
    const content = response.choices[0]?.message?.content ?? '';
    const matches = [...content.toLowerCase().matchAll(/\b(complex|simple)\b/g)];
    const classification = matches.length ? matches[matches.length - 1][1] : null;

    if (classification === 'complex') {
      const { pool, forced, reasonSuffix } = await orderPoolByFit(largePool, band, readWeight);
      const modelRef = forced ?? pickModelRef(pool, 'large', epsilon, random);
      return {
        model: modelRef.model,
        reason: `classifier-complex${reasonSuffix}`,
        ...spreadRef(modelRef),
      };
    }
    if (classification === 'simple') {
      const { pool, forced, reasonSuffix } = await orderPoolByFit(smallPoolRaw, band, readWeight);
      const modelRef = forced ?? pickModelRef(pool, 'small', epsilon, random);
      return {
        model: modelRef.model,
        reason: `classifier-simple${reasonSuffix}`,
        ...spreadRef(modelRef),
      };
    }
    // Unparseable reply (empty, or no verdict word anywhere): route large as
    // the safe default — defaulting verdict-less replies to small is what
    // pushed the Ad Gefrin conversation to the small tier (issue #129).
    console.error('Classifier unparseable reply:', redactForLog(content || '(empty)'));
    const { pool, forced, reasonSuffix } = await orderPoolByFit(largePool, band, readWeight);
    const modelRef = forced ?? pickModelRef(pool, 'large', epsilon, random);
    return {
      model: modelRef.model,
      reason: `classifier-unparseable${reasonSuffix}`,
      ...spreadRef(modelRef),
    };
  } catch (err) {
    console.error('Classifier error:', redactForLog(err));
    // Fallback to large model on error for safety (raw pool order — the
    // classifier is down, so its feedback weighting waits for a retry).
    const modelRef = pickModelRef(largePool, 'large', epsilon, random);
    return { model: modelRef.model, reason: 'classifier-error', ...spreadRef(modelRef) };
  }
};
