import mongoose from 'mongoose';

// Eval rollup: one doc per suite run; `status: 'running'` is the lease.
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
  // One collection serves both suites; old rows default to `tool-use`.
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
  // Memory stages executed; makes a partial scheduled run explicit.
  stages: {
    type: [String],
    default: [],
  },
  // Continuous memory rollup that doesn't fit the per-case `results` scores.
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  // Per-case outcomes; `report` is the assertion summary or the error.
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
// Atomic lease: at most one running row, any kind. @see #394
evalRunRecordSchema.index(
  { status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'running' },
    name: 'evalruns_running_lease',
  },
);

export type EvalRunRecordDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof evalRunRecordSchema>
>;

// Explicit collection name: the migration pre-created `evalruns`.
export const EvalRunRecord = mongoose.model('EvalRunRecord', evalRunRecordSchema, 'evalruns');
