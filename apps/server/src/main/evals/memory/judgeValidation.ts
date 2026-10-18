import { MEMORY_SCENARIOS } from './corpus';
import type { MemoryScenario } from './types';
import type { JudgeVerdict } from './helpfulnessEval';
import { config } from '../../config';
import { sleep } from '../../services/sleep';

// Judge-validation harness: the judge is measured before its win-rate counts.
// @see #289

/** The three classes a pair can be labelled with. */
export type JudgeLabelClass = 'A' | 'B' | 'tie';

export interface JudgeLabel {
  id: string;
  query: string;
  answerA: string;
  answerB: string;
  /** Which answer is more helpful, as the label asserts. */
  better: JudgeLabelClass;
  /** Where the label came from; `constructed` is circular (smoke). */
  provenance: 'constructed' | 'agent-authored' | 'owner-confirmed';
}

/** expected → predicted counts; the `error` column is outside kappa. */
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

/** Validation pairs derived from the corpus; arm order alternates. */
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

// Agent-authored seed, not evidence until owner-confirmed.
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
  // No ground-truth label makes kappa undefined; report null, not a guess.
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

// One live judge call per pair can trip RPM; paced by the config delay.
export const defaultJudgePace = async (): Promise<void> => {
  const ms = config.memoryEval.judgePaceMs;
  if (ms > 0) await sleep(ms);
};

/** Score a judge against labelled pairs; errors excluded from agreement. */
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
      // A thrown provider error is an `error`, not a run abort.
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
