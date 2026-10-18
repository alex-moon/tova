import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { appendTaskEvent } from './taskProcessor';

/* Sequencer runtime: enqueue, atomic claim, poll tick, boot sweep. */
// @see #254 #251

export const MAX_TASK_ATTEMPTS = 3;

// Terminal statuses never reopen; one shared guard predicate.
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const;
const isTerminalTaskStatus = (status: string): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

// The work a claim runs: the sequencer loop; injectable for tests.
export type TaskProcessor = (task: TaskDocument) => Promise<void>;

const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};

// Create a queued task; the budget is snapshotted at creation.
export const enqueueTask = async (input: {
  userId: string;
  instruction?: string;
  origin?: { kind: 'chat' | 'direct'; sessionId?: string };
  maxSteps: number;
  maxCostUsd: number;
}): Promise<TaskDocument> => {
  const task = await Task.create({
    userId: input.userId,
    status: 'queued',
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    budget: { maxSteps: input.maxSteps, maxCostUsd: input.maxCostUsd, spentUsd: 0 },
  });
  if (input.instruction) {
    await TaskEvent.create({
      taskId: task._id,
      seq: 0,
      role: 'user',
      content: input.instruction,
      step: 0,
    });
  }
  return task;
};

// Atomic claim: status + attempts bump in one findOneAndUpdate.
export const claimNextTask = async (): Promise<TaskDocument | null> =>
  Task.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim, run, settle; failures retry to cap then fail.
export const runTaskTick = async (processor: TaskProcessor): Promise<void> => {
  const task = await claimNextTask();
  if (!task) return;
  try {
    await processor(task);
    // Only settle a still-running task; the processor may have settled it.
    await Task.updateOne({ _id: task._id, status: 'running' }, { $set: { status: 'done' } });
  } catch (err) {
    const message = clampError(err);
    const exhausted = task.attempts >= MAX_TASK_ATTEMPTS;
    // Symmetric with success: never clobber a task that self-settled.
    await Task.updateOne(
      { _id: task._id, status: 'running' },
      {
        $set: {
          status: exhausted ? 'failed' : 'queued',
          lastError: message,
        },
      },
    );
  }
};

let timer: ReturnType<typeof setInterval> | null = null;

let busy = false;

// Boot sweep requeues stale running tasks from a crashed server.
export const STALE_RUNNING_MS = 5 * 60 * 1000;

export const requeueStaleTasks = async (maxAgeMs: number = STALE_RUNNING_MS): Promise<number> => {
  const result = await Task.updateMany(
    { status: 'running', updatedAt: { $lt: new Date(Date.now() - maxAgeMs) } },
    { $set: { status: 'queued' } },
  );
  return result.modifiedCount ?? 0;
};

export const startTaskPoller = (
  processor: TaskProcessor,
  intervalMs = POLL_INTERVAL_MS,
): ReturnType<typeof setInterval> => {
  if (timer) return timer;
  void requeueStaleTasks().catch(() => undefined);
  timer = setInterval(() => {
    // One task per tick; skip while the previous run is in flight.
    if (busy) return;
    busy = true;
    void runTaskTick(processor).finally(() => {
      busy = false;
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
};

export const stopTaskPoller = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

export const isTaskPollerRunning = (): boolean => timer !== null;

/* Read/steer/cancel surface for the API: steering and cancel writers. */
// @see #254

// Steering turn outcome: accepted, or refused when terminal.
export type SteeringResult = { status: 'queued' } | { status: 'refused' };

// Append a steering user event and re-queue a paused task.
export const steerTask = async (
  task: TaskDocument,
  instruction: string,
): Promise<SteeringResult> => {
  // Re-read live status: the poller may have settled it since the read.
  const current = await Task.findById(task._id);
  if (!current || isTerminalTaskStatus(current.status)) {
    return { status: 'refused' };
  }

  await appendTaskEvent(current._id, {
    role: 'user',
    content: instruction,
    step: current.stepCount,
  });

  // Guarded on paused so a concurrent settle is never resurrected.
  if (current.status === 'paused') {
    await Task.updateOne({ _id: current._id, status: 'paused' }, { $set: { status: 'queued' } });
  }
  return { status: 'queued' };
};

// Cancel an owned task; terminal states left as-is (idempotent).
export const cancelTask = async (task: TaskDocument): Promise<void> => {
  // Guarded on non-terminal status: never clobber a self-settled task.
  await Task.updateOne(
    { _id: task._id, status: { $nin: ['done', 'failed', 'cancelled'] } },
    { $set: { status: 'cancelled' } },
  );
};
