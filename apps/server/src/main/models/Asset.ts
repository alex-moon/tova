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
    // Light extraction: deterministic UTF-8 decode for txt/md/csv, null otherwise.
    // @see #34
    textExtracted: {
      type: String,
      default: null,
    },
    // Markdown conversion produced by the asset-job worker; `markdownStatus` tracks the lifecycle for the UI.
    // @see #67
    markdownExtracted: {
      type: String,
      default: null,
    },
    markdownStatus: {
      type: String,
      enum: ['none', 'pending', 'ready', 'failed'],
      default: 'none',
    },
    markdownFailureReason: {
      type: String,
      default: null,
    },
    // Bounded thumbnail derived by the asset-job worker so the viewer never loads the original.
    // @see #208
    thumbnailKey: {
      type: String,
      default: null,
    },
    thumbnailStatus: {
      type: String,
      enum: ['none', 'pending', 'ready', 'failed'],
      default: 'none',
    },
    // Per-unit extracted text so the agent can walk long documents unit by unit; `select: false` keeps queries light.
    // @see #159
    units: {
      select: false,
      // `_id: false`: units are regenerated every job run; per-unit ObjectIds are pure noise.
      type: [
        {
          _id: false,
          index: { type: Number, required: true },
          label: { type: String, required: true },
          text: { type: String, required: true },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ['pending', 'ready', 'failed'],
      default: 'pending',
    },
    // Origin flag ("did Tova make it?"); legacy rows apply the default at read time, no backfill.
    // @see #66 #340
    origin: {
      type: String,
      enum: ['user-upload', 'system-generated', 'system-side'],
      default: 'user-upload',
    },
    // Current content version; bumped by every edit/restore, snapshotting into `AssetVersion`.
    // @see #325
    version: {
      type: Number,
      default: 1,
    },
    // Where the file came from; absent (never faked) means unknown, so no default by design.
    // @see #252 #251 #199
    provenance: {
      required: false,
      type: new mongoose.Schema(
        {
          kind: {
            type: String,
            enum: ['upload', 'chat', 'task'],
            required: true,
          },
          sessionId: { type: String },
          taskId: { type: String },
          messageId: { type: String },
        },
        { _id: false },
      ),
    },
    // Populated only when status is 'failed' (HEAD miss, oversize, stale).
    failureReason: {
      type: String,
      default: null,
    },
    // TTL expiry moment; only agent-side rows carry it, so nothing else is TTL-eligible.
    // @see #340
    expiresAt: { type: Date },
    // The URL a system-side row was scraped from: the cache key for re-use instead of a re-scrape.
    // @see #340
    sourceUrl: { type: String, default: null },
    // Zero-data retention: ZDR composer uploads are removed once the turn completes; library uploads never.
    // @see #116
    ephemeral: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Cursor-paged per-user listing (`{ userId, _id }` ascending).
assetSchema.index({ userId: 1, _id: 1 });

// Search queries over converted markdown.
// @see #67
assetSchema.index({ markdownExtracted: 1 });

// Native TTL: expires system-side rows at exactly their own `expiresAt`; no Spaces object to outlive.
// @see #340
assetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type AssetDocument = mongoose.HydratedDocument<mongoose.InferSchemaType<typeof assetSchema>>;

// Provenance vocabulary re-exported so all consumers share exactly one shape.
// @see #252
export interface AssetProvenance {
  kind: 'upload' | 'chat' | 'task';
  sessionId?: string;
  taskId?: string;
  messageId?: string;
}

export const Asset = mongoose.model('Asset', assetSchema);
