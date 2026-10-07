/*
 * #225 read side for the admin Evals tab: the stored rollup is projected into
 * shared wire shapes here so routes stay thin (same split as
 * langsmithTracesService / adminLangsmith). Reads Mongo only — the tab never
 * re-queries LangSmith per page load (Decision 1).
 */
import { EvalRunRecord, type EvalRunRecordDocument } from '../models/EvalRunRecord';
import type {
  AdminEvalCaseResult,
  AdminEvalRunDetail,
  AdminEvalRunSummary,
  AdminEvalScoreCounts,
} from '../../shared/contracts';

const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export const clampLimit = (value: number | undefined): number => {
  if (!Number.isInteger(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, value as number));
};

const emptyCounts = (): AdminEvalScoreCounts => ({ pass: 0, partial: 0, fail: 0, error: 0 });

const countScores = (results: EvalRunRecordDocument['results']): AdminEvalScoreCounts => {
  const counts = emptyCounts();
  for (const result of results) {
    if (result.score in counts) counts[result.score as keyof AdminEvalScoreCounts] += 1;
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
  return { ...toSummary(doc), results };
};
