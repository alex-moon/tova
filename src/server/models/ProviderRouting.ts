import mongoose from 'mongoose';

const providerRoutingSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['groq', 'deepinfra'],
    required: true,
  },
  model: {
    type: String,
    required: true,
  },
  tier: {
    type: String,
    enum: ['small', 'large'],
    required: true,
  },
  eligible: {
    type: Boolean,
    default: true,
  },
  /*
   * Capability flags (#94): what a model can do, tracked on the row so
   * completion routing can rule models out deterministically. `tools` and
   * `vision` are booleans; `contextLength` is the advertised token limit
   * (optional — it is informational, not a routing constraint yet).
   */
  tools: {
    type: Boolean,
    default: true,
  },
  vision: {
    type: Boolean,
    default: false,
  },
  contextLength: {
    type: Number,
  },
});

providerRoutingSchema.index({ tier: 1, provider: 1, model: 1 }, { unique: true });

export const ProviderRouting = mongoose.model('ProviderRouting', providerRoutingSchema);
