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

// Memory-eval runner over the corpus: stage 2 scores retrieval hit-rate; dependencies injectable for tests.
// @see #289 #310 #305

export interface RetrievalCaseResult {
  scenarioId: string;
  category: ScenarioCategory;
  expected: boolean;
  surfaced: boolean;
  /** surfaced === expected (the corpus's own expectation is met). */
  pass: boolean;
  expectedSliceId: string;
  surfacedIds: string[];
  /** Candidates existed but the rerank cut removed every one (graceful-refusal path). */
  // @see #305
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
  /** Raw surfacing rate. */
  // @see #293 #294
  surfacedRate: number;
  /** How many retrieval cases ended empty-after-cut (graceful refusal). */
  // @see #305
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
    /** Whether the workspace-memory flag was on; false is the BM25 baseline, degradation shows in the delta. */
    // @see #293
    vectorEnabled: boolean;
  };
}

// Default per-scenario embedding: backfills the seeded slices when the flag is on (no-op off); best-effort.
const defaultEmbedUser = async (userId: string): Promise<void> => {
  if (!isWorkspaceMemoryEnabled()) return;
  await embedWorkspaceUser(userId);
};

// Live default reports cut diagnostics so the run can count empty-after-cut cases.
// @see #305
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
  // Clear in a `finally`: a thrown error must not leak seeded rows into the next run.
  try {
    for (const scenario of scenarios) {
      // Reseed per scenario so one scenario's slices cannot contaminate another.
      await clear();
      const idMap = await seed(scenario);
      // Embed after seed and before retrieve: the next scenario's clear would wipe a one-off embedding.
      try {
        await embed(evalUserId.toHexString());
      } catch (err) {
        console.error('Memory eval embedding degraded to BM25:', err);
      }
      const picks = await retrieve(scenario.query, evalUserId.toHexString());
      const surfacedIds = picks.map((slice) => slice.id);
      const expectedId = idMap[scenario.expectedSliceId];
      const surfaced = expectedId !== undefined && surfacedIds.includes(expectedId);
      // Empty-after-cut diagnostic; only measurable on the default live retrieve.
      // @see #305
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

/** Runs the requested deterministic stages; stage 3 is manual-only and not part of this runner. */
// @see #310
export const runMemoryEvals = async (
  deps: MemoryEvalDeps = {},
  stages: MemoryEvalStage[] = ['retrieval'],
): Promise<MemoryEvalReport> => {
  const report: MemoryEvalReport = {};
  if (stages.includes('retrieval')) report.retrieval = await runRetrievalEval(deps);
  return report;
};

/** Deterministic JSON with recursively sorted object keys, so hashes are property-order independent. */
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

/** SHA-256 over the canonical gate + retrieval corpus, so corpus changes are visible, not silent. */
export const memoryCorpusHash = (
  gateCases: GateCase[] = GATE_CASES,
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
): string => createHash('sha256').update(canonicalJson({ gateCases, scenarios })).digest('hex');

export const MEMORY_DATASET_NAME = 'tova-memory-evals';

// Load the corpus into LangSmith as a dataset (created when absent, one example per case); best-effort.
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
      // `subtype` rides the example so consumers can stratify recall per subtype.
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
