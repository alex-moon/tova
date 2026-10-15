import { buildSystemContent } from '../../services/promptAssembly';
import { inferenceService } from '../../services/inferenceService';
import { resolveScheduledModels } from '../../services/evalRunService';
import {
  buildWorkspaceBlock,
  retrieveWorkspaceSlices,
  type WorkspaceSlice,
} from '../../services/workspaceRetrievalService';
import { config } from '../../config';
import { evalUserId } from '../mongoSource';
import { MEMORY_SCENARIOS } from './corpus';
import { clearMemoryCorpus, seedMemoryScenario, type SeedIdMap } from './memorySource';
import type { MemoryScenario, ScenarioCategory } from './types';

/*
 * #289 stage 3 — injection helpfulness. Two arms per scenario: the same query
 * answered WITH the retrieved workspace block and WITHOUT it. A substring check
 * ("does the answer contain the expected fact?") is the deterministic backbone,
 * but it cannot tell *using* the memory from *reciting* or *inventing* it, so a
 * blinded, position-swapped LLM judge scores the holistic delta.
 *
 * Two guards the ticket calls out explicitly:
 *
 * - **Counterfactual.** The without-arm is run too, not assumed empty. If the
 *   model already answers correctly with the block blanked, the injection did
 *   not help and a judge-only setup would never see it — `counterfactualHit`
 *   records that case.
 * - **Blinding + position swap.** The judge is never told which arm carried the
 *   block, and every pair is judged twice with the arms swapped. A verdict that
 *   flips with the order (or ties) is a tie, not a win — a weak judge cannot be
 *   flattered into an order-consistent win.
 *
 * Every dependency is injectable so the arithmetic and the swap logic are
 * unit-testable without Mongo, providers, or LangSmith (same seam style as
 * `memoryEvalService`). The live responder and judge are the defaults, so the
 * CLI gets the wired behaviour and tests override both.
 */

/* --------------------------------- judging --------------------------------- */

/**
 * The judge's reply for one presentation of a pair. `error` is distinct from
 * `tie`: a tie is a considered "no preference", an error is an empty or
 * unparseable reply (or a thrown provider call), which must not be scored as
 * half a win (T14b, OQ20).
 */
export type JudgeVerdict = 'A' | 'B' | 'tie' | 'error';

/** The with-arm's outcome across the two (position-swapped) presentations. */
export type PairOutcome = 'win' | 'loss' | 'tie' | 'error';

/**
 * Fold the two position-swapped verdicts into one outcome for the with-arm.
 * `first` is the verdict when the with-arm was presented as A; `second` when it
 * was presented as B. Only an order-consistent win counts as a win; a flip
 * (the judge preferring whichever answer it saw first) is a tie. If either
 * presentation errored the pair is `error` — it cannot be scored (T14b).
 */
export const resolveSwappedOutcome = (first: JudgeVerdict, second: JudgeVerdict): PairOutcome => {
  if (first === 'error' || second === 'error') return 'error';
  const withWon = first === 'A' && second === 'B';
  const withoutWon = first === 'B' && second === 'A';
  if (withWon) return 'win';
  if (withoutWon) return 'loss';
  return 'tie';
};

/*
 * The judge prompt is deliberately blind: it names no memory, no block, and no
 * arm. It only says which answer is more helpful, so the judge cannot key on
 * "this one had context". It pins one judging criterion (owner decision,
 * 2026-10-14): specificity beats fluency — without it every probed judge
 * preferred a fluent refusal over a terse fact fragment (the T5 finding), the
 * exact failure mode stage 3 exists to catch. Reasoning models emit
 * chain-of-thought ahead of the token, hence the "ONLY one token" instruction
 * and the last-match parser.
 */
export const buildJudgePrompt = (query: string, answerA: string, answerB: string): string =>
  [
    'You are comparing two assistant answers to the same user question.',
    'Decide which answer is more helpful to the user — correct, relevant, and',
    'appropriately using any context it was given. You are not told how either',
    'answer was produced.',
    'When the answers differ in specificity, prefer the one that contains the',
    'specific information the user asked about, even if it is terser. A fluent',
    'answer that does not address the question is not more helpful than a',
    'direct one that does.',
    'Reply with ONLY one token: A, B, or TIE.',
    '',
    `User question:\n${query}`,
    '',
    `Answer A:\n${answerA}`,
    '',
    `Answer B:\n${answerB}`,
  ].join('\n');

const verdictFromToken = (token: string): JudgeVerdict => {
  const upper = token.toUpperCase();
  if (upper === 'A') return 'A';
  if (upper === 'B') return 'B';
  return 'tie';
};

