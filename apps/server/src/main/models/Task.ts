import mongoose from 'mongoose';

// A task is a first-class stream, a twin of a chat: this doc is the header, events live in `TaskEvent`.
// @see #254 #251
const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // queued -> running on claim; paused is a resumable budget breach; done/failed/cancelled terminal.
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'],
      default: 'queued',
    },
    // Thin origin reference: chat-origin tasks carry the session id; never a Message FK.
    origin: {
      required: false,
      type: new mongoose.Schema(
        {
          kind: {
            type: String,
            enum: ['chat', 'direct'],
            required: true,
          },
          sessionId: { type: String },
        },
        { _id: false },
      ),
    },
    // Seed text for listing/summary; the stream event is the source of truth.
    instruction: {
      type: String,
      default: '',
    },
    // Monotonic count of completed steps; the resume clock a crash-recovery requeue continues from.
    stepCount: {
      type: Number,
      default: 0,
    },
    // Budgets snapshotted from config at creation so a mid-task env change cannot move the goalposts.
    budget: {
      type: new mongoose.Schema(
        {
          maxSteps: { type: Number, required: true },
          maxCostUsd: { type: Number, required: true },
          spentUsd: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
    },
    // Incremented on every claim; MAX_TASK_ATTEMPTS terminal-fails the task. Distinct from the step cap.
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
      default: null,
    },
    // The chat route's drain marker for the completion notification; delivered exactly once, never mid-turn.
    // @see #255
    notifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Poll query: oldest queued first (mirrors `AssetJob`).
taskSchema.index({ status: 1, createdAt: 1 });

export type TaskDocument = mongoose.HydratedDocument<mongoose.InferSchemaType<typeof taskSchema>>;

// Origin vocabulary, re-exported so callers share one shape; absent means unknown, never faked.
// @see #252
export interface TaskOrigin {
  kind: 'chat' | 'direct';
  sessionId?: string;
}

export const Task = mongoose.model('Task', taskSchema);
