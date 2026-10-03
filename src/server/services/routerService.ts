import { inferenceService } from './inferenceService';
import { LlmProvider } from './llmTypes';
import {
  AllModelsDisabledError,
  completionsPoolFor,
  ModelRef,
  routingPrice,
} from './modelConfigService';
import { redactForLog } from './logRedaction';
import { FitWeight, getFitWeight } from './modelMetricsStatsService';

/*
 * Routing tiers resolve to an ELIGIBLE pool of models (MongoDB-backed,
 * `modelConfigService`) instead of a single env-config model. When exactly
 * one model qualifies for a tier, that model always runs (deterministic).
 * When several qualify, the choice is ε-random with a PRICE-WEIGHTED
 * distribution (#199: cheaper models draw higher probability) so cheaper
 * models are preferred while expensive ones still get sampled for feedback;
 * `ROUTER_EPSILON` (default 1) is the probability of exploring the weighted
 * draw instead of always the first entry. An empty pool — no available model
 * at all — fails loudly (#4 G).
 */

export interface RouterConfig {
  small: ModelRef[];
  large: ModelRef[];
  guardModel: string;
  /*
   * #168: set when a tier's pool read reported "rows exist but all are
   * cooling off" (AllModelsDisabledError from listByTier — the only
   * rejection that can escape it, every other read failure falls back to
   * the env model inside listByTier). The error is DEFERRED to the pick of
   * that tier: one drained tier must not fail turns the healthy tier could
   * serve (the pools are read together up front, the tier decision happens
   * after). The flag travels with the config so injected-test configs
   * (plain pools, no flags) keep the pre-#168 loud-empty-pool behaviour.
   */
  smallCoolingOff?: boolean;
  largeCoolingOff?: boolean;
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
  /*
   * #214: the guard's AUX `files` vote — true when the user is likely
   * referring to a specific file in their library, so the chat route should
   * inject the bounded library index into the system prompt. This never
   * influences the tier (see AUX_CATEGORIES); absent on image turns (guard
   * skipped) and false on unparseable/error paths (no speculative read).
   */
  filesLikely?: boolean;
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
  /*
   * #169 phase 2: prior chat turns (oldest first, text-only) so the guard
   * can judge the current request in context — "no, use psql" inherits the
   * significance of the surrounding work. PRIOR TURNS ONLY: never the
   * current message, which rides separately as the query. The router
   * bounds the tail (ROUTER_GUARD_CONTEXT_MESSAGES); absent/empty history
   * is legal (first turn, incognito) — the guard then judges the bare
   * message, exactly the information it had before this field existed.
   */
  history?: { role: 'user' | 'assistant'; content: string }[];
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
 *
 * #199: the explore draw is PRICE-WEIGHTED, not uniform — a cheaper model
 * (lower `inputPrice + outputPrice`) draws a higher selection probability, as
 * the ticket requires. Weight is the inverse summed price; a model with no
 * known price is neutral (weight 1, the same as a $1/mtok model) so unpriced
 * rows are neither favoured nor starved. With ε at its default 1 the explore
 * branch is always taken, so price shapes the pick by default; the forced-fit
 * leader path in `orderPoolByFit` still overrides on strong feedback.
 */
const priceWeight = (modelRef: ModelRef): number => {
  const price = routingPrice(modelRef);
  // Unknown price is neutral (weight 1). A known price — including an
  // explicit 0 — weights by inverse price; a tiny floor keeps a free model
  // finite (and most probable) instead of producing Infinity.
  return price === undefined ? 1 : 1 / Math.max(price, 0.0001);
};

const priceWeightedIndex = (pool: ModelRef[], random: () => number): number => {
  const weights = pool.map(priceWeight);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!Number.isFinite(total) || total <= 0)
    return Math.floor(random() * pool.length) % pool.length;
  let target = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    target -= weights[i];
    if (target < 0) return i;
  }
  return weights.length - 1;
};

