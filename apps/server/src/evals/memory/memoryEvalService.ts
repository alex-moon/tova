import type { Client } from 'langsmith';
import { enrichmentVotes } from '../../services/enrichmentService';
import {
  retrieveWorkspaceSlices,
  type WorkspaceSlice,
} from '../../services/workspaceRetrievalService';
import { evalUserId } from '../mongoSource';
import { GATE_CASES, MEMORY_SCENARIOS } from './corpus';
import { clearMemoryCorpus, seedMemoryScenario, type SeedIdMap } from './memorySource';
import type { GateCase, GateSubtype, MemoryScenario, ScenarioCategory } from './types';

/*
 * #289 memory-eval runner: the deterministic stages, over the corpus in
 * `corpus.ts`. Stage 1 scores the gate vote against its hand label; stage 2
 * scores retrieval hit-rate by slice ID. Stage 3 (helpfulness) is encoded in
 * the corpus (`expectedFact`) but its judge runner is a follow-up — the ticket
 * requires the judge to be validated against hand labels before it is trusted.
 *
 * Every dependency is injectable so the logic is unit-testable without Mongo,
 * live providers, or LangSmith (same seam style as `evalRunService`).
 */

/* ------------------------------- stage 1: gate ------------------------------ */

export interface GateCaseResult {
  caseId: string;
  expected: boolean;
  observed: boolean;
  pass: boolean;
  /** Refer-back subtype of a positive; absent on negatives. */
  subtype?: GateSubtype;
}

/** Recall over one refer-back subtype (positives only). */
export interface SubtypeRecall {
  /** Positives of this subtype. */
  total: number;
  truePos: number;
  falseNeg: number;
  /** tp / total; null when the subtype has no cases. */
  recall: number | null;
}

export interface GateMetrics {
  total: number;
  truePos: number;
  falsePos: number;
  trueNeg: number;
  falseNeg: number;
  /** tp / (tp + fp); null when the gate never fired (no positive predictions). */
  precision: number | null;
  /** tp / (tp + fn); null when there are no positive labels. */
  recall: number | null;
  /** Fraction of turns the gate fired on (the base-rate companion to precision). */
  fireRate: number;
  /** Recall per refer-back subtype, so a bar can be set per subtype (T1b-i/OQ12). */
  recallBySubtype: Record<string, SubtypeRecall>;
}

export const gateMetrics = (results: GateCaseResult[]): GateMetrics => {
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;
  const bySubtype: Record<string, { total: number; truePos: number; falseNeg: number }> = {};
  for (const r of results) {
    if (r.expected && r.observed) truePos += 1;
    else if (!r.expected && r.observed) falsePos += 1;
    else if (!r.expected && !r.observed) trueNeg += 1;
    else falseNeg += 1;
    if (r.subtype) {
      const bucket = (bySubtype[r.subtype] ??= { total: 0, truePos: 0, falseNeg: 0 });
      bucket.total += 1;
      if (r.expected && r.observed) bucket.truePos += 1;
      else if (r.expected && !r.observed) bucket.falseNeg += 1;
    }
  }
  const positives = truePos + falsePos;
  const labelled = truePos + falseNeg;
  const recallBySubtype: Record<string, SubtypeRecall> = {};
  for (const [subtype, bucket] of Object.entries(bySubtype)) {
    recallBySubtype[subtype] = {
      ...bucket,
      recall: bucket.total ? bucket.truePos / bucket.total : null,
    };
  }
  return {
    total: results.length,
    truePos,
    falsePos,
    trueNeg,
    falseNeg,
    precision: positives ? truePos / positives : null,
    recall: labelled ? truePos / labelled : null,
    fireRate: results.length ? positives / results.length : 0,
    recallBySubtype,
  };
};

/* ---------------------------- stage 2: retrieval ---------------------------- */

export interface RetrievalCaseResult {
  scenarioId: string;
  category: ScenarioCategory;
  expected: boolean;
  surfaced: boolean;
  /** surfaced === expected (the corpus's own expectation is met). */
  pass: boolean;
  expectedSliceId: string;
  surfacedIds: string[];
}

export interface CategoryMetric {
  total: number;
  surfaced: number;
  expectedMet: number;
}

export interface RetrievalMetrics {
  total: number;
  surfaced: number;
  expectedMet: number;
  /** expectedMet / total — includes the by-construction misses as passes. */
  expectedMetRate: number;
  /** Raw surfacing rate, the number #293/#294 move. */
  surfacedRate: number;
  byCategory: Record<string, CategoryMetric>;
}

export const retrievalMetrics = (results: RetrievalCaseResult[]): RetrievalMetrics => {
  const byCategory: Record<string, CategoryMetric> = {};
  let surfaced = 0;
  let expectedMet = 0;
  for (const r of results) {
    const bucket = (byCategory[r.category] ??= { total: 0, surfaced: 0, expectedMet: 0 });
    bucket.total += 1;
    if (r.surfaced) {
      bucket.surfaced += 1;
      surfaced += 1;
    }
    if (r.pass) {
      bucket.expectedMet += 1;
      expectedMet += 1;
    }
  }
  return {
    total: results.length,
    surfaced,
    expectedMet,
    expectedMetRate: results.length ? expectedMet / results.length : 0,
    surfacedRate: results.length ? surfaced / results.length : 0,
    byCategory,
  };
};

