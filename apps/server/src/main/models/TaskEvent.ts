import mongoose from 'mongoose';
import type { PersistedToolEvent } from '../services/llm/toolChips';

// Ordered task event log: content and resume state; never in `messages`.
// @see #254 #251 #196
const taskEventSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
  },
  // Monotonic per-task sequence; read order and the step uniqueness key.
  seq: {
    type: Number,
    required: true,
  },
  // `system` rows are visible notices, never model context.
  role: {
    type: String,
    enum: ['user', 'assistant', 'tool', 'system'],
    required: true,
  },
  content: {
    type: String,
    default: '',
  },
  // Set on assistant events: the model/provider that served the step.
  model: { type: String },
  provider: { type: String },
  // Tool chips plus the raw `result` resume payload, clipped at render.
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
        filename: String,
        result: { type: mongoose.Schema.Types.Mixed, required: false },
      },
    ],
    default: undefined,
  },
  // Per-step usage, carried like `Message.usage`; absent means unknown, not 0.
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
  // 0-based step index; user rows carry the step they are consumed at.
  step: { type: Number },
  // Explicit UTC clock; the stream orders by `seq`, not by time.
  // @see #254
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

// Stream read order and the seq-uniqueness guard.
taskEventSchema.index({ taskId: 1, seq: 1 }, { unique: true });

export type TaskEventDocument = mongoose.HydratedDocument<
  mongoose.InferSchemaType<typeof taskEventSchema>
>;

// Reuses the #196 tool-event shape plus the raw `result` resume payload.
// @see #196
export type TaskToolEvent = PersistedToolEvent & { result?: unknown };

export const TaskEvent = mongoose.model('TaskEvent', taskEventSchema);
