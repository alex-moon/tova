import mongoose from 'mongoose';

// A task is a first-class stream: this doc is the header, events in TaskEvent.
// @see #254 #251
const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // queued -> running on claim; paused is a resumable budget breach.
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'],
      default: 'queued',
    },
    // Chat-origin tasks carry the session id; never a Message FK.
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
    // Completed-step count; the clock a crash-recovery requeue resumes.
    stepCount: {
      type: Number,
      default: 0,
    },
    // Budgets snapshotted at creation; a mid-task env change can't move them.
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
    // Bumped per claim; MAX_TASK_ATTEMPTS terminal-fails, unlike the cap.
    attempts: {
      type: Number,
      default: 0,
    },
    // Claim ownership: a frozen twin holding a rotated token writes nothing.
    // @see #395
    leaseToken: {
      type: String,
      default: null,
    },
    lastError: {
      type: String,
      default: null,
    },
    // Drain marker for the completion notification; once, never mid-turn.
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

// Origin vocabulary, re-exported; absent means unknown, never faked.
// @see #252
export interface TaskOrigin {
  kind: 'chat' | 'direct';
  sessionId?: string;
}

export const Task = mongoose.model('Task', taskSchema);
