import mongoose from 'mongoose';

/*
 * Typed edge between two entity nodes of one user (issue #138). One doc per
 * link; `kind` stays free-form until the ontology settles (plan-138).
 */
const entityEdgeSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  fromEntityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Entity',
    required: true,
  },
  toEntityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Entity',
    required: true,
  },
  kind: {
    type: String,
    required: true,
  },
  // Free-text gloss of why the link exists, straight from the extracting LLM.
  summary: {
    type: String,
  },
  sourceRefs: {
    type: [
      {
        _id: false,
        sessionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Session',
          required: true,
        },
        messageId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Message',
        },
      },
    ],
    default: [],
  },
});

// Identity guard: the same typed link between the same two nodes should be
// one row, not one per mention.
entityEdgeSchema.index({ userId: 1, fromEntityId: 1, toEntityId: 1, kind: 1 }, { unique: true });
entityEdgeSchema.index({ userId: 1, fromEntityId: 1 });

export type EntityEdgeDoc = mongoose.Document & {
  userId: mongoose.Types.ObjectId;
  fromEntityId: mongoose.Types.ObjectId;
  toEntityId: mongoose.Types.ObjectId;
  kind: string;
  summary?: string;
  sourceRefs: { sessionId: mongoose.Types.ObjectId; messageId?: mongoose.Types.ObjectId }[];
};

export const EntityEdge = mongoose.model('EntityEdge', entityEdgeSchema);
