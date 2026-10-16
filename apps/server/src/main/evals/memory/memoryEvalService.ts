import { createHash } from 'node:crypto';
import type { Client } from 'langsmith';
import {
  collectWorkspaceSlices,
  isWorkspaceMemoryEnabled,
  rankWorkspaceSlicesWithCut,
  type WorkspaceSlice,
} from '../../services/workspaceRetrievalService';
import { embedWorkspaceUser } from '../../services/workspaceEmbeddingIngest';
import { evalUserId } from '../mongoSource';
import { GATE_CASES, MEMORY_SCENARIOS } from './corpus';
import { clearMemoryCorpus, seedMemoryScenario, type SeedIdMap } from './memorySource';
import type { GateCase, MemoryScenario, ScenarioCategory } from './types';

/*
 * #289 memory-eval runner over the corpus in `corpus.ts`. Stage 2 scores
 * retrieval hit-rate by slice ID; stage 3 (helpfulness) is manual-only.
 * #310 retired the gate (stage 1): the aux vote it measured no longer exists —
 * workspace retrieval runs unconditionally and the relevance bar is #305's
 * rerank-and-cut.
 *
 * Every dependency is injectable so the logic is unit-testable without Mongo,
 * live providers, or LangSmith (same seam style as `evalRunService`).
 */

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
  /**
   * #305: candidates existed but the rerank cut removed every one — the
   * graceful-refusal path. Absent when the stage ran with no candidates at all
   * or with the rerank stage disabled.
   */
  cutEmpty?: boolean;
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
  /** #305: how many retrieval cases ended empty-after-cut (graceful refusal). */
  cutEmpty: number;
  byCategory: Record<string, CategoryMetric>;
}

export const retrievalMetrics = (results: RetrievalCaseResult[]): RetrievalMetrics => {
  const byCategory: Record<string, CategoryMetric> = {};
  let surfaced = 0;
  let expectedMet = 0;
  let cutEmpty = 0;
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
    if (r.cutEmpty) cutEmpty += 1;
  }
  return {
    total: results.length,
    surfaced,
    expectedMet,
    expectedMetRate: results.length ? expectedMet / results.length : 0,
    surfacedRate: results.length ? surfaced / results.length : 0,
    cutEmpty,
    byCategory,
  };
};

/* ---------------------------------- runner ---------------------------------- */

export interface MemoryEvalDeps {
  scenarios?: MemoryScenario[];
  /** Defaults to the real retrieval read; injected in tests. */
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  /** Embeds the eval user's corpus after seeding; injected in tests. */
  embed?: (userId: string) => Promise<void>;
}

export interface MemoryEvalReport {
  /** Absent when the run's `stages` selector excluded retrieval. */
  retrieval?: {
    results: RetrievalCaseResult[];
    metrics: RetrievalMetrics;
    /**
     * Whether the vector stage was enabled for this run (the workspace-memory
     * flag). When false the run is the #293 BM25 baseline; when true but the
     * provider/index is unreachable, `vectorCandidates` degrades to BM25 and
     * the stage-2 delta will show it.
     */
    vectorEnabled: boolean;
  };
}

/*
 * Default per-scenario embedding for the semantic measurement: with the flag on
 * this backfills the freshly seeded slices so the vector stage has candidates;
 * with it off it is a no-op (the run is the BM25 baseline). Best-effort — an
 * embedding failure must not abort the run, it just means the vector stage
 * degrades and stage 2 reports the BM25 result.
 */
const defaultEmbedUser = async (userId: string): Promise<void> => {
  if (!isWorkspaceMemoryEnabled()) return;
  await embedWorkspaceUser(userId);
};

/*
 * #305: the live default retrieve reports the cut diagnostics alongside the
 * ranked slices, so the run can count empty-after-cut (graceful refusal) cases.
 */
let lastCutDiagnostics: { candidateCount: number } | null = null;
const defaultLiveRetrieve = async (query: string, userId: string): Promise<WorkspaceSlice[]> => {
  const slices = await collectWorkspaceSlices(userId);
  const { ranked, candidateCount } = await rankWorkspaceSlicesWithCut(query, userId, slices);
  lastCutDiagnostics = { candidateCount };
  return ranked;
};

