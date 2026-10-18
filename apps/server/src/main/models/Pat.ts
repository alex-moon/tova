import mongoose from 'mongoose';

// Personal access tokens: only the sha256 digest stored; role read live.
// @see #184
const patSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 100,
  },
  tokenHash: {
    type: String,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastUsedAt: {
    type: Date,
  },
  // Blank = non-expiring: expiry is opt-in rather than a default.
  expiresAt: {
    type: Date,
  },
});

patSchema.index({ tokenHash: 1 }, { unique: true });

export const Pat = mongoose.model('Pat', patSchema);
