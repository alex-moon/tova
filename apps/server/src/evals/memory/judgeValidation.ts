import { MEMORY_SCENARIOS } from './corpus';
import type { MemoryScenario } from './types';
import type { JudgeVerdict } from './helpfulnessEval';
import { config } from '../../config';

/*
 * #289 T5 — judge-validation harness. Stage 3 trusts an LLM judge
 * (`Qwen/Qwen3-235B-A22B-Instruct-2507` since the 2026-10-14 judge-probe
 * sweep) to score the holistic helpfulness delta a substring
 * check cannot reach, so the judge must be measured against labels before its
 * win-rate ratifies a bar (the ticket: "validate the judge against ~30–50
 * hand-labelled pairs before trusting it at scale").
 *
 * Two sets, deliberately kept distinct so the honesty is structural, not a
 * comment:
 *
 * - **Constructed** (`provenance: 'constructed'`) — the correct arm is known by
 *   construction: one arm carries the scenario's expected fact, the other does
 *   not. It is intended as a smoke test that the judge is callable and not
 *   position-biased, **not evidence**. The live T5 run showed the judge diverges
 *   from the substring rule on ~1/3 of these pairs (it prefers a fluent refusal
 *   over a terse fact fragment), so it is neither a clean oracle nor a mere echo
 *   of the backbone — see the plan's T5 live-validation note.
 * - **Hand-labelled** (`provenance: 'agent-authored' | 'owner-confirmed'`) — the
 *   non-circular set. The checked-in seed is `agent-authored` and, per OQ1, is
 *   *not* independent evidence until the owner confirms/replaces it; the harness
 *   reports provenance with the number so that is auditable.
 *
 * The judge is scored over three classes (`A`/`B`/`tie`) with exact accuracy and
 * Cohen's kappa. A judge `error` (an empty/unparseable reply or a throw, T14b) is
 * reported as its own count and excluded from the agreement denominator — the
 * same rule the stage-3 win-rate uses (OQ20).
 */

/** The three classes a pair can be labelled with (the judge's non-error verdicts). */
export type JudgeLabelClass = 'A' | 'B' | 'tie';

export interface JudgeLabel {
  id: string;
  query: string;
  answerA: string;
  answerB: string;
  /** Which answer is more helpful, as the label asserts. */
  better: JudgeLabelClass;
  /** Where the label came from; `constructed` is circular (smoke test only). */
  provenance: 'constructed' | 'agent-authored' | 'owner-confirmed';
}

/** expected → predicted counts, including the `error` column (excluded from kappa). */
export type JudgeConfusion = Record<JudgeLabelClass, Record<JudgeVerdict, number>>;

export interface JudgeAgreement {
  /** Labels the judge returned a usable (non-error) verdict for. */
  n: number;
  /** Labels the judge errored on; excluded from `n`. */
  errors: number;
  /** Exact three-class agreement over `n`; 0 when nothing was scored. */
  accuracy: number;
  /** Cohen's kappa over the three classes; null when a class is absent. */
  kappa: number | null;
  confusion: JudgeConfusion;
}

/**
 * Constructed validation pairs, derived from the corpus so they cannot drift from
 * it. Which arm carries the expected fact alternates, so a judge that always
 * answers `A` (position bias) cannot pass the set. The pair is "obvious" by
 * construction — that is the point: it is a callable/position smoke test, not
 * evidence (the hand set is).
 */
export const constructedJudgeLabels = (
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
): JudgeLabel[] =>
  scenarios.map((scenario, index) => {
    const good = `Here is what I found: ${scenario.expectedFact}.`;
    const bad = "I don't have any information about that.";
    const aIsGood = index % 2 === 0;
    return {
      id: `constructed-${scenario.id}`,
      query: scenario.query,
      answerA: aIsGood ? good : bad,
      answerB: aIsGood ? bad : good,
      better: aIsGood ? 'A' : 'B',
      provenance: 'constructed',
    };
  });

/*
 * The checked-in hand-labelled seed (T5). Agent-authored, so per OQ1 it is not
 * independent evidence until the owner confirms or replaces it; the CLI prints
 * the provenance beside the number. Kept small and general (the judge is a
 * general "which answer is more helpful?" comparator, not memory-specific); the
 * owner extends this toward the ticket's ~30–50 pairs. Classes are balanced
 * (A/B/tie all present) so kappa is defined.
 */
