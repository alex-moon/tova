import mongoose from 'mongoose';
import type { PersistedToolEvent } from '../routes/chat';

// Task stream (#254, epic #251): the ordered event log of a task, the task's
// *content* — one row per user steering turn, assistant step, or tool event.
// This is the resume state (D4): a restarted worker reassembles the
// conversation from these rows and continues from `Task.stepCount`. Kept in
// its own collection; `Message` gains no `taskId` and task turns are never
// written to `messages` (single writer per stream).
//
// `tools` reuses the #196 `PersistedToolEvent` shape (imported as a type — the
// enum is never duplicated), matching how `Message.tools` already stores tool
// chips for chat.
const taskEventSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
  },
  // Monotonic per-task sequence; `{ taskId, seq }` is the read order and the
  // uniqueness key a step advances on.
  seq: {
    type: Number,
    required: true,
  },
  // `system` rows are visible notices the sequencer writes (e.g. a budget
  // breach, D6) — rendered like content, never fed back as model context.
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
  // Reactive tool chips for the step, in the #196 shape.
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
      },
    ],
    default: undefined,
  },
  // Per-step usage (#224), carried like `Message.usage`; all optional so a
  // provider that reports nothing leaves it absent (unknown, not 0).
  usage: {
    type: {
      _id: false,
      inputTokens: { type: Number },
      outputTokens: { type: Number },
      totalTokens: { type: Number },
    },
    default: undefined,
  },
  // The step index this event belongs to (0-based); user rows carry the step
  // they are consumed at.
  step: { type: Number },
  // Event time in UTC (all storage is UTC; user-local framing is the
  // renderer's job per the #254 time contract). A single explicit clock like
  // `Message.timestamp` — the stream orders by `seq`, so a duplicate
  // `timestamps:true` createdAt/updatedAt pair would be redundant.
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

// The task stream reuses the #196 tool-event shape; this alias exists so
// callers import one name rather than reaching into the route module.
export type TaskToolEvent = PersistedToolEvent;

export const TaskEvent = mongoose.model('TaskEvent', taskEventSchema);
