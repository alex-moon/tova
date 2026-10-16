import mongoose from 'mongoose';

/*
 * #294: one embedding vector per workspace slice (a user message, an asset's
 * extracted text, or a task's event stream). Vectors live in their own
 * collection rather than on the source docs so:
 *
 *  - `Message`/`Asset`/`Task` reads stay lean (chat history is hot);
 *  - multiple models can coexist side by side (the owner's bge-m3/gte probe),
 *    keyed by `model`, without mixing dimensions in the Atlas index;
 *  - a backfill can upsert idempotently on the unique key.
 *
 * `sourceId` is the source document's Mongo `_id` as a string; because that is
 * globally unique, `userId` is redundant in the key (it is kept as the
 * `$vectorSearch` ownership filter). Retrieval intersects vector hits with the
 * collected slice set, so an orphaned row (its source deleted) is dropped.
 */
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
    // A Mongoose array defaults to `[]` and `required` does not reject that,
    // so the non-empty check is explicit: a stored vector with no values is a
    // corrupt row, never a valid one.
    vector: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: unknown) => Array.isArray(v) && v.length > 0,
        message: 'vector must be non-empty',
      },
    },
    // sha256 of the (truncated) embed text + model; a mismatch is what makes a
    // re-run re-embed a changed slice and skip an unchanged one.
    textHash: { type: String, required: true },
  },
  { collection: 'workspace_embeddings', timestamps: true },
);

workspaceEmbeddingSchema.index({ kind: 1, sourceId: 1, model: 1 }, { unique: true });

export type WorkspaceEmbeddingDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof workspaceEmbeddingSchema>
>;

export const WorkspaceEmbedding = mongoose.model('WorkspaceEmbedding', workspaceEmbeddingSchema);
