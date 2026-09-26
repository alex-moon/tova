import mongoose from 'mongoose';

// #168 per-model endpoint-error diagnostics (Alex, 2026-09-26): deploy wipes
// the logs that would answer "what error shape does this connector emit?",
// so every non-abort completion failure is tallied here, grouped by status
// code when present and by (redacted) message text otherwise — the `key`.
// Sibling of ModelMetricStat (not embedded in providerroutings): the write
// rides the failure hot path, groups are bounded by distinct error shapes,
// and admin reads avoid per-row fan-out. No TTL — bounded by error shapes.
const modelErrorStatSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
  },
  model: {
    type: String,
    required: true,
  },
  // Grouping key: String(statusCode) when a status code is present, else the
  // redacted message text (capped) — never raw provider payloads, which can
  // echo prompt content.
  key: {
    type: String,
    required: true,
  },
  statusCode: {
    type: Number,
  },
  // Redacted, capped sample of the full error for admin display.
  sample: {
    type: String,
    default: '',
  },
  count: {
    type: Number,
    default: 0,
  },
  lastSeenAt: {
    type: Date,
    required: true,
  },
});

modelErrorStatSchema.index({ provider: 1, model: 1, key: 1 }, { unique: true });

export const ModelErrorStat = mongoose.model('ModelErrorStat', modelErrorStatSchema);
