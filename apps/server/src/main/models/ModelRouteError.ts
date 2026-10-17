import mongoose from 'mongoose';

// Per-provider-route error tally: one document per (provider, model, status, category) cell.
// @see #175
const modelRouteErrorSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  model: { type: String, required: true },
  // Null when the failure carries no HTTP status (network error, timeout, abort).
  status: { type: Number, default: null },
  category: { type: String, required: true },
  count: { type: Number, default: 0 },
  lastMessage: { type: String, default: null },
  lastSeenAt: { type: Date, required: true },
});

modelRouteErrorSchema.index({ provider: 1, model: 1, status: 1, category: 1 }, { unique: true });

export const ModelRouteError = mongoose.model('ModelRouteError', modelRouteErrorSchema);
