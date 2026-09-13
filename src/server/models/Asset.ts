import mongoose from 'mongoose';

const assetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    // Spaces object key: `<userId>/<assetId>/<filename>`
    key: {
      type: String,
      required: true,
    },
    contentType: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    // Light extraction result (issue #34): deterministic UTF-8 decode for
    // txt/md/csv, null ("no text extracted") for everything else.
    textExtracted: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'ready', 'failed'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  },
);

// Cursor-paged per-user listing (`{ userId, _id }` ascending).
assetSchema.index({ userId: 1, _id: 1 });

export const Asset = mongoose.model('Asset', assetSchema);
