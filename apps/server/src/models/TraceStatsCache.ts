import mongoose from 'mongoose';

// Issue #224: cached LangSmith per-model rollup. The admin Traces summary is
// expensive to compute (a paged live sweep of up to 500 llm runs against a
// burstily rate-limited API), so a background poller computes it every ~120s
// and upserts one document per window here. The stats route reads this
// document instead of hitting LangSmith on the happy path.
//
// One row per `windowKey` (e.g. `days=7`) so windows can diverge later; today
// only the default 7-day window is written. The token split is stored, cost is
// NOT: prices are joined at read time so a price correction shows up without
// waiting for the next poll (#224 decision 4).
const modelStatSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    // #237: the provider this row covers. Absent on rows written before the
    // provider rollup; read back as null (model-only fallback).
    provider: { type: String, default: null },
    calls: { type: Number, required: true },
    errors: { type: Number, required: true },
    avgDurationMs: { type: Number, default: null },
    // #237: mean TTFT across the row's streamed calls.
    avgTtftMs: { type: Number, default: null },
    totalTokens: { type: Number, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
  },
  // `errors` collides with a Mongoose reserved pathname; the name matches the
  // wire contract (`AdminLangsmithModelStats`) so keep it and opt out of the
  // warning rather than map a rename.
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
