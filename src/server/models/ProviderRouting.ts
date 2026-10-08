import mongoose from 'mongoose';

const providerRoutingSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['groq', 'deepinfra', 'fireworks', 'typesafe'],
    required: true,
  },
  model: {
    type: String,
    required: true,
  },
  tier: {
    type: String,
    enum: ['small', 'large', 'guard'],
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
  /*
   * Pricing (#199): USD per 1M tokens, split input/output, both optional so
   * legacy rows and cool-off readiness are unaffected. A missing price means
   * "unknown" (distinct from free); the router sums the two to compare against
   * the price cap. Cached pricing is deliberately not modelled (#199 ignores
   * it).
   */
  inputPrice: {
    type: Number,
    min: 0,
  },
  outputPrice: {
    type: Number,
    min: 0,
  },
  /*
   * Cool-off timestamp (#168): set when a connector failure temporarily
   * disables the model. Absent/null = not cooling off (legacy rows never
   * carried the field). Expiry is applied lazily on read — no timers.
   */
  disabledUntil: {
    type: Date,
  },
});

providerRoutingSchema.index({ tier: 1, provider: 1, model: 1 }, { unique: true });

export const ProviderRouting = mongoose.model('ProviderRouting', providerRoutingSchema);
