import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { appendTaskEvent } from './taskProcessor';

/* Task sequencer runtime, generalised from assetJobService: enqueue, atomic oldest-first claim, single-consumer poll tick with retry-to-cap, and a stale-`running` requeue-on-boot sweep. The claim/retry pattern is mirrored, not extracted — the asset path owns asset-specific terminal side effects. */
// @see #254 #251

export const MAX_TASK_ATTEMPTS = 3;

// Terminal statuses are never reopened; one shared predicate so the steer/cancel guards cannot drift from the model enum.
const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const;
const isTerminalTaskStatus = (status: string): boolean =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

// The work a claim runs: the sequencer loop for one task; injectable so tests supply the driver.
export type TaskProcessor = (task: TaskDocument) => Promise<void>;

const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};

// Create a queued task; the budget is snapshotted at creation so a mid-task env change cannot move the goalposts; the instruction is also the stream's first `user` event (the stream is the source of truth).
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

// Atomic claim: status + attempts bump in one findOneAndUpdate, oldest-queued first; multiple processes cannot double-claim.
export const claimNextTask = async (): Promise<TaskDocument | null> =>
  Task.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim, run, settle; a failure retries to cap, then terminal-fails with the stored error. Only a task the processor left `running` is settled either way, so a paused/done/failed outcome is never clobbered.
export const runTaskTick = async (processor: TaskProcessor): Promise<void> => {
  const task = await claimNextTask();
  if (!task) return;
  try {
    await processor(task);
    // The processor may have moved the task to paused/done/failed itself; only settle a still-`running` task to `done`.
    await Task.updateOne({ _id: task._id, status: 'running' }, { $set: { status: 'done' } });
  } catch (err) {
    const message = clampError(err);
    const exhausted = task.attempts >= MAX_TASK_ATTEMPTS;
    // Symmetric with the success path: only settle a task the processor left `running` — one that already recorded its own outcome must not be clobbered.
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

// A server crash mid-run strands a `running` task; the start sweep requeues stale ones (attempts not incremented — the processor never observed the loss).
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
    // One task per tick; skip while the previous run is in flight so a long sequencer run does not stack up.
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

/* Read/steer/cancel surface for the API: a second writer for steering `user` events (via the collision-retrying appendTaskEvent), a header-writer for cancel observed at the next step boundary. */
// @see #254

// The outcome of appending a steering turn: accepted (queued, active or resumed), or refused because the stream is terminal.
export type SteeringResult = { status: 'queued' } | { status: 'refused' };

// Append a steering `user` event to an owned task and, from `paused`, re-queue it; ownership is the caller's job.
export const steerTask = async (
  task: TaskDocument,
  instruction: string,
): Promise<SteeringResult> => {
  // Re-read the live status: the poller may have settled or cancelled the task since the route's read; a terminal task is refused against the current status.
  const current = await Task.findById(task._id);
  if (!current || isTerminalTaskStatus(current.status)) {
    return { status: 'refused' };
  }

  await appendTaskEvent(current._id, {
    role: 'user',
    content: instruction,
    step: current.stepCount,
  });

  // From `paused` the instruction is the resume; the update is guarded on `paused` so a concurrent settle is never resurrected (the cancel-clobber race).
  if (current.status === 'paused') {
    await Task.updateOne({ _id: current._id, status: 'paused' }, { $set: { status: 'queued' } });
  }
  return { status: 'queued' };
};

// Cancel an owned task; terminal states left as-is (idempotent); a `running` processor observes the change at its next step boundary.
export const cancelTask = async (task: TaskDocument): Promise<void> => {
  // The write is guarded on non-terminal status: a task may settle itself to `done` between the route's read and here, and an unconditional write would clobber that completion; the `$nin` makes it idempotent and race-safe.
  await Task.updateOne(
    { _id: task._id, status: { $nin: ['done', 'failed', 'cancelled'] } },
    { $set: { status: 'cancelled' } },
  );
};
