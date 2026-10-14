import mongoose from 'mongoose';

// Computed eval rollup (#225), house style of ModelMetricStat: one document
// per execution of the deterministic eval suite (`apps/server/src/evals/`), across
// one or more models. Written by evalRunService; read by the admin Evals tab
// so a page load never re-queries LangSmith (the #179/#186 "stored so a
// deploy does not wipe it" rationale). `status: 'running'` is the serialisation
// lease (Decision 6); a stranded row is reclaimed by the scheduler's stale
// sweep (mirrors requeueStaleAssetJobs).
const evalRunRecordSchema = new mongoose.Schema({
  startedAt: {
    type: Date,
    required: true,
  },
  finishedAt: {
    type: Date,
    default: null,
  },
  status: {
    type: String,
    enum: ['running', 'done', 'error'],
    default: 'running',
  },
  error: {
    type: String,
    default: null,
  },
  // #289 D9: one collection serves both eval suites. `kind` disambiguates a
  // memory run from the tool-use golden suite; existing rows default to
  // `tool-use` (the migration backfills the same on deployed docs).
  kind: {
    type: String,
    enum: ['tool-use', 'memory'],
    default: 'tool-use',
  },
  models: {
    type: [String],
    default: [],
  },
  // Which memory stages a run executed (`['gate','retrieval']`); empty for a
  // tool-use run. Kept on the record so a partial scheduled run is explicit.
  stages: {
    type: [String],
    default: [],
  },
  // Continuous memory rollup (precision/recall@k/win-rate) that does not fit the
  // per-case `results` scores. `Mixed` preserves the run service's typed payload
  // as written; the read side projects it into `AdminEvalMemoryMetrics`.
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  // Per-case outcomes: caseId + model + provider + score + report. `report`
  // is the graded assertion summary (or the ungraded error message).
  results: {
    type: [
      {
        _id: false,
        caseId: { type: String, required: true },
        model: { type: String, required: true },
        provider: { type: String, required: true },
        score: { type: String, required: true },
        report: { type: String, default: '' },
      },
    ],
    default: [],
  },
});

// List query: newest first.
evalRunRecordSchema.index({ startedAt: -1 });
// Idempotency / catch-up check: "is there a run in this window?".
evalRunRecordSchema.index({ status: 1, startedAt: -1 });
// #289 D14: kind-scoped idempotency, so a tool-use run today does not suppress
// the memory run (and vice versa).
evalRunRecordSchema.index({ kind: 1, startedAt: -1 });

export type EvalRunRecordDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof evalRunRecordSchema>
>;

// Explicit collection name: the migration (`create-eval-runs`) and the
// documented rollup name is `evalruns`; Mongoose would otherwise pluralise the
// model to `evalrunrecords` and leave the pre-created collection/index unused.
export const EvalRunRecord = mongoose.model('EvalRunRecord', evalRunRecordSchema, 'evalruns');
