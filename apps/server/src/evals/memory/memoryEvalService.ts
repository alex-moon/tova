import { createHash } from 'node:crypto';
import type { Client } from 'langsmith';
import {
  classifyFileIntentForEval,
  isEnrichmentEnabled,
  type EnrichmentProbe,
} from '../../services/enrichmentService';
import { config } from '../../config';
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
  /** The provider call failed (a throw or a timeout); excluded from metrics (T15b). */
  failed?: boolean;
  /** The provider call hit the enrichment timeout cap (T15b/OQ33). */
  timeout?: boolean;
}

/*
 * #289 T15a: the gate eval reads the live enrichment classifier, and the
 * production path (`enrichmentVotes`) returns all-false when `ENRICHMENT_ENABLED`
 * is off. Running the gate with enrichment off would post a 0% recall that looks
 * like a gate failure but is a misconfiguration, so fail loudly instead of
 * silently reporting a 0% gate.
 */
export const assertEnrichmentEnabled = (): void => {
  if (!isEnrichmentEnabled()) {
    throw new Error(
      'memory gate eval requires ENRICHMENT_ENABLED; enrichmentVotes returns all-false when off, ' +
        'which would score recall 0',
    );
  }
};

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
  /** Cases with a usable vote (total minus errors and timeouts). */
  evaluated: number;
  truePos: number;
  falsePos: number;
  trueNeg: number;
  falseNeg: number;
  /** tp / (tp + fp); null when the gate never fired (no positive predictions). */
  precision: number | null;
  /** tp / (tp + fn); null when there are no positive labels. */
  recall: number | null;
  /** Fraction of evaluated turns the gate fired on (the base-rate companion). */
  fireRate: number;
  /** Provider failures (a thrown call), excluded from precision/recall (T15b). */
  errors: number;
  /** Provider timeouts (the ENRICHMENT_TIMEOUT_MS cap), excluded (T15b/OQ33). */
  timeouts: number;
  /** Recall per refer-back subtype, so a bar can be set per subtype (T1b-i/OQ12). */
  recallBySubtype: Record<string, SubtypeRecall>;
}

export const gateMetrics = (results: GateCaseResult[]): GateMetrics => {
  let truePos = 0;
  let falsePos = 0;
  let trueNeg = 0;
  let falseNeg = 0;
  let errors = 0;
  let timeouts = 0;
  const bySubtype: Record<string, { total: number; truePos: number; falseNeg: number }> = {};
  for (const r of results) {
    // A provider failure is not a "no": count it separately and drop it from the
    // confusion matrix so it cannot inflate false negatives (T15b, OQ11/OQ33).
    if (r.failed) {
      if (r.timeout) timeouts += 1;
      else errors += 1;
      continue;
    }
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
  const evaluated = results.length - errors - timeouts;
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
    evaluated,
    truePos,
    falsePos,
    trueNeg,
    falseNeg,
    precision: positives ? truePos / positives : null,
    recall: labelled ? truePos / labelled : null,
    fireRate: evaluated ? positives / evaluated : 0,
    errors,
    timeouts,
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
  gateCases?: GateCase[];
  scenarios?: MemoryScenario[];
  /** Defaults to the strict eval probe; injected in tests. */
  classify?: (
    prompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
  ) => Promise<EnrichmentProbe>;
  /** Defaults to the real retrieval read; injected in tests. */
  retrieve?: (query: string, userId: string) => Promise<WorkspaceSlice[]>;
  seed?: (scenario: MemoryScenario) => Promise<SeedIdMap>;
  clear?: () => Promise<void>;
  /** Inter-call delay before each live gate call (T15c); injected in tests. */
  pace?: () => Promise<void>;
  /** Embeds the eval user's corpus after seeding; injected in tests. */
  embed?: (userId: string) => Promise<void>;
}

export interface MemoryEvalReport {
  /** Absent when the run's `stages` selector excluded the gate. */
  gate?: { results: GateCaseResult[]; metrics: GateMetrics };
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * #289 T15c: a 36-case gate burst can trip the aux provider's RPM, and (before
 * T15b) a 429 was silently scored as a false negative. Pace each call so the run
 * stays under the limit; the delay is config-sourced
 * (`MEMORY_EVAL_GATE_PACE_MS`) so the budget is a config change (OQ32). No retry
 * by default: a 429 is still recorded as `failed` (T15b), not masked.
 */
const defaultGatePace = async (): Promise<void> => {
  const ms = config.memoryEval.gatePaceMs;
  if (ms > 0) await sleep(ms);
};

export const runGateEval = async (
  deps: MemoryEvalDeps = {},
): Promise<{ results: GateCaseResult[]; metrics: GateMetrics }> => {
  // T15a: fail loudly rather than post a 0% gate when enrichment is off.
  assertEnrichmentEnabled();
  const cases = deps.gateCases ?? GATE_CASES;
  const classify = deps.classify ?? classifyFileIntentForEval;
  const pace = deps.pace ?? defaultGatePace;
  const results: GateCaseResult[] = [];
  for (const testCase of cases) {
    await pace();
    const probe = await classify(testCase.prompt, testCase.history ?? []);
    if (probe.outcome !== 'ok') {
      // Record the failure distinctly (T15b): `observed:false` is a placeholder,
      // not a vote — `gateMetrics` excludes `failed` rows from the matrix.
      results.push({
        caseId: testCase.id,
        expected: testCase.refersBack,
        observed: false,
        pass: false,
        subtype: testCase.subtype,
        failed: true,
        timeout: probe.outcome === 'timeout',
      });
      continue;
    }
    const observed = probe.workspace;
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
export type MemoryEvalStage = 'gate' | 'retrieval';

/**
 * Runs the requested deterministic stages, in order. Stage 3 (judge) is
 * manual-only and not part of this runner. The `stages` selector exists so a
 * scheduled run can take **retrieval only** without making the 36 live gate
 * calls unattended (D13/OQ26). Defaults to both, the manual-CLI shape.
 */
export const runMemoryEvals = async (
  deps: MemoryEvalDeps = {},
  stages: MemoryEvalStage[] = ['gate', 'retrieval'],
): Promise<MemoryEvalReport> => {
  const report: MemoryEvalReport = {};
  if (stages.includes('gate')) report.gate = await runGateEval(deps);
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
