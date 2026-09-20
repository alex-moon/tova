import mongoose from 'mongoose';

/*
 * Per-user entity graph nodes (issue #138). Deliberately loose schema while
 * the ontology (plan-138) is still being settled: `kind`, `attrs` and the
 * edge vocabulary can evolve without migrations. Identity is exact-match on
 * {(userId, normalizedName, kind)}; anything fuzzier is out of scope.
 */
const sourceRefSchema = new mongoose.Schema({
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    required: true,
  },
  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
  },
});

const entitySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  // Lowercase, whitespace-collapsed `name` — the exact-match identity key.
  normalizedName: {
    type: String,
    required: true,
  },
  // Loose ontology (plan-138 open question): person, place, organization,
  // project, task, event, commitment, preference to start.
  kind: {
    type: String,
    required: true,
  },
  summary: {
    type: String,
  },
  // Bag of loose facts (e.g. { city: 'Mumbai' }); may stay absent.
  attrs: {
    type: mongoose.Schema.Types.Mixed,
  },
  mentionCount: {
    type: Number,
    default: 1,
  },
  lastMentionedAt: {
    type: Date,
    default: Date.now,
  },
  // Where each mention came from, so every inferred fact stays auditable
  // (plan decision 5: human-readable observability first).
  sourceRefs: {
    type: [sourceRefSchema],
    default: [],
  },
});

entitySchema.index({ userId: 1, normalizedName: 1, kind: 1 }, { unique: true });
entitySchema.index({ userId: 1, lastMentionedAt: -1 });

export type EntityDoc = mongoose.Document & {
  userId: mongoose.Types.ObjectId;
  name: string;
  normalizedName: string;
  kind: string;
  summary?: string;
  attrs?: Record<string, unknown>;
  mentionCount: number;
  lastMentionedAt: Date;
  sourceRefs: { sessionId: mongoose.Types.ObjectId; messageId?: mongoose.Types.ObjectId }[];
};

export const Entity = mongoose.model('Entity', entitySchema);