/**
 * Last standalone A/B/TIE token wins. An empty or unparseable reply is an
 * `error`, not a `tie`: a dead or truncated judge must not read as a
 * considered "no preference" that scores 0.5 (T14b, OQ20/OQ21).
 *
 * A standalone lowercase `a` is the English article, not a verdict: the judge
 * is instructed to emit uppercase `A`, so a trailing "…is B because it gives a
 * clearer explanation" must not be read as `A` (which would invert the verdict
 * *consistently* across both swap orders and flip a loss into a win). Lowercase
 * `a` is therefore dropped from the candidate pool unless it is the entire
 * reply. The residual — which arm token to prefer when a reasoned reply names
 * both, e.g. "A is better because B misses the point" — stays OQ38.
 */
export const parseJudgeVerdict = (raw: string): JudgeVerdict => {
  const alone = /^(A|B|TIE)\.?$/i.exec(raw.trim());
  if (alone) return verdictFromToken(alone[1]);
  const matches = raw.match(/\b(A|B|TIE)\b/gi);
  if (!matches?.length) return 'error';
  const candidates = matches.filter((token) => token !== 'a');
  const pool = candidates.length ? candidates : matches;
  return verdictFromToken(pool[pool.length - 1]);
};

/* ---------------------------------- types ---------------------------------- */

export interface HelpfulnessCaseResult {
  scenarioId: string;
  category: ScenarioCategory;
  expectedSliceId: string;
  /** Retrieval surfaced the expected slice (the block would carry its id). */
  blockCarriesId: boolean;
  /** The rendered with-arm block carries the expected fact. */
  factInBlock: boolean;
  /** The with-arm answer carries the expected fact. */
  factHitWith: boolean;
  /** The without-arm answer already carries the expected fact (no attribution). */
  counterfactualHit: boolean;
  /** Pairwise outcome for the with-arm; null when there was no block to inject. */
  outcome: PairOutcome | null;
  /** Raw verdicts `[with-arm-as-A, with-arm-as-B]`, when judged. */
  verdicts?: [JudgeVerdict, JudgeVerdict];
  /**
   * Responder finish reasons per arm (T14f). `length` on either arm means the
   * answer was budget-truncated — a backbone miss from that case is a
   * generation-budget artefact, not a helpfulness one (OQ34).
   */
  finishReasons?: { with?: string; without?: string };
}

export interface HelpfulnessMetrics {
  total: number;
  /** Cases with a decisive-or-tie outcome, i.e. pairs the judge scored. */
  judged: number;
  wins: number;
  losses: number;
  ties: number;
  /** Pairs where a presentation failed (empty/unparseable reply or a throw). */
  errors: number;
  /** (wins + 0.5 × ties) / judged; null when nothing was judged. */
  winRate: number | null;
  /** Fraction of all cases where retrieval surfaced the expected slice id. */
  blockIdRate: number;
  /** Fraction of all cases where the with-arm answer carried the expected fact. */
  factHitRate: number;
  /** Cases where the without-arm already carried the fact (injection not attributable). */
  counterfactualHits: number;
  /** Cases where the with-arm block carried the fact AND the answer did, and the without-arm did not. */
  deterministicWins: number;
  /** Cases where either arm stopped on `length` — a truncation artefact (T14f/OQ34). */
  truncated: number;
}

export const helpfulnessMetrics = (results: HelpfulnessCaseResult[]): HelpfulnessMetrics => {
  let judged = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let errors = 0;
  let blockIds = 0;
  let factHits = 0;
  let counterfactualHits = 0;
  let deterministicWins = 0;
  let truncated = 0;
  for (const r of results) {
    if (r.blockCarriesId) blockIds += 1;
    if (r.factHitWith) factHits += 1;
    if (r.counterfactualHit) counterfactualHits += 1;
    if (r.factInBlock && r.factHitWith && !r.counterfactualHit) deterministicWins += 1;
    // T14f/OQ34: a `length` stop on either arm means the answer was
    // budget-truncated — reported as its own count so a backbone miss from a
    // truncated arm can be read as a generation-budget artefact.
    if (r.finishReasons?.with === 'length' || r.finishReasons?.without === 'length') {
      truncated += 1;
    }
    // Errors are reported as their own count and excluded from the win-rate
    // denominator (the shipped OQ20 default): a failed judge call is not a tie.
    if (r.outcome === 'error') {
      errors += 1;
      continue;
    }
    if (r.outcome === null) continue;
    judged += 1;
    if (r.outcome === 'win') wins += 1;
    else if (r.outcome === 'loss') losses += 1;
    else ties += 1;
  }
  const total = results.length;
  return {
    total,
    judged,
    wins,
    losses,
    ties,
    errors,
    winRate: judged ? (wins + 0.5 * ties) / judged : null,
    blockIdRate: total ? blockIds / total : 0,
    factHitRate: total ? factHits / total : 0,
    counterfactualHits,
    deterministicWins,
    truncated,
  };
};

