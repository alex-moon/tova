import mongoose from 'mongoose';

// Fixed model roster: one doc per model with its paired providers.
// @see #232 #233

/** Per-provider backend: serving backend, rolling TTFT, disable switch. */
const rosterProviderSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['deepinfra', 'fireworks'],
      required: true,
    },
    /** The provider's own model id, sent verbatim to the provider. */
    modelId: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    /** USD/1M pricing; the winning provider's price applies. */
    // @see #235 #199
    inputPrice: {
      type: Number,
      min: 0,
    },
    outputPrice: {
      type: Number,
      min: 0,
    },
    /** Rolling TTFT mean over samples; absent is "unknown", never 0. */
    ttftMs: {
      type: Number,
      min: 0,
    },
    ttftSamples: {
      type: Number,
      min: 0,
    },
    ttftUpdatedAt: {
      type: Date,
    },
    /** Cool-off set when a backend fails; expiry applied lazily. */
    // @see #168 #213
    disabledUntil: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const modelRosterSchema = new mongoose.Schema({
  /** Roster display id, unique; the routing document's key. */
  modelId: {
    type: String,
    required: true,
    unique: true,
  },
  label: {
    type: String,
    required: true,
  },
  /** Capability + pricing metadata owned once per model, not per provider. */
  // @see #316
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
  inputPrice: {
    type: Number,
    min: 0,
  },
  outputPrice: {
    type: Number,
    min: 0,
  },
  eligible: {
    type: Boolean,
    default: true,
  },
  providers: {
    type: [rosterProviderSchema],
    default: [],
  },
});

modelRosterSchema.index({ 'providers.provider': 1 });

export const ModelRoster = mongoose.model('ModelRoster', modelRosterSchema);