/* ---------------------------------- runner ---------------------------------- */

export interface MemoryEvalDeps {
  gateCases?: GateCase[];
  scenarios?: MemoryScenario[];
  /** Defaults to the live enrichment gate; injected in tests. */
  classify?: (
    prompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ) => Promise<{ files: boolean; workspace: boolean }>;
  /** Defaults to the real retrieval read; injected in tests. */
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
}

export interface MemoryEvalReport {
  gate: { results: GateCaseResult[]; metrics: GateMetrics };
  retrieval: { results: RetrievalCaseResult[]; metrics: RetrievalMetrics };
}

export const runGateEval = async (
  deps: MemoryEvalDeps = {},
): Promise<{ results: GateCaseResult[]; metrics: GateMetrics }> => {
  const cases = deps.gateCases ?? GATE_CASES;
  const classify = deps.classify ?? enrichmentVotes;
  const results: GateCaseResult[] = [];
  for (const testCase of cases) {
    const votes = await classify(testCase.prompt, testCase.history ?? []);
    const observed = votes.workspace;
    results.push({
      caseId: testCase.id,
      expected: testCase.refersBack,
      observed,
      pass: observed === testCase.refersBack,
      subtype: testCase.subtype,
    });
  }
  return { results, metrics: gateMetrics(results) };
};

export const runRetrievalEval = async (
  deps: MemoryEvalDeps = {},
): Promise<{ results: RetrievalCaseResult[]; metrics: RetrievalMetrics }> => {
  const scenarios = deps.scenarios ?? MEMORY_SCENARIOS;
  const retrieve = deps.retrieve ?? retrieveWorkspaceSlices;
  const seed = deps.seed ?? seedMemoryScenario;
  const clear = deps.clear ?? clearMemoryCorpus;
  const results: RetrievalCaseResult[] = [];
  for (const scenario of scenarios) {
    // Reseed per scenario so one scenario's slices cannot contaminate another.
    await clear();
    const idMap = await seed(scenario);
    const picks = await retrieve(scenario.query, evalUserId.toHexString());
    const surfacedIds = picks.map((slice) => slice.id);
    const expectedId = idMap[scenario.expectedSliceId];
    const surfaced = expectedId !== undefined && surfacedIds.includes(expectedId);
    results.push({
      scenarioId: scenario.id,
      category: scenario.category,
      expected: scenario.expectSurfaced,
      surfaced,
      pass: surfaced === scenario.expectSurfaced,
      expectedSliceId: scenario.expectedSliceId,
      surfacedIds,
    });
  }
  await clear();
  return { results, metrics: retrievalMetrics(results) };
};

/** Both deterministic stages, in order. Stage 3 (judge) is a follow-up. */
export const runMemoryEvals = async (deps: MemoryEvalDeps = {}): Promise<MemoryEvalReport> => {
  const gate = await runGateEval(deps);
  const retrieval = await runRetrievalEval(deps);
  return { gate, retrieval };
};

/* ------------------------- LangSmith corpus export -------------------------- */

export const MEMORY_DATASET_NAME = 'tova-memory-evals';

/*
 * Load the corpus into LangSmith as a dataset (mirrors `pushToLangSmith`'s
 * `tova-evals` handling): the dataset is created when absent and reused, one
 * example per scenario and per gate case. This is the "loadable" half — the
 * runner grades locally, and the dataset carries the corpus for inspection and
 * for a future judge run. Best-effort: the caller decides how to surface a
 * failure.
 */
export const pushMemoryCorpusToLangSmith = async (
  client: Client,
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
  gateCases: GateCase[] = GATE_CASES,
): Promise<void> => {
  const ls = client as unknown as {
    hasDataset: (params: { datasetName: string }) => Promise<boolean>;
    createDataset: (name: string) => Promise<{ id: string }>;
    createExample: (
      input: unknown,
      output: unknown,
      opts?: { datasetName: string },
    ) => Promise<unknown>;
  };
  if (!(await ls.hasDataset({ datasetName: MEMORY_DATASET_NAME }))) {
    await ls.createDataset(MEMORY_DATASET_NAME);
  }
  for (const testCase of gateCases) {
    await ls.createExample(
      { stage: 'gate', prompt: testCase.prompt, history: testCase.history ?? [] },
      { refersBack: testCase.refersBack },
      { datasetName: MEMORY_DATASET_NAME },
    );
  }
  for (const scenario of scenarios) {
    await ls.createExample(
      { stage: 'retrieval', seeds: scenario.seeds, query: scenario.query },
      {
        expectedSliceId: scenario.expectedSliceId,
        expectSurfaced: scenario.expectSurfaced,
        expectedFact: scenario.expectedFact,
        category: scenario.category,
      },
      { datasetName: MEMORY_DATASET_NAME },
    );
  }
};
