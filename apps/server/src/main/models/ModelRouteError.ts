import mongoose from 'mongoose';

// Issue #175: per-provider-route error tally. One document per
// (provider, model, status, category) cell, incremented on every failure of
// that provider route; `lastMessage` keeps the most recent (redacted) error
// text so a category label can be sanity-checked in diagnostics. The unique
// compound index supports the $inc/upsert pattern in modelErrorTally.
const modelRouteErrorSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  model: { type: String, required: true },
  // Null when the failure carries no HTTP status (network error, timeout,
  // unknown provider, abort).
  status: { type: Number, default: null },
  category: { type: String, required: true },
  count: { type: Number, default: 0 },
  lastMessage: { type: String, default: null },
  lastSeenAt: { type: Date, required: true },
});

modelRouteErrorSchema.index({ provider: 1, model: 1, status: 1, category: 1 }, { unique: true });

export const ModelRouteError = mongoose.model('ModelRouteError', modelRouteErrorSchema);
