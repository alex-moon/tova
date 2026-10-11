import type { TaskDocument } from '../models/Task';
import { Task } from '../models/Task';
import { TaskEvent, type TaskEventDocument, type TaskToolEvent } from '../models/TaskEvent';
import type { TokenUsage } from './llmTypes';
import { runTaskStep, type TaskStepOutcome } from './taskSequencer';

/*
 * Task processor (#254, epic #251) — the sequencer's worker-driven turn loop.
 *
 * One tick claims a task and runs its steps to a terminal or paused state:
 *
 *   - each step is one `maxSteps: 1` roster call (`runTaskStep`);
 *   - the step's outcome is appended to the task stream as an `assistant`
 *     event, then `stepCount` advances — the event write is the unit a step
 *     advances on (crash recovery reassembles from the stream);
 *   - steering is drained at the call boundary: every queued `user` event is
 *     already in the history the next step assembles, so a queued instruction
 *     is consumed at the next boundary by construction (D2);
 *   - when `stepCount` reaches the task's `maxSteps` budget, the task is
 *     `paused` with a visible `system` event (D6) rather than failed — the
 *     same mechanism a cost breach uses, resumable by a steering instruction.
 *
 * Crash recovery (D4): a stale `running` task is requeued by the poller sweep;
 * on re-claim this loop restarts from the persisted stream (`stepCount` steps
 * already match the events on it) and continues — no separate checkpoint.
 */

const MAX_NOTICE_CHARS = 500;

// The persistable event fields, declared as a plain shape (not `Pick` off the
// hydrated document — `TaskEventDocument.model` collides with mongoose's own
// document `model()` method and resolves to the wrong type).
export interface TaskEventInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  step: number;
  model?: string;
  provider?: string;
  tools?: TaskToolEvent[];
  usage?: TokenUsage;
}

// Is this a `{taskId, seq}` duplicate-key error (code 11000)? Two writers can
// now race for the same seq: the poller appends assistant/system events and the
// API appends steering `user` events (D12). The unique index is the guard; on a
// collision we re-read the max seq and retry rather than surfacing a 500.
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

// Append one event at the next seq. Read-max-then-insert, retried on the
// `{taskId, seq}` unique-index collision. A single writer (the poller) never
// collides; the retry exists for the second writer the API introduces (D12) so
// a concurrent steering append is correct, not merely loud.
export const appendTaskEvent = async (
  taskId: TaskDocument['_id'],
  event: TaskEventInput,
): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const last = await TaskEvent.findOne({ taskId }).sort({ seq: -1 });
    const seq = (last?.seq ?? -1) + 1;
    try {
      await TaskEvent.create({ taskId, seq, ...event });
      return;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  throw new Error('Could not allocate a task event sequence');
};

// A visible system notice (budget breach, completion), rendered like content
// but never fed back as model context (`assembleTaskHistory` skips `system`).
// `step` is the step the notice belongs to (the last-completed step ordinal),
// passed explicitly — the `Task` document's own `stepCount` is the value read
// at claim time and is stale once the loop has run.
const appendNotice = (taskId: TaskDocument['_id'], content: string, step: number): Promise<void> =>
  appendTaskEvent(taskId, {
    role: 'system',
    content: content.slice(0, MAX_NOTICE_CHARS),
    step,
  });

export const processTaskJob = async (task: TaskDocument): Promise<void> =>
  makeTaskProcessor(runTaskStep)(task);

// Injectable step runner: production uses `runTaskStep` (live roster race);
// tests inject a deterministic fake. The seam is the whole model call, so tests
// need no provider, roster, or clock.
export type TaskStepRunner = (
  task: TaskDocument,
  events: TaskEventDocument[],
) => Promise<TaskStepOutcome>;

export const makeTaskProcessor =
  (runStep: TaskStepRunner) =>
  async (task: TaskDocument): Promise<void> => {
    // Re-read the claimed task and the stream; on a resume these already carry
    // the prior steps, so the loop continues rather than restarting.
    const claimed = (await Task.findById(task._id)) ?? task;
    let stepCount = claimed.stepCount;

    for (;;) {
      // Re-read the header before each step (D13): cancel (or any external
      // status change) is observed at this boundary — the same boundary
      // steering is drained at — so a cancelled running task stops within one
      // step instead of stepping to completion. `budget` is snapshotted at
      // creation, but `status`/`stepCount` are live.
      const current = (await Task.findById(task._id)) ?? claimed;
      if (current.status !== 'running') return;
      const maxSteps = current.budget.maxSteps;

      if (stepCount >= maxSteps) {
        await appendNotice(
          current._id,
          `Task paused: reached its step budget (${maxSteps} steps).`,
          stepCount,
        );
        await Task.updateOne(
          { _id: current._id, status: 'running' },
          { $set: { status: 'paused', stepCount, lastError: 'step budget reached' } },
        );
        return;
      }

      const events = await TaskEvent.find({ taskId: current._id }).sort({ seq: 1 });
      const outcome = await runStep(current, events);

      await appendTaskEvent(current._id, {
        role: 'assistant',
        content: outcome.text,
        step: stepCount,
        model: outcome.model,
        provider: outcome.provider,
        ...(outcome.tools.length ? { tools: outcome.tools } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      });
      stepCount += 1;
      await Task.updateOne({ _id: current._id }, { $set: { stepCount } });

      // The step's text is the driver's read on whether the task is done. A
      // step that called tools returns no text (spike: `text = ""` at cap 1)
      // and the loop continues to let the model act on the results. A step
      // with text and no tool calls is the model's final answer.
      if (outcome.text.trim() !== '' && outcome.tools.length === 0) {
        // Settle first, then announce: only a task still `running` is settled
        // to `done`, and only a task we actually settled gets the completion
        // notice. A cancel (or any external status change) that landed during
        // this step leaves the stream without a false "Task completed."
        // — the previous unconditional append wrote it onto a cancelled task.
        const settled = await Task.updateOne(
          { _id: current._id, status: 'running' },
          { $set: { status: 'done', stepCount } },
        );
        if (settled.modifiedCount) {
          await appendNotice(current._id, 'Task completed.', stepCount);
        }
        return;
      }
    }
  };
