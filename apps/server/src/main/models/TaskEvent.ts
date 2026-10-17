import mongoose from 'mongoose';
import type { PersistedToolEvent } from '../routes/chat';

// Ordered event log of a task: the task's content and resume state; never written to `messages`.
// @see #254 #251 #196
const taskEventSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
  },
  // Monotonic per-task sequence; the read order and the uniqueness key a step advances on.
  seq: {
    type: Number,
    required: true,
  },
  // `system` rows are visible notices (e.g. a budget breach), never model context.
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
  // Reactive tool chips plus the raw executed `result` — the resume payload, clipped only at render time.
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
  // The step index this event belongs to (0-based); user rows carry the step they are consumed at.
  step: { type: Number },
  // Explicit UTC clock; the stream orders by `seq`, so a `timestamps` pair would be redundant.
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
