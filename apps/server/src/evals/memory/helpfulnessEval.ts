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

/** The judge's reply for one presentation of a pair. */
export type JudgeVerdict = 'A' | 'B' | 'tie';

/** The with-arm's outcome across the two (position-swapped) presentations. */
export type PairOutcome = 'win' | 'loss' | 'tie';

/**
 * Fold the two position-swapped verdicts into one outcome for the with-arm.
 * `first` is the verdict when the with-arm was presented as A; `second` when it
 * was presented as B. Only an order-consistent win counts as a win; a flip
 * (the judge preferring whichever answer it saw first) is a tie.
 */
export const resolveSwappedOutcome = (first: JudgeVerdict, second: JudgeVerdict): PairOutcome => {
  const withWon = first === 'A' && second === 'B';
  const withoutWon = first === 'B' && second === 'A';
  if (withWon) return 'win';
  if (withoutWon) return 'loss';
  return 'tie';
};

/*
 * The judge prompt is deliberately blind: it names no memory, no block, and no
 * arm. It only says which answer is more helpful, so the judge cannot key on
 * "this one had context". Reasoning models emit chain-of-thought ahead of the
 * token, hence the "ONLY one token" instruction and the last-match parser.
 */
export const buildJudgePrompt = (query: string, answerA: string, answerB: string): string =>
  [
    'You are comparing two assistant answers to the same user question.',
    'Decide which answer is more helpful to the user — correct, relevant, and',
    'appropriately using any context it was given. You are not told how either',
    'answer was produced.',
    'Reply with ONLY one token: A, B, or TIE.',
    '',
    `User question:\n${query}`,
    '',
    `Answer A:\n${answerA}`,
    '',
    `Answer B:\n${answerB}`,
  ].join('\n');

/** Last standalone A/B/TIE token wins; anything unparseable degrades to `tie`. */
export const parseJudgeVerdict = (raw: string): JudgeVerdict => {
  const matches = raw.match(/\b(A|B|TIE)\b/gi);
  if (!matches?.length) return 'tie';
  const last = matches[matches.length - 1].toUpperCase();
  if (last === 'A') return 'A';
  if (last === 'B') return 'B';
  return 'tie';
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
}

export interface HelpfulnessMetrics {
  total: number;
  /** Cases with a non-empty block, i.e. pairs the judge scored. */
  judged: number;
  wins: number;
  losses: number;
  ties: number;
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
}

export const helpfulnessMetrics = (results: HelpfulnessCaseResult[]): HelpfulnessMetrics => {
  let judged = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let blockIds = 0;
  let factHits = 0;
  let counterfactualHits = 0;
  let deterministicWins = 0;
  for (const r of results) {
    if (r.blockCarriesId) blockIds += 1;
    if (r.factHitWith) factHits += 1;
    if (r.counterfactualHit) counterfactualHits += 1;
    if (r.factInBlock && r.factHitWith && !r.counterfactualHit) deterministicWins += 1;
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
    winRate: judged ? (wins + 0.5 * ties) / judged : null,
    blockIdRate: total ? blockIds / total : 0,
    factHitRate: total ? factHits / total : 0,
    counterfactualHits,
    deterministicWins,
  };
};

/* ---------------------------------- runner --------------------------------- */

export interface HelpfulnessDeps {
  scenarios?: MemoryScenario[];
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  /** Answer `query` with `block` injected; `''` is the counterfactual arm. */
  respond?: (query: string, block: string) => Promise<string>;
  /** Return the better answer (`'A'`/`'B'`) or `'tie'` for one blinded presentation. */
  judge?: (query: string, answerA: string, answerB: string) => Promise<JudgeVerdict>;
}

const containsFact = (answer: string, fact: string): boolean =>
  answer.toLowerCase().includes(fact.toLowerCase());

/*
 * Live responder: a real product model answers with the same system prompt the
 * chat path assembles, block envelope included, so the with-arm is faithful to
 * production. The model is the scheduled eval default (cheapest roster entry)
 * unless the caller injects another.
 */
const defaultRespond = async (query: string, block: string): Promise<string> => {
  const [{ provider, model }] = resolveScheduledModels({});
  const completion = await inferenceService.createToolFreeCompletion({
    provider,
    model,
    messages: [
      { role: 'system', content: buildSystemContent(null, null, true, null, block) },
      { role: 'user', content: query },
    ],
    temperature: 0,
    max_tokens: 512,
    trace: { tags: ['memory-eval:helpfulness:respond'] },
  });
  return completion.choices[0]?.message?.content ?? '';
};

const defaultJudge = async (
  query: string,
  answerA: string,
  answerB: string,
): Promise<JudgeVerdict> => {
  const completion = await inferenceService.createToolFreeCompletion({
    provider: config.memoryEval.judgeProvider,
    model: config.memoryEval.judgeModel,
    messages: [{ role: 'user', content: buildJudgePrompt(query, answerA, answerB) }],
    temperature: 0,
    max_tokens: 16,
    trace: { tags: ['memory-eval:helpfulness:judge'] },
  });
  return parseJudgeVerdict(completion.choices[0]?.message?.content ?? '');
};

/**
 * Stage 3 over the corpus: for each scenario, run both arms, then (when there
 * was a block to inject) score the pair blinded and position-swapped. Scenarios
 * whose retrieval missed by construction carry no block, so there is nothing to
 * A/B — they are recorded with `outcome: null` and excluded from `judged`.
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

  const results: HelpfulnessCaseResult[] = [];
  for (const scenario of scenarios) {
    await clear();
    const idMap = await seed(scenario);
    const picks = await retrieve(scenario.query, evalUserId.toHexString());
    const expectedId = idMap[scenario.expectedSliceId];
    const blockCarriesId = expectedId !== undefined && picks.some((p) => p.id === expectedId);
    const block = buildWorkspaceBlock(scenario.query, picks);
    const factInBlock = containsFact(block, scenario.expectedFact);

    const withAnswer = await respond(scenario.query, block);
    // No block → the two arms are byte-identical, so reuse the answer instead
    // of paying for a duplicate call (and the counterfactual is trivially true).
    const withoutAnswer = block.trim() ? await respond(scenario.query, '') : withAnswer;
    const factHitWith = containsFact(withAnswer, scenario.expectedFact);
    const counterfactualHit = containsFact(withoutAnswer, scenario.expectedFact);

    let outcome: PairOutcome | null = null;
    let verdicts: [JudgeVerdict, JudgeVerdict] | undefined;
    if (block.trim()) {
      const first = await judge(scenario.query, withAnswer, withoutAnswer);
      const second = await judge(scenario.query, withoutAnswer, withAnswer);
      verdicts = [first, second];
      outcome = resolveSwappedOutcome(first, second);
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
    });
  }
  await clear();
  return { results, metrics: helpfulnessMetrics(results) };
};
