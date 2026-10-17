import mongoose from 'mongoose';

// Computed eval rollup: one document per suite execution; `status: 'running'` is the serialisation lease.
// @see #225 #179 #186
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
  // One collection serves both eval suites; existing rows default to `tool-use`.
  // @see #289
  kind: {
    type: String,
    enum: ['tool-use', 'memory'],
    default: 'tool-use',
  },
  models: {
    type: [String],
    default: [],
  },
  // Memory stages the run executed; kept so a partial scheduled run is explicit.
  stages: {
    type: [String],
    default: [],
  },
  // Continuous memory rollup that doesn't fit the per-case `results` scores.
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  // Per-case outcomes; `report` is the graded assertion summary or the ungraded error message.
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
// Kind-scoped idempotency: a tool-use run must not suppress the memory run.
// @see #289
evalRunRecordSchema.index({ kind: 1, startedAt: -1 });

export type EvalRunRecordDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof evalRunRecordSchema>
>;

// Explicit collection name: the migration pre-created `evalruns`; Mongoose would pluralise differently.
export const EvalRunRecord = mongoose.model('EvalRunRecord', evalRunRecordSchema, 'evalruns');
