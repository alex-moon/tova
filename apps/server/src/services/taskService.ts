import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { appendTaskEvent } from './taskProcessor';

// Task sequencer runtime (#254, epic #251), generalised from `assetJobService`:
// enqueue, an atomic oldest-first claim (`queued -> running` + attempts bump),
// a single-consumer poll tick with retry-to-cap, and a stale-`running`
// requeue-on-boot sweep. In-process is accepted for v1 — "offline" means no
// user connection required, not a separate process.
//
// OQ2 resolution: the claim/retry/sweep pattern is *mirrored* here rather than
// extracted into a shared helper. `assetJobService` is a non-slice subsystem
// with asset-specific terminal-failure side effects (flipping `markdownStatus`/
// `thumbnailStatus`); a generic `claimNext(collection)` would either leak that
// coupling or need a callback indirection that complicates the asset path for
// no benefit at two call sites. The task service owns its own status vocabulary
// and failure semantics.

export const MAX_TASK_ATTEMPTS = 3;

const POLL_INTERVAL_MS = 5000;

const MAX_STORED_ERROR_CHARS = 500;

// The work a claim runs: the sequencer loop for one task. Injectable so tests
// (and the later sequencer slice) supply the real driver.
export type TaskProcessor = (task: TaskDocument) => Promise<void>;

const clampError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_STORED_ERROR_CHARS);
};

// Create a queued task. `budget` is snapshotted at creation (D6) so a mid-task
// env change cannot move the goalposts; the caller supplies the config values.
// The initial instruction is *also* written as the task stream's first `user`
// event (D1: the stream is the source of truth; `instruction` is the listing
// seed). A direct-origin task with no instruction starts with an empty stream
// and marks step 0 as a `system` row only when the loop runs.
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

// Atomic claim: status + attempts bump in one findOneAndUpdate, oldest-queued
// first. Single consumer in-process; multiple server processes would still not
// double-claim the same row.
export const claimNextTask = async (): Promise<TaskDocument | null> =>
  Task.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );

// One poll tick: claim a task, run the processor, and settle the outcome. A
// processor failure retries until MAX_TASK_ATTEMPTS, then terminal-fails the
// task with the stored error (mirrors `runAssetJobTick`).
export const runTaskTick = async (processor: TaskProcessor): Promise<void> => {
  const task = await claimNextTask();
  if (!task) return;
  try {
    await processor(task);
    // The processor may have moved the task to paused/done/failed itself; only
    // settle it to `done` if it is still running.
    await Task.updateOne({ _id: task._id, status: 'running' }, { $set: { status: 'done' } });
  } catch (err) {
    const message = clampError(err);
    const exhausted = task.attempts >= MAX_TASK_ATTEMPTS;
    // Symmetric with the success path: only settle a task the processor left
    // `running`. A processor that moved it to paused/done/failed (and recorded
    // its own reason) before throwing must not be clobbered — that is the same
    // guard the `done` branch applies, and the paused-breaking case (D6) is
    // exactly when it matters.
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

// A server crash mid-run leaves a `running` task stranded. At poller start such
// tasks older than STALE_PROCESSING_MS are requeued as `queued` so a restart
// self-heals; updatedAt is the staleness clock. Attempts are not incremented —
// the sweep does not count against the retry cap (the processor never observed
// the loss), mirroring `requeueStaleAssetJobs`.
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
    // One task per tick; skip ticks while the previous run is in flight so a
    // long sequencer run does not stack up.
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

/*
 * Read/steer/cancel surface for the API (#254 routes slice, D14/D15).
 *
 * The API is a *second writer* on the task stream (steering `user` events,
 * D12) but only a reader of everything else. Steering appends through
 * `appendTaskEvent`, which retries the `{taskId, seq}` collision the second
 * writer can cause. Cancel is a header write, not a stream write; the
 * processor observes it at the next step boundary (D13).
 */

// The outcome of appending a steering turn: accepted (`queued`, whether it was
// already active or resumed from `paused`), or refused because the stream is
// terminal. Not-found is the route's concern (an ownerless id never reaches
// here).
export type SteeringResult = { status: 'queued' } | { status: 'refused' };

// Append a steering `user` event to an owned task and, from `paused`, re-queue
// it. Ownership is the caller's job (the route scopes the lookup by userId);
// this helper takes the already-owned document.
export const steerTask = async (
  task: TaskDocument,
  instruction: string,
): Promise<SteeringResult> => {
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
    return { status: 'refused' };
  }

  await appendTaskEvent(task._id, {
    role: 'user',
    content: instruction,
    step: task.stepCount,
  });

  // From `paused` the instruction is the resume: move the header back to the
  // queue so the poller re-claims it. From `queued`/`running` the status is
  // already live; the event alone steers.
  if (task.status === 'paused') {
    await Task.updateOne({ _id: task._id }, { $set: { status: 'queued' } });
  }
  return { status: 'queued' };
};

// Cancel an owned task. Terminal states are left as-is (idempotent); a
// `running` task's processor observes the status change at its next step
// boundary (D13) and returns without settling it back to `done`.
export const cancelTask = async (task: TaskDocument): Promise<void> => {
  if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return;
  await Task.updateOne({ _id: task._id }, { $set: { status: 'cancelled' } });
};
