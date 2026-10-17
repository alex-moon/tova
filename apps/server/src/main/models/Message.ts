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
    /** Empty provider responses persist as ''; only undefined/null is invalid. */
    // @see #4
    validate: {
      validator: (v: unknown) => v !== null && v !== undefined,
      message: 'Message content must be a string (empty string allowed)',
    },
  },
  modelName: {
    type: String,
  },
  /** Provider that served this turn's completion, shown in the message footer. */
  // @see #117
  provider: {
    type: String,
  },
  /** Provenance URLs from web_search runs, attached to the assistant message only when non-empty. */
  // @see #16
  sources: {
    type: [String],
    default: undefined,
  },
  /** Per-source page titles keyed by URL, so the client renders real titles on reload. */
  // @see #33
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
  /** Generated follow-up questions for the composer chips; absent when skipped or failed. */
  // @see #33
  suggestions: {
    type: [String],
    default: undefined,
  },
  /** Reconciled tool-use summaries so the chat can render tool chips after a refresh. */
  // @see #196
  tools: {
    type: [
      {
        _id: false,
        phase: { type: String, enum: ['call', 'result'] },
        name: String,
        label: String,
        query: String,
        status: { type: String, enum: ['ok', 'empty'] },
        resultCount: Number,
        domains: [String],
      },
    ],
    default: undefined,
  },
  /** Token usage for the assistant turn; absent means unknown, never 0. */
  // @see #224
  usage: {
    type: {
      _id: false,
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      totalTokens: { type: Number },
    },
    default: undefined,
  },
  /** Attached asset reference: a single-file FK, not an array. */
  // @see #34
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
  /** Honesty-guard verdict: flagged turns claimed tool results that never executed; absent = unassessed. */
  // @see #371
  honesty: {
    type: {
      _id: false,
      flagged: { type: Boolean, required: true },
      reason: { type: String, default: null },
      checkedAt: { type: Date, required: true },
    },
    default: undefined,
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
