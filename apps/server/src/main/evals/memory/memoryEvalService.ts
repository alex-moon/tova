import { createHash } from 'node:crypto';
import type { Client } from 'langsmith';
import {
  collectWorkspaceSlices,
  isWorkspaceMemoryEnabled,
  rankWorkspaceSlicesWithCut,
  type WorkspaceSlice,
} from '../../services/workspaceRetrievalService';
import { embedWorkspaceUser } from '../../services/workspaceEmbeddingIngest';
import { asDatasetClient, ensureDataset } from '../../services/langsmithDataset';
import { evalUserId } from '../mongoSource';
import { GATE_CASES, MEMORY_SCENARIOS } from './corpus';
import { clearMemoryCorpus, seedMemoryScenario, type SeedIdMap } from './memorySource';
import type { GateCase, MemoryScenario, ScenarioCategory } from './types';

// Memory-eval runner: stage 2 scores retrieval hit-rate; injectable deps.
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
  /** Candidates existed but the rerank cut removed every one. */
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
  /** Defaults to the live retrieval read; injected in tests. Returns the
   * ranked slices plus optional cut diagnostics — no module-global side
   * channel. @see #394 */
  retrieve?: (query: string, userId: string) => Promise<RetrievedSlices>;
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  /** Embeds the eval user's corpus after seeding; injected in tests. */
  embed?: (userId: string) => Promise<void>;
}

/** Slices plus optional cut diagnostics from the ranking call. */
export interface RetrievedSlices {
  slices: WorkspaceSlice[];
  /** Candidates before the cut; present on the live default only. */
  candidateCount?: number;
}

export interface MemoryEvalReport {
  /** Absent when the run's `stages` selector excluded retrieval. */
  retrieval?: {
    results: RetrievalCaseResult[];
    metrics: RetrievalMetrics;
    /** Workspace-memory flag was on; false is the BM25 baseline. */
    // @see #293
    vectorEnabled: boolean;
  };
}

// Default per-scenario embedding: backfills seeded slices when enabled.
export const defaultEmbedUser = async (userId: string): Promise<void> => {
  if (!isWorkspaceMemoryEnabled()) return;
  await embedWorkspaceUser(userId);
};

// Live default reports cut diagnostics alongside the slices it ranked.
// @see #305 #394
const defaultLiveRetrieve = async (query: string, userId: string): Promise<RetrievedSlices> => {
  const slices = await collectWorkspaceSlices(userId);
  const { ranked, candidateCount } = await rankWorkspaceSlicesWithCut(query, userId, slices);
  return { slices: ranked, candidateCount };
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
  // Clear in a `finally`: an error must not leak rows into the next run.
  try {
    for (const scenario of scenarios) {
      // Reseed per scenario so one scenario's slices cannot leak in.
      await clear();
      const idMap = await seed(scenario);
      // Embed between seed and retrieve: the next clear would wipe it.
      try {
        await embed(evalUserId.toHexString());
      } catch (err) {
        console.error('Memory eval embedding degraded to BM25:', err);
      }
      const picks = await retrieve(scenario.query, evalUserId.toHexString());
      const surfacedIds = picks.slices.map((slice) => slice.id);
      const expectedId = idMap[scenario.expectedSliceId];
      const surfaced = expectedId !== undefined && surfacedIds.includes(expectedId);
      // Empty-after-cut diagnostic: candidates existed but none survived.
      // @see #305 #394
      const cutEmpty =
        typeof picks.candidateCount === 'number' &&
        picks.candidateCount > 0 &&
        picks.slices.length === 0;
      results.push({
        scenarioId: scenario.id,
        category: scenario.category,
        expected: scenario.expectSurfaced,
        surfaced,
        pass: surfaced === scenario.expectSurfaced,
        expectedSliceId: scenario.expectedSliceId,
        surfacedIds,
        cutEmpty,
      });
    }
  } finally {
    await clear();
  }
  return { results, metrics: retrievalMetrics(results), vectorEnabled };
};

/** The deterministic memory stages the runner can execute. */
export type MemoryEvalStage = 'retrieval';

/** Runs the requested deterministic stages; stage 3 is manual-only. */
// @see #310
export const runMemoryEvals = async (
  deps: MemoryEvalDeps = {},
  stages: MemoryEvalStage[] = ['retrieval'],
): Promise<MemoryEvalReport> => {
  const report: MemoryEvalReport = {};
  if (stages.includes('retrieval')) report.retrieval = await runRetrievalEval(deps);
  return report;
};

/** Deterministic JSON with recursively sorted keys, hash-stable. */
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

/** SHA-256 over the gate + retrieval corpus; changes stay visible. */
export const memoryCorpusHash = (
  gateCases: GateCase[] = GATE_CASES,
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
): string => createHash('sha256').update(canonicalJson({ gateCases, scenarios })).digest('hex');

export const MEMORY_DATASET_NAME = 'tova-memory-evals';

// Load the corpus into LangSmith as a dataset; created when absent.
export const pushMemoryCorpusToLangSmith = async (
  client: Client,
  scenarios: MemoryScenario[] = MEMORY_SCENARIOS,
  gateCases: GateCase[] = GATE_CASES,
): Promise<void> => {
  const ls = asDatasetClient(client);
  await ensureDataset(ls, MEMORY_DATASET_NAME);
  // The corpus is static: replace, don't append, or re-runs grow it forever.
  // @see #394
  if (ls.listExamples && ls.deleteExample) {
    for await (const example of ls.listExamples({ datasetName: MEMORY_DATASET_NAME })) {
      await ls.deleteExample(example.id);
    }
  }
  for (const testCase of gateCases) {
    await ls.createExample(
      { stage: 'gate', prompt: testCase.prompt, history: testCase.history ?? [] },
      // `subtype` rides the example so recall can be stratified.
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
