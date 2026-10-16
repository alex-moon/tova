import mongoose from 'mongoose';

// Domain-level verdict cache for the Safe Browsing link checker (issue #120):
// one row per hostname, TTL-expired after ~24h (Safe Browsing's own
// recommendation for cached expressions). Keyed on the exact hostname —
// registrable-domain extraction is deliberately deferred as tunable.

const CACHE_TTL_SECONDS = 24 * 60 * 60;

const safeBrowsingCacheSchema = new mongoose.Schema(
  {
    host: {
      type: String,
      required: true,
      unique: true,
    },
    verdict: {
      type: String,
      enum: ['safe', 'unsafe'],
      required: true,
    },
    checkedAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

safeBrowsingCacheSchema.index({ checkedAt: 1 }, { expireAfterSeconds: CACHE_TTL_SECONDS });

export const SafeBrowsingCache = mongoose.model('SafeBrowsingCache', safeBrowsingCacheSchema);