export const runRetrievalEval = async (
  deps: MemoryEvalDeps = {},
): Promise<{
  results: RetrievalCaseResult[];
  metrics: RetrievalMetrics;
  vectorEnabled: boolean;
}> => {
  const scenarios = deps.scenarios ?? MEMORY_SCENARIOS;
  const retrieve = deps.retrieve ?? defaultLiveRetrieve;
  const seed = deps.seed ?? seedMemoryScenario;
  const clear = deps.clear ?? clearMemoryCorpus;
  const embed = deps.embed ?? defaultEmbedUser;
  const vectorEnabled = isWorkspaceMemoryEnabled();
  const results: RetrievalCaseResult[] = [];
  // Clear in a `finally` (T14e): a thrown seed/retrieve/provider error must not
  // leak seeded rows under the shared `evalUserId` and pollute the next run or
  // the tool-use suite (OQ28).
  try {
    for (const scenario of scenarios) {
      // Reseed per scenario so one scenario's slices cannot contaminate another.
      await clear();
      const idMap = await seed(scenario);
      // Embed *after* seed and *before* retrieve: the runner clears and reseeds
      // inside the loop, so a one-off embedding up front would be wiped by the
      // next scenario's clear.
      try {
        await embed(evalUserId.toHexString());
      } catch (err) {
        console.error('Memory eval embedding degraded to BM25:', err);
      }
      const picks = await retrieve(scenario.query, evalUserId.toHexString());
      const surfacedIds = picks.map((slice) => slice.id);
      const expectedId = idMap[scenario.expectedSliceId];
      const surfaced = expectedId !== undefined && surfacedIds.includes(expectedId);
      // #305: the empty-after-cut diagnostic — candidates existed, the cut took
      // them all. Only measurable on the default live retrieve (an injected
      // stub returns ranked slices only).
      let cutEmpty: boolean | undefined;
      if (retrieve === defaultLiveRetrieve) {
        cutEmpty = (lastCutDiagnostics?.candidateCount ?? 0) > 0 && picks.length === 0;
        lastCutDiagnostics = null;
      }
      results.push({
        scenarioId: scenario.id,
        category: scenario.category,
        expected: scenario.expectSurfaced,
        surfaced,
        pass: surfaced === scenario.expectSurfaced,
        expectedSliceId: scenario.expectedSliceId,
        surfacedIds,
        ...(cutEmpty !== undefined ? { cutEmpty } : {}),
      });
    }
  } finally {
    await clear();
  }
  return { results, metrics: retrievalMetrics(results), vectorEnabled };
};

/** The deterministic memory stages the runner can execute. */
export type MemoryEvalStage = 'retrieval';

/**
 * Runs the requested deterministic stages. Stage 3 (judge) is manual-only and
 * not part of this runner; #310 retired the gate stage (the aux vote it
 * measured no longer exists). The `stages` selector exists so a scheduled run
 * can take **retrieval only** — the only stage there is.
 */
export const runMemoryEvals = async (
  deps: MemoryEvalDeps = {},
  stages: MemoryEvalStage[] = ['retrieval'],
): Promise<MemoryEvalReport> => {
  const report: MemoryEvalReport = {};
  if (stages.includes('retrieval')) report.retrieval = await runRetrievalEval(deps);
  return report;
};

/* ------------------------------ corpus identity ----------------------------- */

/**
 * Deterministic JSON with recursively sorted object keys, so the hash below is
 * independent of property order. The corpus is plain JSON (strings/booleans/
 * numbers/arrays; verified in `types.ts`), so no `Date`/`ObjectId` handling is
 * needed.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * SHA-256 over the canonical gate + retrieval corpus (D15). Recorded on every
 * memory run so a corpus change (a label edit, a new scenario) is visible
 * rather than silent: the baseline a threshold was ratified against can be
 * identified from the hash.
 */
export const memoryCorpusHash = (
  gateCases: GateCase[] = GATE_CASES,
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
): string => createHash('sha256').update(canonicalJson({ gateCases, scenarios })).digest('hex');

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
      // `subtype` (T1b-i) rides the example so a dataset consumer can stratify
      // recall per refer-back subtype, the same split the local metrics report.
      { refersBack: testCase.refersBack, subtype: testCase.subtype },
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