/* ---------------------------------- runner --------------------------------- */

export interface HelpfulnessDeps {
  scenarios?: MemoryScenario[];
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  /** Answer `query` with `block` injected; `''` is the counterfactual arm. */
  respond?: (query: string, block: string) => Promise<RespondResult>;
  /** Return the better answer (`'A'`/`'B'`) or `'tie'` for one blinded presentation. */
  judge?: (query: string, answerA: string, answerB: string) => Promise<JudgeVerdict>;
  /** Inter-call delay before each live responder/judge call (T15d). */
  pace?: () => Promise<void>;
}

/**
 * Normalise a fact/answer before substring containment: casefold and collapse
 * internal whitespace. A fact split by a newline or a double space (a common
 * model formatting choice) must not read as a backbone miss for a layout
 * reason (T14a, OQ22). The residual — whether normalisation can mask a genuinely
 * absent fact — is OQ22.
 */
export const normaliseFact = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, ' ').trim();

const containsFact = (answer: string, fact: string): boolean =>
  normaliseFact(answer).includes(normaliseFact(fact));

/*
 * Live responder: a real product model answers with the same system prompt the
 * chat path assembles, block envelope included, so the with-arm is faithful to
 * production. The model is the scheduled eval default (cheapest roster entry)
 * unless `config.memoryEval.responder*` overrides it (T14c) — so a model sweep
 * (OQ24/OQ29) is a config change, not a source edit. The budget is 1024, the
 * production output-token floor, so a fact late in a long answer cannot be
 * truncated out of the arm (OQ34); the finish reason rides back so a `length`
 * stop is recorded per case rather than silently scoring a backbone miss
 * (T14f).
 */
export interface RespondResult {
  content: string;
  finishReason?: string;
}

const defaultRespond = async (query: string, block: string): Promise<RespondResult> => {
  const [{ provider: scheduledProvider, model: scheduledModel }] = resolveScheduledModels({});
  const completion = await inferenceService.createToolFreeCompletion({
    provider: config.memoryEval.responderProvider ?? scheduledProvider,
    model: config.memoryEval.responderModel ?? scheduledModel,
    messages: [
      { role: 'system', content: buildSystemContent(null, true, null, block) },
      { role: 'user', content: query },
    ],
    temperature: config.memoryEval.responderTemperature,
    max_tokens: 1024,
    trace: { tags: ['memory-eval:helpfulness:respond'] },
  });
  return {
    content: completion.choices[0]?.message?.content ?? '',
    finishReason: completion.choices[0]?.finishReason,
  };
};

/*
 * The judge is a reasoning model (`Qwen/Qwen3-235B-A22B-Instruct-2507` since
 * the 2026-10-14 judge-probe sweep); its chain-of-thought counts
 * against `max_tokens`. A 16-token budget truncates the completion to an empty
 * string *before* the verdict token — measured live: `max=16 => ""`,
 * `max=256 => "A"` (OQ21). 512 gives headroom for the reasoning plus the
 * one-token verdict; the preflight (`runJudgePreflight`) fails loudly if a
 * future model change re-breaks this rather than silently scoring `error`.
 */
const JUDGE_MAX_TOKENS = 512;

