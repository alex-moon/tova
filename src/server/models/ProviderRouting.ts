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
    enum: ['small', 'large', 'guard'],
    required: true,
  },
  eligible: {
    type: Boolean,
    default: true,
  },
});

providerRoutingSchema.index({ tier: 1, provider: 1, model: 1 }, { unique: true });

export const ProviderRouting = mongoose.model('ProviderRouting', providerRoutingSchema);
