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
    required: true,
  },
  modelName: {
    type: String,
  },
  sources: {
    type: [String],
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