export const pickModelRef = (
  pool: ModelRef[],
  tier: string,
  epsilon: number,
  random: () => number,
): ModelRef => {
  if (pool.length === 0) {
    throw new Error(`No eligible models configured for tier: ${tier}`);
  }
  if (pool.length === 1 || random() >= epsilon) {
    return pool[0];
  }
  // Explore: an independent draw keeps the within-pool choice price-weighted
  // (reusing the epsilon draw would skew the distribution toward the start
  // of the pool whenever epsilon < uniform mass of the first entry).
  return pool[priceWeightedIndex(pool, random)];
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
  /*
   * #168: the two pool reads settle independently — one tier's rows all
   * cooling off (AllModelsDisabledError) must not fail the turn before the
   * tier decision has even happened. The drained tier keeps an empty pool
   * plus its flag; the loud error is thrown at pick time (see routeQuery),
   * so a healthy tier still serves its turns.
   */
  const [small, large] = await Promise.allSettled([
    completionsPoolFor('small'),
    completionsPoolFor('large'),
  ]);
  const pools = (r: PromiseSettledResult<ModelRef[]>): ModelRef[] =>
    r.status === 'fulfilled' ? r.value : [];
  const coolingOff = (r: PromiseSettledResult<ModelRef[]>): boolean =>
    r.status === 'rejected' && r.reason instanceof AllModelsDisabledError;
  return {
    small: pools(small),
    large: pools(large),
    guardModel: process.env.ROUTER_GUARD_MODEL || 'openai/gpt-oss-20b',
    ...(coolingOff(small) ? { smallCoolingOff: true } : {}),
    ...(coolingOff(large) ? { largeCoolingOff: true } : {}),
  };
};

/*
 * Tier 2 guard classifier (#169 phase 2). Boundary history, evidence-first:
 * - #129: LangSmith traces (tova-dev, 2026-09-20) showed the reasoning guard
 *   model (openai/gpt-oss-20b) burning its whole token budget on reasoning
 *   and returning an EMPTY reply at the old max_tokens: 10. The budget is
 *   env-tunable (`ROUTER_GUARD_MAX_TOKENS`, default 512 since #169 phase 2 —
 *   a transcript in the prompt truncated the vote JSON at 256) and every
 *   failure mode (empty, unparseable, thrown) routes LARGE — never small.
 * - #169 phase 1: inverted the boundary — large is the default route, small
 *   the explicit exception for trivially conversational intent.
 * - #169 phase 2 (user direction, 2026-09-26): the deterministic key-phrase
 *   rules ("hi"/"hello" regexes, the code-keyword fast-path) are deleted
 *   ENTIRELY — parsing natural language is the guard LLM's job, and it now
 *   receives the chat context so "Hello! Please explain quantum tunneling
 *   to me." or "no, use psql" route on substance, not on greeting words.
 *   The guard replies with ONE JSON object of category votes; any "yes"
 *   routes large, all "no" routes small ("if all no, then small, otherwise
 *   large"). The reason vocabulary `classifier-complex` / `classifier-simple`
 *   now names the VOTE OUTCOME (any-yes / all-no), not literal reply words —
 *   kept stable for chat-route mocks, LangSmith and `(band, model)` feedback
 *   keys. A future DeepInfra /decisions endpoint can replace the call behind
 *   this same contract.
 */

export const classifyPrompt = (
  query: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): string => {
  const transcript = history.length
    ? `\nConversation so far, oldest first:\n${history
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n')}\n`
    : '';
  return `Classify the user's current request below by replying with ONLY one JSON object, nothing else, with exactly these five keys, each "yes" or "no":

{"reasoning":"yes|no","code":"yes|no","emotional":"yes|no","creative":"yes|no","files":"yes|no"}
${transcript}
Current request: ${query}

Judge what answering the current request well needs, in light of the conversation so far when one is given: when the conversation shows ongoing work, a short current request that continues or steers that work (a choice, a correction, a next step) inherits that work's significance.
- reasoning: explanation, analysis, multi-step reasoning, a comparison, a recommendation, or a plan — a substantive how/why question, real work, or a short follow-up that continues such work from the conversation. A single simple fact, look-up, or calculation ("what is the capital of Australia?", "2 + 2") with no such work behind it is "no".
- code: writing, debugging, reviewing, or discussing code — including a tool, command, or implementation choice that continues technical work in the conversation.
- emotional: emotional support, comfort, or weighty personal talk. Casual small talk ("how has your day been?") is "no".
- creative: creative writing — stories, poems, lyrics, role-play, and the like.
- files: is the user likely referring to a specific file in their library — an existing uploaded document they expect you to find, open, or quote ("summarise my CV", "what did the lease say about pets", "check the Q3 report")? Say "no" when they ask you to create or save a new file, and "no" for general chat that does not point at an existing document.

Greetings, thanks, and yes/no confirmations with no work behind them score "no" on all five keys.`;
};

const VOTE_CATEGORIES = ['reasoning', 'code', 'emotional', 'creative'] as const;

