import mongoose from 'mongoose';

// Mongo-backed conversion queue (issue #67): one row per asset conversion
// attempt chain. Poller-v1 runs in-process with a single consumer, so an
// atomic `pending -> processing` claim without a lease field is sufficient;
// a processor crash mid-job leaves a stuck `processing` row, which a later
// requeue-on-boot sweep can clear (plan Open Question C).
const assetJobSchema = new mongoose.Schema(
  {
    assetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Asset',
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
    // Incremented on every claim; reaching MAX_JOB_ATTEMPTS on a failure
    // terminal-fails the job.
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Poll query: oldest pending first.
assetJobSchema.index({ status: 1, createdAt: 1 });

export type AssetJobDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof assetJobSchema>
>;

export const AssetJob = mongoose.model('AssetJob', assetJobSchema);
