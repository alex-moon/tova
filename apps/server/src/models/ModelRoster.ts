import mongoose from 'mongoose';

/*
 * #232: the fixed model roster. Replaces the tier-shaped
 * `providerroutings` rows (one row = one model+provider+tier) with a
 * per-MODEL document carrying a paired `providers[]` list, so each roster
 * model is registered once and owns both of its serverless backends.
 *
 * The tier collection is deliberately left in place — its deletion is #233.
 * This collection is the source of truth for the racing path only.
 */

/*
 * Per-provider entry: which backend serves this model and the rolling TTFT
 * figure used by the weighted primary pick. `enabled` allows an operator to
 * take one backend out of the race without removing the model (OQ6 — cool-off
 * / disable is kept per provider, not per model).
 */
const rosterProviderSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['deepinfra', 'fireworks'],
      required: true,
    },
    /*
     * The provider's own model id (DeepInfra catalog id or Fireworks
     * `accounts/fireworks/models/...` id) — distinct from the roster model's
     * display id, and sent verbatim to the provider.
     */
    modelId: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    /*
     * Per-provider pricing (#235): USD per 1M tokens, split input/output, both
     * optional. Under racing the winning provider's price is the one that
     * applied, and two providers of one model can differ — so the price lives
     * on the provider entry, not the model. The model-root prices remain as the
     * default/fallback for a turn whose provider is unknown (legacy rows) or a
     * provider entry with no price. A missing price is "unknown" (≠ free,
     * #199); cached pricing is deliberately not modelled.
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
     * Rolling TTFT (OQ2: per-provider rollup on the routing doc). `ttftMs` is
     * the running mean over `ttftSamples` observations; `ttftUpdatedAt` is the
     * last observation. All three are absent on a provider that has never won
     * a race — absent is "unknown", never 0 (the weighted score falls back to
     * a neutral default for unknown).
     */
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
    /*
     * Cool-off timestamp (#168/#213 semantics kept per provider): set when a
     * backend fails. Absent/null = not cooling off. Expiry applied lazily on
     * read — no timers.
     */
    disabledUntil: {
      type: Date,
      default: null,
    },
  },
  { _id: false },
);

const modelRosterSchema = new mongoose.Schema({
  /*
   * Roster display id, unique per model (e.g. `deepseek-ai/DeepSeek-V4.1-Flash`).
   * This is the key the routing document is addressed by, not a
   * `{tier, provider, model}` tuple.
   */
  modelId: {
    type: String,
    required: true,
    unique: true,
  },
  label: {
    type: String,
    required: true,
  },
  /*
   * Capability + pricing metadata, owned once per model (not per provider):
   * `tools`/`vision` are descriptive capability flags (nothing gates on them
   * at runtime since #316), `contextLength` sizes the output budget, and the
   * two prices feed the weighted score and the cost view.
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
