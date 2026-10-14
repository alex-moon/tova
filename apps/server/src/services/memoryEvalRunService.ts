/*
 * #289 T6: the persisted rollup for the workspace-memory eval. Mirrors
 * `evalRunService` (same `evalruns` collection, same global lease) but writes
 * `kind:'memory'` with a continuous `metrics` payload, because precision /
 * recall@k / win-rate do not map onto the per-case `pass|partial|fail|error`
 * scores. Per-case rows reuse the existing `results` shape with the sentinel
 * `model`/`provider` `'memory'`, so the tool-use contract is untouched.
 *
 * The lease stays **global** (D14, corrected): the memory and tool-use suites
 * share one reserved `evalUserId`, so they must never overlap. Kind-scoping the
 * lease would permit exactly the concurrency that clobbers fixtures; only
 * idempotency (the scheduler, T8) is kind-aware.
 *
 * Dependencies are injectable so the flow is unit-testable without Mongo or
 * live providers (same seam style as `evalRunService`).
 */
import type { AdminEvalMemoryMetrics } from '@tova/shared';
import { config } from '../config';
import {
  memoryCorpusHash,
  runMemoryEvals,
  type GateCaseResult,
  type MemoryEvalReport,
  type MemoryEvalStage,
  type RetrievalCaseResult,
} from '../evals/memory/memoryEvalService';
import { EvalRunRecord } from '../models/EvalRunRecord';
import { EvalRunBusyError, resolveScheduledModels } from './evalRunService';

const MAX_STORED_ERROR_CHARS = 500;

export interface StartMemoryEvalRunOptions {
  /** Which deterministic stages to run; a scheduled run passes `['retrieval']`. */
  stages: MemoryEvalStage[];
  trigger: 'scheduled' | 'manual';
}

export interface MemoryEvalRunDeps {
  run?: (stages: MemoryEvalStage[]) => Promise<MemoryEvalReport>;
  createRecord?: typeof EvalRunRecord.create;
  findRunning?: () => Promise<unknown | null>;
  updateRecord?: (id: unknown, update: Record<string, unknown>) => Promise<unknown>;
}

const resolveRunDeps = (deps: MemoryEvalRunDeps) => ({
  createRecord: deps.createRecord ?? EvalRunRecord.create.bind(EvalRunRecord),
  findRunning:
    deps.findRunning ?? (() => EvalRunRecord.findOne({ status: 'running' }).lean().exec()),
  updateRecord:
    deps.updateRecord ?? ((id, update) => EvalRunRecord.updateOne({ _id: id }, update).exec()),
  run: deps.run ?? ((stages: MemoryEvalStage[]) => runMemoryEvals({}, stages)),
});

/*
 * The per-case drill-down. `score` is the closest `pass|partial|fail|error`
 * reading of the case's assertion: a gate case passes when the vote matches the
 * hand label (a provider failure is `error`); a retrieval case passes when
 * surfacing matches `expectSurfaced`. The authoritative rates live in
 * `metrics`; these rows are only for the admin drill-down.
 */
const gateScore = (r: GateCaseResult): 'pass' | 'fail' | 'error' =>
  r.failed ? 'error' : r.pass ? 'pass' : 'fail';

const gateRow = (r: GateCaseResult) => ({
  caseId: `gate:${r.caseId}`,
  model: 'memory',
  provider: 'memory',
  score: gateScore(r),
  report: `expected=${r.expected} observed=${r.observed}${r.subtype ? ` subtype=${r.subtype}` : ''}`,
});

const retrievalRow = (r: RetrievalCaseResult) => ({
  caseId: `retrieval:${r.scenarioId}`,
  model: 'memory',
  provider: 'memory',
  score: r.pass ? 'pass' : 'fail',
  report: `category=${r.category} expected=${r.expected} surfaced=${r.surfaced}`,
});

const buildMetrics = (
  report: MemoryEvalReport,
  stages: MemoryEvalStage[],
): AdminEvalMemoryMetrics => {
  const [responder] = resolveScheduledModels({});
  const metrics: AdminEvalMemoryMetrics = {
    stages,
    corpusHash: memoryCorpusHash(),
    gateModel: config.aux.model,
    gateProvider: config.aux.provider,
    responderModel: config.memoryEval.responderModel ?? responder.model,
    responderProvider: config.memoryEval.responderProvider ?? responder.provider,
    judgeModel: config.memoryEval.judgeModel,
    judgeProvider: config.memoryEval.judgeProvider,
  };
  if (report.gate) metrics.gate = report.gate.metrics;
  if (report.retrieval) metrics.retrieval = report.retrieval.metrics;
  return metrics;
};

/**
 * Writes the `running` lease for a memory run and returns its id. Rejects with
 * `EvalRunBusyError` when **any** run (of either kind) is live — the global
 * lease (D14).
 */
export const beginMemoryEvalRun = async (
  options: StartMemoryEvalRunOptions,
  deps: MemoryEvalRunDeps = {},
): Promise<string> => {
  const { createRecord, findRunning } = resolveRunDeps(deps);
  if (await findRunning()) throw new EvalRunBusyError();
  const record = await createRecord({
    startedAt: new Date(),
    status: 'running',
    kind: 'memory',
    models: ['memory'],
    stages: options.stages,
  });
  return String((record as { _id: unknown })._id);
};

/**
 * Runs the requested stages for an existing lease and settles the document to
 * `done`/`error`. A run-level crash is recorded, never thrown (mirrors
 * `executeEvalRun`).
 */
export const executeMemoryEvalRun = async (
  id: string,
  options: StartMemoryEvalRunOptions,
  deps: MemoryEvalRunDeps = {},
): Promise<MemoryEvalReport> => {
  const { updateRecord, run } = resolveRunDeps(deps);
  const { stages } = options;
  try {
    const report = await run(stages);
    const results = [
      ...(report.gate?.results ?? []).map(gateRow),
      ...(report.retrieval?.results ?? []).map(retrievalRow),
    ];
    await updateRecord(id, {
      $set: {
        status: 'done',
        finishedAt: new Date(),
        stages,
        results,
        metrics: buildMetrics(report, stages),
      },
    });
    return report;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_STORED_ERROR_CHARS,
    );
    await updateRecord(id, { $set: { status: 'error', finishedAt: new Date(), error: message } });
    return {};
  }
};

/** Persists and executes one memory run (global lease + kind-scoped record). */
export const startMemoryEvalRun = async (
  options: StartMemoryEvalRunOptions,
  deps: MemoryEvalRunDeps = {},
): Promise<{ id: string; report: MemoryEvalReport }> => {
  const id = await beginMemoryEvalRun(options, deps);
  const report = await executeMemoryEvalRun(id, options, deps);
  return { id, report };
};
