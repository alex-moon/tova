import mongoose from 'mongoose';

// Task entity (#254, epic #251): a task is a first-class stream — a twin of a
// chat, not a chat's child. This document is the task's *header* (status,
// origin reference, step/budget accounting); the ordered work — every user,
// assistant, and tool event — lives in the separate `TaskEvent` collection.
// Hard invariant of the slice: no `taskId` ever reaches `Message`, and no task
// message is ever written into `messages` (single writer per stream).
const taskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // queued -> running on claim; paused is a budget breach (D6), resumable by
    // appending a steering instruction; done/failed/cancelled are terminal.
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'],
      default: 'queued',
    },
    // Thin origin reference (D1): a task started from a chat carries the
    // session id, a direct-origin task (no chat) carries none. Never a Message
    // FK. Absent means "direct/unknown", never faked.
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
    // Seed text for listing/summary. The stream event is the source of truth
    // for the instruction; this scalar is a convenience copy, not the record.
    instruction: {
      type: String,
      default: '',
    },
    // Monotonic count of completed steps; the resume clock (D4). A crash-
    // recovery requeue continues from here.
    stepCount: {
      type: Number,
      default: 0,
    },
    // D6: budget accounting. `maxSteps`/`maxCostUsd` are snapshotted from
    // config at creation so a mid-task env change cannot move the goalposts;
    // `spentUsd` is the running meter (persisted, updated as steps settle).
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
    // Incremented on every claim; reaching MAX_TASK_ATTEMPTS terminal-fails the
    // task (mirrors `AssetJob.attempts`). Distinct from the step cap (OQ7).
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
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

// The origin vocabulary, re-exported so callers share exactly one shape.
// Optional fields are omitted, never faked (same absence policy as #252).
export interface TaskOrigin {
  kind: 'chat' | 'direct';
  sessionId?: string;
}

export const Task = mongoose.model('Task', taskSchema);