// #214: the `files` vote is AUX — it selects prompt enrichment (library-index
// injection), never the tier. Kept out of VOTE_CATEGORIES so a bare file
// reference with no other signal can still route SMALL; parsing it separately
// (guardFilesVoteFromReply) is what keeps the tier gate unchanged.
const AUX_CATEGORIES = ['files'] as const;

/*
 * Extract the guard's vote object: the LAST balanced, JSON-parseable {...}
 * in the reply that carries at least one category key. Reasoning models
 * emit chain-of-thought ahead of the answer (#129), so an earlier object
 * may be a worked example — the last vote-shaped object wins (same
 * last-match rationale as the old complex|simple word parse). Objects
 * with none of the category keys (prose examples, decoys) are skipped;
 * none at all → null (routeQuery's unparseable path).
 */
export const parseGuardVotes = (raw: string): Record<string, unknown> | null => {
  const objects: Record<string, unknown>[] = [];
  let start = raw.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const obj: unknown = JSON.parse(raw.slice(start, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
              objects.push(obj as Record<string, unknown>);
            }
          } catch {
            // Not valid JSON from this '{' — keep scanning.
          }
          break;
        }
      }
    }
    start = raw.indexOf('{', start + 1);
  }
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    if ([...VOTE_CATEGORIES, ...AUX_CATEGORIES].some((c) => c in objects[i])) return objects[i];
  }
  return null;
};

/*
 * Map the vote object to the tier decision. A category counts as "no" only
 * on an explicit (case-insensitive) "no"; a missing category or any other
 * value counts as "yes" — doubt routes large, per #169's large-by-default
 * boundary. Null when no vote-shaped object is parseable.
 */
export const guardVerdictFromReply = (content: string): 'complex' | 'simple' | null => {
  const votes = parseGuardVotes(content);
  if (!votes) return null;
  return VOTE_CATEGORIES.some(
    (c) =>
      String(votes[c] ?? '')
        .trim()
        .toLowerCase() !== 'no',
  )
    ? 'complex'
    : 'simple';
};

/*
 * #214: the AUX `files` vote → "is the user likely referring to a specific
 * file in their library?". Unlike the tier votes, a MISSING key is a no (not
 * doubt): a guard still on the old four-key contract must not trigger the
 * library read, and the injected block is only worth paying for on an actual
 * signal. Explicit "no"/missing → false; any other present value → true
 * (doubt prefers enrichment; the block is cheap and harmless). No vote object
 * at all → false. Never feeds back into the tier decision (D2).
 */
export const guardFilesVoteFromReply = (content: string): boolean => {
  const votes = parseGuardVotes(content);
  if (!votes) return false;
  return AUX_CATEGORIES.some(
    (c) =>
      c in votes &&
      String(votes[c] ?? '')
        .trim()
        .toLowerCase() !== 'no',
  );
};

const guardMaxTokens = (): number => {
  const raw = process.env.ROUTER_GUARD_MAX_TOKENS;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  // 512 since #169 phase 2: the v2 spot-check + budget probe
  // (.iteration/docs/169-guard-budget-probe*.txt) show the reasoning guard
  // burning the old 256-token budget on chain-of-thought whenever a
  // conversation transcript rides in the prompt, returning empty/truncated
  // votes — the #129 failure shape at JSON scale.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
};

const guardContextMessages = (): number => {
  const raw = process.env.ROUTER_GUARD_CONTEXT_MESSAGES;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
};