export const defaultJudge = async (
  query: string,
  answerA: string,
  answerB: string,
): Promise<JudgeVerdict> => {
  const completion = await inferenceService.createToolFreeCompletion({
    provider: config.memoryEval.judgeProvider,
    model: config.memoryEval.judgeModel,
    messages: [{ role: 'user', content: buildJudgePrompt(query, answerA, answerB) }],
    temperature: 0,
    max_tokens: JUDGE_MAX_TOKENS,
    trace: { tags: ['memory-eval:helpfulness:judge'] },
  });
  return parseJudgeVerdict(completion.choices[0]?.message?.content ?? '');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Default inter-call pacing (T15d): a full run makes ~2 responder + ~2 judge
 * calls per judged scenario, which can trip the provider RPM. The delay is
 * config-sourced (`MEMORY_EVAL_PACE_MS`) so the exact budget (OQ32) is a config
 * change; tests inject a no-op.
 */
const defaultPace = async (): Promise<void> => {
  const ms = config.memoryEval.paceMs;
  if (ms > 0) await sleep(ms);
};

/**
 * Stage 3 over the corpus: for each scenario, run both arms, then (when there
 * was a block to inject) score the pair blinded and position-swapped. Scenarios
 * whose retrieval missed by construction carry no block, so there is nothing to
 * A/B — they are recorded with `outcome: null` and excluded from `judged`.
 *
 * Fixtures are cleared in a `finally` (T14e), so a thrown responder/provider
 * error cannot leak seeded rows under the shared `evalUserId`. A thrown judge
 * error is caught per pair into an `error` outcome (T14b), so one dead call does
 * not abort the run (the OQ30 record-and-continue default).
 */
export const runHelpfulnessEval = async (
  deps: HelpfulnessDeps = {},
): Promise<{ results: HelpfulnessCaseResult[]; metrics: HelpfulnessMetrics }> => {
  const scenarios = deps.scenarios ?? MEMORY_SCENARIOS;
  const seed = deps.seed ?? seedMemoryScenario;
  const clear = deps.clear ?? clearMemoryCorpus;
  const retrieve = deps.retrieve ?? retrieveWorkspaceSlices;
  const respond = deps.respond ?? defaultRespond;
  const judge = deps.judge ?? defaultJudge;
  const pace = deps.pace ?? defaultPace;

  const results: HelpfulnessCaseResult[] = [];
  try {
    for (const scenario of scenarios) {
      await clear();
      const idMap = await seed(scenario);
      const picks = await retrieve(scenario.query, evalUserId.toHexString());
      const expectedId = idMap[scenario.expectedSliceId];
      const blockCarriesId = expectedId !== undefined && picks.some((p) => p.id === expectedId);
      const block = buildWorkspaceBlock(scenario.query, picks);
      const factInBlock = containsFact(block, scenario.expectedFact);

      await pace();
      const withResponse = await respond(scenario.query, block);
      const withAnswer = withResponse.content;
      // No block → the two arms are byte-identical, so reuse the answer instead
      // of paying for a duplicate call (and the counterfactual is trivially true).
      let withoutAnswer = withAnswer;
      let withoutFinishReason = withResponse.finishReason;
      if (block.trim()) {
        await pace();
        const withoutResponse = await respond(scenario.query, '');
        withoutAnswer = withoutResponse.content;
        withoutFinishReason = withoutResponse.finishReason;
      }
      const factHitWith = containsFact(withAnswer, scenario.expectedFact);
      const counterfactualHit = containsFact(withoutAnswer, scenario.expectedFact);

      let outcome: PairOutcome | null = null;
      let verdicts: [JudgeVerdict, JudgeVerdict] | undefined;
      if (block.trim()) {
        try {
          await pace();
          const first = await judge(scenario.query, withAnswer, withoutAnswer);
          await pace();
          const second = await judge(scenario.query, withoutAnswer, withAnswer);
          verdicts = [first, second];
          outcome = resolveSwappedOutcome(first, second);
        } catch {
          // A thrown provider error is an `error` pair, not a run abort (T14b).
          outcome = 'error';
        }
      }

      results.push({
        scenarioId: scenario.id,
        category: scenario.category,
        expectedSliceId: scenario.expectedSliceId,
        blockCarriesId,
        factInBlock,
        factHitWith,
        counterfactualHit,
        outcome,
        verdicts,
        finishReasons: { with: withResponse.finishReason, without: withoutFinishReason },
      });
    }
  } finally {
    await clear();
  }
  return { results, metrics: helpfulnessMetrics(results) };
};

/**
 * Live judge preflight (T14d): issue one judge call over a fixed constructed
 * pair (A clearly better than B) in both orders and require a *parseable*
 * verdict — not merely a non-error reply. A truncated reasoning model or an
 * unavailable model therefore fails the preflight rather than silently
 * degrading every verdict to `tie`/`error` (OQ21). Throws on failure so the
 * caller stops instead of substituting a model silently.
 */
export const runJudgePreflight = async (
  judge: (query: string, answerA: string, answerB: string) => Promise<JudgeVerdict> = defaultJudge,
): Promise<{ first: JudgeVerdict; second: JudgeVerdict }> => {
  const query = 'Which answer correctly names the capital of Australia?';
  const good = 'The capital of Australia is Canberra.';
  const bad = 'The capital of Australia is Sydney.';
  const first = await judge(query, good, bad);
  const second = await judge(query, bad, good);
  if (first === 'error' || second === 'error') {
    throw new Error(
      `judge preflight failed: unparseable verdict (first=${first}, second=${second}); ` +
        'the model may be unavailable or the token budget may be truncating it (OQ21)',
    );
  }
  return { first, second };
};
