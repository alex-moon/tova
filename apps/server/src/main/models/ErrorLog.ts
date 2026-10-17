import mongoose from 'mongoose';

// Durable record of error-level log output; survives a restart where Grafana Cloud is only retained.
// @see #175
const errorLogSchema = new mongoose.Schema(
  {
    // Monotonic buffer id from logService; not unique across restarts — diagnostics scalar only.
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
