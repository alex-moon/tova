import mongoose from 'mongoose';

// Durable error-level log record; survives restarts (Grafana does not).
// @see #175
const errorLogSchema = new mongoose.Schema(
  {
    // Monotonic buffer id from logService; not unique across restarts.
    bufferId: { type: Number, default: null },
    ts: { type: String, required: true },
    msg: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

errorLogSchema.index({ createdAt: 1 });

export const ErrorLog = mongoose.model('ErrorLog', errorLogSchema);
