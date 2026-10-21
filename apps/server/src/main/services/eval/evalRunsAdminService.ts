/* Read side for the admin Evals tab: stored rollups → wire shapes. */
// @see #225
import { EvalRunRecord, type EvalRunRecordDocument } from '../../models/EvalRunRecord';
import type {
  AdminEvalCaseResult,
  AdminEvalMemoryMetrics,
  AdminEvalRunDetail,
  AdminEvalRunKind,
  AdminEvalRunSummary,
  AdminEvalScoreCounts,
} from '@tova/shared';

const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export const clampLimit = (value: number | undefined): number => {
  if (!Number.isInteger(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value as number));
};

const emptyCounts = (): AdminEvalScoreCounts => ({ pass: 0, partial: 0, fail: 0, error: 0 });

// Set membership, not `score in counts`: `in` walks the prototype chain.
const KNOWN_SCORES = new Set<keyof AdminEvalScoreCounts>(['pass', 'partial', 'fail', 'error']);

const countScores = (results: EvalRunRecordDocument['results']): AdminEvalScoreCounts => {
  const counts = emptyCounts();
  for (const result of results) {
    const score = result.score as keyof AdminEvalScoreCounts;
    if (KNOWN_SCORES.has(score)) counts[score] += 1;
    else counts.error += 1;
  }
  return counts;
};

const toSummary = (doc: EvalRunRecordDocument): AdminEvalRunSummary => ({
  id: String(doc._id),
  startedAt: doc.startedAt.toISOString(),
  finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
  status: doc.status,
  models: doc.models,
  // Old rows predate the field; a missing value reads as tool-use.
  kind: (doc.kind ?? 'tool-use') as AdminEvalRunKind,
  counts: countScores(doc.results),
  total: doc.results.length,
  error: doc.error ?? null,
});

export const listEvalRuns = async (limit?: number): Promise<AdminEvalRunSummary[]> => {
  const docs = await EvalRunRecord.find().sort({ startedAt: -1 }).limit(clampLimit(limit)).exec();
  return docs.map(toSummary);
};

export const getEvalRun = async (id: string): Promise<AdminEvalRunDetail | null> => {
  const doc = await EvalRunRecord.findById(id).exec();
  if (!doc) return null;
  const results: AdminEvalCaseResult[] = doc.results.map((result) => ({
    caseId: result.caseId,
    model: result.model,
    provider: result.provider,
    score: result.score as AdminEvalCaseResult['score'],
    report: result.report,
  }));
  return {
    ...toSummary(doc),
    results,
    // Only memory runs carry a continuous rollup; a tool-use run has none.
    metrics: (doc.metrics as AdminEvalMemoryMetrics | null | undefined) ?? null,
  };
};
