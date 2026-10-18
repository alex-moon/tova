import mongoose from 'mongoose';

// Per-URL verdict cache for the Safe Browsing checker, TTL ~24h; verdicts
// must never widen to the host (shared-host green-lighting).
// @see #120 #397
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const safeBrowsingCacheSchema = new mongoose.Schema(
  {
    url: {
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
