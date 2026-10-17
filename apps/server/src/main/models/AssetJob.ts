import mongoose from 'mongoose';

// Mongo-backed conversion queue: single-consumer atomic `pending -> processing` claim is sufficient.
// @see #67
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
    // Incremented on every claim; MAX_JOB_ATTEMPTS on a failure terminal-fails the job.
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
