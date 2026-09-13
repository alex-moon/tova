import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    required: true,
  },
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true,
  },
  content: {
    type: String,
    /*
     * Empty provider responses are persisted as '' (fail-visibility, #4 J);
     * only undefined/null is invalid. `required: true` would also reject '',
     * which forced a place-holder into the DB instead.
     */
    validate: {
      validator: (v: unknown) => v !== null && v !== undefined,
      message: 'Message content must be a string (empty string allowed)',
    },
  },
  modelName: {
    type: String,
  },
  /*
   * Provenance URLs from web_search tool runs (issue #16), attached to the
   * assistant message only when non-empty — one message per turn stays true;
   * tool internals are trace artifacts, not separate messages.
   */
  sources: {
    type: [String],
    default: undefined,
  },
  /*
   * Per-source page titles from the same web_search runs (issue #33), keyed
   * by URL so the client renders the sources block with real titles on
   * reload — without it the block can only label links by hostname.
   */
  sourceTitles: {
    type: [
      {
        _id: false,
        url: String,
        title: String,
      },
    ],
    default: undefined,
  },
  /*
   * Generated follow-up questions (issue #33) for the composer chips; absent
   * when generation was skipped/failed — the client falls back to statics.
   */
  suggestions: {
    type: [String],
    default: undefined,
  },
  routingBand: {
    type: String,
  },
  /*
   * Attached asset reference (issue #34): a single-file FK per the owner's
   * comment — a column, not an array, until multi-attach is asked for.
   */
  assetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Asset',
  },
  feedback: {
    value: {
      type: String,
      enum: ['up', 'down'],
      default: null,
    },
    updatedAt: {
      type: Date,
      default: null,
    },
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  metrics: {
    wordCount: { type: Number },
    charCount: { type: Number },
    lengthBucket: { type: String, enum: ['short', 'medium', 'long'] },
    avgWordLength: { type: Number },
    syllableEstimateAvg: { type: Number },
    codeIndicators: {
      fences: { type: Number },
      backticks: { type: Number },
      codeTokenCount: { type: Number },
    },
    stopwordRatio: { type: Number },
    sessionMessageIndex: { type: Number },
    hasQuestionMark: { type: Boolean },
    hasImperative: { type: Boolean },
    llm: {
      emotional: { type: Boolean, default: null },
      technical: { type: Boolean, default: null },
      abstract: { type: Boolean, default: null },
      sentiment: { type: String, enum: ['positive', 'negative', 'neutral'], default: null },
      openEnded: { type: Boolean, default: null },
    },
    llmSkipReason: { type: String, enum: ['trivial', 'parse', 'error'], default: null },
  },
});

export const Message = mongoose.model('Message', messageSchema);
