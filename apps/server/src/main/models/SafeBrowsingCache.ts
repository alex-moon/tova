import mongoose from 'mongoose';

// Domain verdict cache for the Safe Browsing checker, TTL ~24h.
// @see #120
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
