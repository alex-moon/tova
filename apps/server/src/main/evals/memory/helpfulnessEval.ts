import { buildSystemContent } from '../../services/promptAssembly';
import { sleep } from '../../services/sleep';
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
import { defaultEmbedUser } from './memoryEvalService';
import { clearMemoryCorpus, seedMemoryScenario, type SeedIdMap } from './memorySource';
import type { MemoryScenario, ScenarioCategory } from './types';
import { z } from 'zod';

// Stage 3 helpfulness eval: with/without the retrieved block, blinded judge.
// @see #289

/** The judge's reply for one presentation; an error must not score a win. */
export type JudgeVerdict = 'A' | 'B' | 'tie' | 'error';

/** The with-arm's outcome across the two (position-swapped) presentations. */
export type PairOutcome = 'win' | 'loss' | 'tie' | 'error';

/** Fold the two position-swapped verdicts into one with-arm outcome. */
export const resolveSwappedOutcome = (first: JudgeVerdict, second: JudgeVerdict): PairOutcome => {
  if (first === 'error' || second === 'error') return 'error';
  const withWon = first === 'A' && second === 'B';
  const withoutWon = first === 'B' && second === 'A';
  if (withWon) return 'win';
  if (withoutWon) return 'loss';
  return 'tie';
};

// Judge prompt is blind to arm and prefers specificity over fluency.
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
    '',
    `User question:\n${query}`,
    '',
    `Answer A:\n${answerA}`,
    '',
    `Answer B:\n${answerB}`,
  ].join('\n');

export interface HelpfulnessCaseResult {
  scenarioId: string;
  category: ScenarioCategory;
  expectedSliceId: string;
  /** Retrieval surfaced the expected slice (the block would carry its id). */
  blockCarriesId: boolean;
  factInBlock: boolean;
  factHitWith: boolean;
  /** The without-arm answer already carries the fact. */
  counterfactualHit: boolean;
  /** Pairwise outcome for the with-arm; null when no block injected. */
  outcome: PairOutcome | null;
  /** Raw verdicts `[with-arm-as-A, with-arm-as-B]`, when judged. */
  verdicts?: [JudgeVerdict, JudgeVerdict];
  /** Responder finish reasons per arm; `length` = budget truncation. */
  finishReasons?: { with?: string; without?: string };
}

export interface HelpfulnessMetrics {
  total: number;
  judged: number;
  wins: number;
  losses: number;
  ties: number;
  /** Pairs where a presentation failed (bad reply or a throw). */
  errors: number;
  /** (wins + 0.5 × ties) / judged; null when nothing was judged. */
  winRate: number | null;
  blockIdRate: number;
  factHitRate: number;
  /** Cases where the without-arm already carried the fact. */
  counterfactualHits: number;
  /** Cases where the with-arm block carried the fact AND the answer did. */
  deterministicWins: number;
  /** Cases where either arm stopped on `length` — a truncation artefact. */
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
    // A `length` stop on either arm is a budget artefact, not a signal.
    if (r.finishReasons?.with === 'length' || r.finishReasons?.without === 'length') {
      truncated += 1;
    }
    // Errors are their own count, excluded from the win-rate denominator.
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

export interface HelpfulnessDeps {
  scenarios?: MemoryScenario[];
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  /** Embeds the seeded corpus between seed and retrieve; off = BM25-only. */
  embed?: (userId: string) => Promise<void>;
  /** Answer `query` with `block` injected; `''` is the counterfactual arm. */
  respond?: (query: string, block: string) => Promise<RespondResult>;
  /** Return the better answer (`'A'`/`'B'`) or `'tie'` for one pair. */
  judge?: (query: string, answerA: string, answerB: string) => Promise<JudgeVerdict>;
  /** Inter-call delay before each live responder/judge call. */
  pace?: () => Promise<void>;
}

/** Casefold and collapse whitespace so layout differences don't misfire. */
export const normaliseFact = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, ' ').trim();

const containsFact = (answer: string, fact: string): boolean =>
  normaliseFact(answer).includes(normaliseFact(fact));

// Live responder: mirrors the chat path's prompt, model and budget.
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

// Judge is a reasoning model: chain-of-thought needs headroom.
const JUDGE_MAX_TOKENS = 512;

// Schema-enforced verdict; validation failure resolves with 'error'.
// @see #368
const VERDICT_SCHEMA = z.object({ verdict: z.enum(['A', 'B', 'tie']) });

export const defaultJudge = async (
  query: string,
  answerA: string,
  answerB: string,
): Promise<JudgeVerdict> => {
  const completion = await inferenceService.createStructuredCompletion({
    provider: config.memoryEval.judgeProvider,
    model: config.memoryEval.judgeModel,
    messages: [{ role: 'user', content: buildJudgePrompt(query, answerA, answerB) }],
    temperature: 0,
    max_tokens: JUDGE_MAX_TOKENS,
    trace: { tags: ['memory-eval:helpfulness:judge'] },
    structuredOutput: {
      schema: VERDICT_SCHEMA,
      fallbackValue: { verdict: 'error' as JudgeVerdict },
      jsonPromptInjection: 'auto',
      errorStrategy: 'fallback',
    },
  });
  return completion.object.verdict;
};

// Config-sourced inter-call pacing to avoid provider RPM trips.
const defaultPace = async (): Promise<void> => {
  const ms = config.memoryEval.paceMs;
  if (ms > 0) await sleep(ms);
};

/** Run both arms per scenario, blinded and position-swapped. */
export const runHelpfulnessEval = async (
  deps: HelpfulnessDeps = {},
): Promise<{ results: HelpfulnessCaseResult[]; metrics: HelpfulnessMetrics }> => {
  const scenarios = deps.scenarios ?? MEMORY_SCENARIOS;
  const seed = deps.seed ?? seedMemoryScenario;
  const clear = deps.clear ?? clearMemoryCorpus;
  const retrieve = deps.retrieve ?? retrieveWorkspaceSlices;
  const embed = deps.embed ?? defaultEmbedUser;
  const respond = deps.respond ?? defaultRespond;
  const judge = deps.judge ?? defaultJudge;
  const pace = deps.pace ?? defaultPace;

  const results: HelpfulnessCaseResult[] = [];
  try {
    for (const scenario of scenarios) {
      await clear();
      const idMap = await seed(scenario);
      // Embed the freshly seeded corpus: without this the with/without arms
      // are graded against a silently degraded BM25-only retriever. @see #394
      try {
        await embed(evalUserId.toHexString());
      } catch (err) {
        console.error('Memory eval embedding degraded to BM25:', err);
      }
      const picks = await retrieve(scenario.query, evalUserId.toHexString());
      const expectedId = idMap[scenario.expectedSliceId];
      const blockCarriesId = expectedId !== undefined && picks.some((p) => p.id === expectedId);
      const block = buildWorkspaceBlock(scenario.query, picks);
      const factInBlock = containsFact(block, scenario.expectedFact);

      await pace();
      const withResponse = await respond(scenario.query, block);
      const withAnswer = withResponse.content;
      // No block → the arms are byte-identical; reuse the answer.
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
          // A thrown provider error is an `error` pair, not a run abort.
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

/** Require a parseable verdict on a fixed pair, both orders. */
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
