import mongoose from 'mongoose';

// Immutable append-only snapshots of generated-asset content; the `Asset` row always mirrors the latest.
// @see #325
const assetVersionSchema = new mongoose.Schema(
  {
    assetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Asset',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    version: {
      type: Number,
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    textExtracted: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

// One row per (asset, version); the upsert in the write path is idempotent.
assetVersionSchema.index({ assetId: 1, version: 1 }, { unique: true });

// The daily prune sweeps by age.
// @see #369
assetVersionSchema.index({ createdAt: 1 });

export type AssetVersionDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof assetVersionSchema>
>;

export const AssetVersion = mongoose.model('AssetVersion', assetVersionSchema);