export const handJudgeLabels: JudgeLabel[] = [
  {
    id: 'hand-arithmetic',
    query: "What's 17% of 250?",
    answerA: '17% of 250 is 42.5.',
    answerB: '17% of 250 is about 40.',
    better: 'A',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-boil-egg',
    query: 'How do I boil an egg?',
    answerA: 'Boil it.',
    answerB:
      'Bring water to a rolling boil, lower the egg in, cook 6–7 minutes for a jammy yolk, then cool it in ice water.',
    better: 'B',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-greeting',
    query: 'Say hello in French.',
    answerA: 'Bonjour.',
    answerB: 'Bonjour!',
    better: 'tie',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-capital',
    query: 'What is the capital of Australia?',
    answerA: 'Canberra.',
    answerB: 'Sydney is the largest city in Australia.',
    better: 'A',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-false-premise',
    query: 'Why is the sky green?',
    answerA: 'The sky is green because of chlorophyll in the air.',
    answerB:
      "The sky isn't green; it looks blue because shorter wavelengths scatter more (Rayleigh scattering).",
    better: 'B',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-head-injury',
    query: 'My head hurts after a fall — should I just sleep?',
    answerA:
      'A headache after a head injury needs urgent assessment; please seek medical care now.',
    answerB: "Just sleep it off, you'll be fine.",
    better: 'A',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-random-number',
    query: 'Give me a random number.',
    answerA: 'Sure — 47.',
    answerB: "Here's one: 47.",
    better: 'tie',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-booking',
    query: 'Book me a table for two.',
    answerA: 'Done.',
    answerB:
      "I can't book tables, but I can help you draft a call — which restaurant, date, and time?",
    better: 'B',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-unit-conversion',
    query: 'Convert 5 km to miles.',
    answerA: '5 km is about 3.1 miles.',
    answerB: '5 km is about 8 miles.',
    better: 'A',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-synonym',
    query: "What's a good synonym for happy?",
    answerA: 'Glad.',
    answerB: 'Cheerful.',
    better: 'tie',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-boiling-point',
    query: "What's the boiling point of water?",
    answerA: '100.',
    answerB: '100 °C (212 °F) at standard sea-level pressure.',
    better: 'B',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-future-event',
    query: 'Who won the 2099 World Cup?',
    answerA: "That event hasn't happened yet, so there's no winner.",
    answerB: 'Brazil won the 2099 World Cup.',
    better: 'A',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-yellow-leaves',
    query: 'My plant leaves are yellowing. What should I do?',
    answerA: 'Plants can yellow.',
    answerB:
      'Yellowing often means overwatering — check the soil is dry before watering again and ensure the pot drains.',
    better: 'B',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-name-colour',
    query: 'Name a colour.',
    answerA: 'Blue.',
    answerB: 'Red.',
    better: 'tie',
    provenance: 'agent-authored',
  },
  {
    id: 'hand-single-word',
    query: 'Reply with a single word: the opposite of hot.',
    answerA: 'Cold.',
    answerB: "The opposite of hot is cold, and here's why in detail…",
    better: 'A',
    provenance: 'agent-authored',
  },
];

const CLASSES: JudgeLabelClass[] = ['A', 'B', 'tie'];

/** Cohen's kappa over the three label classes; null when a class is absent. */
const cohenKappa = (confusion: JudgeConfusion, n: number): number | null => {
  if (n === 0) return null;
  const rowTotal = (c: JudgeLabelClass): number =>
    CLASSES.reduce((sum, p) => sum + confusion[c][p], 0);
  // The plan's rule: a class with no ground-truth label makes kappa undefined
  // over the three-class space, so report null rather than a misleading number.
  if (CLASSES.some((c) => rowTotal(c) === 0)) return null;
  let diagonal = 0;
  for (const c of CLASSES) diagonal += confusion[c][c];
  const observed = diagonal / n;
  let expected = 0;
  for (const c of CLASSES) {
    const col = CLASSES.reduce((sum, r) => sum + confusion[r][c], 0);
    expected += (rowTotal(c) / n) * (col / n);
  }
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Validation makes one live judge call per pair (~37 across both sets), which can
 * trip the judge provider's RPM just like stage 3 (OQ32). Pace by the same
 * config-sourced `MEMORY_EVAL_PACE_MS`; tests inject a no-op.
 */
export const defaultJudgePace = async (): Promise<void> => {
  const ms = config.memoryEval.judgePaceMs;
  if (ms > 0) await sleep(ms);
};

/**
 * Score a judge against labelled pairs. The judge is called once per pair
 * (validation is not the stage-3 position-swapped A/B). A thrown provider call or
 * an `error` verdict is counted separately and excluded from `n`, accuracy and
 * kappa (the T14b/OQ20 rule), so one dead call does not abort the run.
 */
export const judgeAgreement = async (
  labels: JudgeLabel[],
  judgeFn: (query: string, answerA: string, answerB: string) => Promise<JudgeVerdict>,
  pace: () => Promise<void> = defaultJudgePace,
): Promise<JudgeAgreement> => {
  const confusion: JudgeConfusion = {
    A: { A: 0, B: 0, tie: 0, error: 0 },
    B: { A: 0, B: 0, tie: 0, error: 0 },
    tie: { A: 0, B: 0, tie: 0, error: 0 },
  };
  let n = 0;
  let errors = 0;
  let correct = 0;
  for (const label of labels) {
    await pace();
    let verdict: JudgeVerdict;
    try {
      verdict = await judgeFn(label.query, label.answerA, label.answerB);
    } catch {
      // A thrown provider error is an `error`, not a run abort (T14b/OQ30).
      verdict = 'error';
    }
    confusion[label.better][verdict] += 1;
    if (verdict === 'error') {
      errors += 1;
      continue;
    }
    n += 1;
    if (verdict === label.better) correct += 1;
  }
  return {
    n,
    errors,
    accuracy: n ? correct / n : 0,
    kappa: cohenKappa(confusion, n),
    confusion,
  };
};
