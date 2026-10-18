/* Memory-eval rollup: mirrors evalRunService but writes kind 'memory'. */
// @see #289
import type { AdminEvalMemoryMetrics } from '@tova/shared';
import { config } from '../config';
import {
  memoryCorpusHash,
  runMemoryEvals,
  type MemoryEvalReport,
  type MemoryEvalStage,
  type RetrievalCaseResult,
} from '../evals/memory/memoryEvalService';
import { EvalRunRecord } from '../models/EvalRunRecord';
import { EvalRunBusyError, resolveScheduledModels } from './evalRunService';

const MAX_STORED_ERROR_CHARS = 500;

export interface StartMemoryEvalRunOptions {
  /** Which deterministic stages to run; scheduled runs pass 'retrieval'. */
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

/* Per-case drill-down: score is the pass/fail proxy; rates live in metrics. */
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
    responderModel: config.memoryEval.responderModel ?? responder.model,
    responderProvider: config.memoryEval.responderProvider ?? responder.provider,
    judgeModel: config.memoryEval.judgeModel,
    judgeProvider: config.memoryEval.judgeProvider,
  };
  if (report.retrieval) metrics.retrieval = report.retrieval.metrics;
  return metrics;
};

/** Writes the running lease; rejects with EvalRunBusyError when busy. */
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

/** Runs the stages and settles the lease; a crash is recorded, not thrown. */
export const executeMemoryEvalRun = async (
  id: string,
  options: StartMemoryEvalRunOptions,
  deps: MemoryEvalRunDeps = {},
): Promise<MemoryEvalReport> => {
  const { updateRecord, run } = resolveRunDeps(deps);
  const { stages } = options;
  try {
    const report = await run(stages);
    const results = [...(report.retrieval?.results ?? []).map(retrievalRow)];
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

/** Persists and executes one memory run (global lease, kind-scoped). */
export const startMemoryEvalRun = async (
  options: StartMemoryEvalRunOptions,
  deps: MemoryEvalRunDeps = {},
): Promise<{ id: string; report: MemoryEvalReport }> => {
  const id = await beginMemoryEvalRun(options, deps);
  const report = await executeMemoryEvalRun(id, options, deps);
  return { id, report };
};
