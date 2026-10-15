import mongoose from 'mongoose';

/*
 * #325: immutable snapshots of an assistant-generated asset's content. Every
 * content write (an `edit_file` edit, or a restore) stores both the pre-write
 * version and the new version here, so history is complete and append-only and
 * the `Asset` row always mirrors the latest version. Rows are created lazily on
 * the first write — a never-edited generated file has `version: 1` and no rows.
 *
 * The text is stored in full (like `Asset.textExtracted`) because a restore
 * reads it back; there is no separate object per version, and the Spaces object
 * at the asset's key is simply overwritten.
 */
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

export type AssetVersionDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof assetVersionSchema>
>;

export const AssetVersion = mongoose.model('AssetVersion', assetVersionSchema);
