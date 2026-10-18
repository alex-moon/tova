import mongoose from 'mongoose';

// Mongo-backed conversion queue: atomic single-consumer claim suffices.
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
    // Bumped per claim; MAX_JOB_ATTEMPTS failures terminal-fail the job.
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
