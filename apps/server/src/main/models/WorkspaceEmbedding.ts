import mongoose from 'mongoose';

// One embedding per workspace slice, off the hot collections.
// @see #294
const workspaceEmbeddingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    kind: {
      type: String,
      enum: ['chat', 'file', 'task'],
      required: true,
    },
    sourceId: { type: String, required: true },
    model: { type: String, required: true },
    dim: { type: Number, required: true },
    // Mongoose arrays default to `[]`; non-empty must be explicit.
    vector: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: unknown) => Array.isArray(v) && v.length > 0,
        message: 'vector must be non-empty',
      },
    },
    // sha256 of embed text + model; drives the skip-if-unchanged rule.
    textHash: { type: String, required: true },
  },
  { collection: 'workspace_embeddings', timestamps: true },
);

workspaceEmbeddingSchema.index({ kind: 1, sourceId: 1, model: 1 }, { unique: true });

export type WorkspaceEmbeddingDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof workspaceEmbeddingSchema>
>;

export const WorkspaceEmbedding = mongoose.model('WorkspaceEmbedding', workspaceEmbeddingSchema);
