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
  routingBand: {
    type: String,
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
