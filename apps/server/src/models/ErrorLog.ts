import mongoose from 'mongoose';

// Issue #175: durable record of error-level log output for diagnostics.
// The admin logs view reads the in-memory ring buffer (logService.ts),
// which is lost on restart; every entry here survives it.
const errorLogSchema = new mongoose.Schema(
  {
    // Monotonic buffer id emitted by logService at write time; not unique
    // across restarts — diagnostics scalar only.
    bufferId: { type: Number, default: null },
    ts: { type: String, required: true },
    msg: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

errorLogSchema.index({ createdAt: 1 });

export type ErrorLogDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof errorLogSchema>
>;

export const ErrorLog = mongoose.model('ErrorLog', errorLogSchema);
