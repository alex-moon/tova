import mongoose from 'mongoose';

// Cached LangSmith per-model rollup from the background poller.
// @see #224
const modelStatSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    // Pre-provider-rollup rows read back as null (model-only fallback).
    // @see #237
    provider: { type: String, default: null },
    calls: { type: Number, required: true },
    errors: { type: Number, required: true },
    avgDurationMs: { type: Number, default: null },
    // Mean TTFT across the row's streamed calls.
    // @see #237
    avgTtftMs: { type: Number, default: null },
    totalTokens: { type: Number, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
  },
  // `errors` is a Mongoose reserved pathname; wire name kept.
  { _id: false, suppressReservedKeysWarning: true },
);

const traceStatsCacheSchema = new mongoose.Schema(
  {
    // Stable key for the window, e.g. `days=7`. Unique so a tick can upsert.
    windowKey: { type: String, required: true },
    days: { type: Number, required: true },
    since: { type: String, required: true },
    // When the poller last wrote the rollup; staleness is measured from here.
    computedAt: { type: Date, required: true },
    models: { type: [modelStatSchema], default: [] },
    totals: {
      calls: { type: Number, required: true },
      errors: { type: Number, required: true },
      totalTokens: { type: Number, required: true },
      inputTokens: { type: Number, required: true },
      outputTokens: { type: Number, required: true },
    },
  },
  { timestamps: true },
);

traceStatsCacheSchema.index({ windowKey: 1 }, { unique: true });

export type TraceStatsCacheDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof traceStatsCacheSchema>
>;

export const TraceStatsCache = mongoose.model('TraceStatsCache', traceStatsCacheSchema);

export const windowKeyFor = (days: number): string => `days=${days}`;