export const routeQuery = async (
  query: string,
  config: RouterConfig | null = null,
  random: () => number = Math.random,
  deps: RouterDeps = {},
): Promise<RoutingResult> => {
  const {
    small: smallPoolRaw,
    large: largePool,
    guardModel,
    smallCoolingOff = false,
    largeCoolingOff = false,
  } = config ?? (await defaultConfig());
  const epsilon = epsilonFromEnv();
  const readWeight = deps.getFitWeight ?? defaultGetFitWeight;
  const band = deps.band ?? '';

  /*
   * #168: a tier whose pool drained via cool-off fails with the dedicated
   * all-disabled error at pick time (deferred from the pool read — see
   * defaultConfig). Other empty pools keep the generic loud error
   * (`pickModelRef`).
   */
  const pickFromTier = (
    pool: ModelRef[],
    tier: 'small' | 'large',
    coolingOff: boolean,
  ): ModelRef => {
    if (pool.length === 0 && coolingOff) throw new AllModelsDisabledError();
    return pickModelRef(pool, tier, epsilon, random);
  };

  // Image turns (#115): capability first — only `vision: true` rows in the
  // LARGE tier survive, the classifier (text-only) is skipped. The user
  // routed all image chats to the large tier (2026-09-20) so the two vision
  // models seeded there can be compared; small vision rows never serve
  // image turns. Empty large vision pool is a loud failure — routing an
  // image to a non-vision model would be worse than failing the turn.
  if (deps.hasImage) {
    // #168: a large tier that drained via cool-off fails with the dedicated
    // all-disabled error — "No vision-capable models configured" would
    // misreport a cool-off outage as a config problem.
    if (largeCoolingOff) throw new AllModelsDisabledError();
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

  // Tier 2: Guard model classification — the ONLY text routing path. The
  // deterministic key-phrase rules that used to short-circuit here are gone
  // (#169 phase 2): every text turn, greetings included, pays one guard
  // round-trip so natural language is judged by the LLM in conversation
  // context, never by a regex. The context tail is bounded by
  // ROUTER_GUARD_CONTEXT_MESSAGES (default 10, aligned with the chat
  // routes' history window).
  try {
    // #77: a tool-free agent — the guard model may reject tool-carrying
    // requests entirely, and this call needs plain text only (issue #41).
    const response = await inferenceService.createToolFreeCompletion({
      model: guardModel,
      messages: [
        {
          role: 'user',
          content: classifyPrompt(query, (deps.history ?? []).slice(-guardContextMessages())),
        },
      ],
      temperature: 0,
      max_tokens: guardMaxTokens(),
    });

    // The vote object is the LAST balanced {...} carrying a category key:
    // reasoning models emit chain-of-thought ahead of the answer (#129), so
    // earlier objects may be worked examples. A reply with NO vote object
    // at all is exactly the LangSmith-observed failure mode (reasoning
    // consumed the budget, empty text) — treat it like a classifier error
    // and fall back to the large tier instead of silently defaulting to
    // small.
    const content = response.choices[0]?.message?.content ?? '';
    const verdict = guardVerdictFromReply(content);
    // #214: AUX vote — parsed beside the tier verdict, never part of it.
    // guardFilesVoteFromReply returns false for a missing key or unparseable
    // reply; the field is emitted only when true so non-file turns keep the
    // pre-#214 RoutingResult shape exactly (same "no undefined keys" rule as
    // spreadRef).
    const filesLikely = guardFilesVoteFromReply(content);
    const filesField = filesLikely ? { filesLikely: true } : {};

    if (verdict === 'complex') {
      const { pool, forced, reasonSuffix } = await orderPoolByFit(largePool, band, readWeight);
      const modelRef = forced ?? pickFromTier(pool, 'large', largeCoolingOff);
      return {
        model: modelRef.model,
        reason: `classifier-complex${reasonSuffix}`,
        ...spreadRef(modelRef),
        ...filesField,
      };
    }
    if (verdict === 'simple') {
      const { pool, forced, reasonSuffix } = await orderPoolByFit(smallPoolRaw, band, readWeight);
      const modelRef = forced ?? pickFromTier(pool, 'small', smallCoolingOff);
      return {
        model: modelRef.model,
        reason: `classifier-simple${reasonSuffix}`,
        ...spreadRef(modelRef),
        ...filesField,
      };
    }
    // Unparseable reply (empty, or no vote object anywhere): route large as
    // the safe default — defaulting verdict-less replies to small is what
    // pushed the Ad Gefrin conversation to the small tier (issue #129).
    console.error('Classifier unparseable reply:', redactForLog(content || '(empty)'));
    const { pool, forced, reasonSuffix } = await orderPoolByFit(largePool, band, readWeight);
    const modelRef = forced ?? pickFromTier(pool, 'large', largeCoolingOff);
    return {
      model: modelRef.model,
      reason: `classifier-unparseable${reasonSuffix}`,
      ...spreadRef(modelRef),
      ...filesField,
    };
  } catch (err) {
    if (err instanceof AllModelsDisabledError) throw err;
    console.error('Classifier error:', redactForLog(err));
    // Fallback to large model on error for safety (raw pool order — the
    // classifier is down, so its feedback weighting waits for a retry).
    const modelRef = pickFromTier(largePool, 'large', largeCoolingOff);
    return { model: modelRef.model, reason: 'classifier-error', ...spreadRef(modelRef) };
  }
};
