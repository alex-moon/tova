import mongoose from 'mongoose';

// Per-(band, modelName) thumbs up/down tallies (issue #18). Unique compound
// index supports the $inc/upsert pattern in modelMetricsStatsService.
const modelMetricStatSchema = new mongoose.Schema({
  band: {
    type: String,
    required: true,
  },
  modelName: {
    type: String,
    required: true,
  },
  up: {
    type: Number,
    default: 0,
  },
  down: {
    type: Number,
    default: 0,
  },
});

modelMetricStatSchema.index({ band: 1, modelName: 1 }, { unique: true });

export const ModelMetricStat = mongoose.model('ModelMetricStat', modelMetricStatSchema);
