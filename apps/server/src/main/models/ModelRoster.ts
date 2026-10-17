import mongoose from 'mongoose';

// The fixed model roster: one document per model carrying its paired provider backends.
// @see #232 #233

/** Per-provider backend entry: serving backend, rolling TTFT, and an operator disable switch. */
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
    /** Per-provider USD/1M pricing; the winning provider's price applies, model-root prices are the fallback. */
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
    /** Cool-off timestamp set when a backend fails; expiry applied lazily on read. */
    // @see #168 #213
    disabledUntil: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const modelRosterSchema = new mongoose.Schema({
  /** Roster display id, unique per model; the key the routing document is addressed by. */
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
