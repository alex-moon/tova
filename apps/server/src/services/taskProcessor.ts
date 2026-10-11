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

// Append one event at the next seq. Read-max-then-insert, not an atomic
// counter: safe because the stream has a single writer (the epic's
// single-writer-per-stream invariant) and the poller is single-consumer. The
// `{taskId, seq}` unique index still catches a violation rather than letting
// it corrupt the order.
export const appendTaskEvent = async (
  taskId: TaskDocument['_id'],
  event: TaskEventInput,
): Promise<void> => {
  const last = await TaskEvent.findOne({ taskId }).sort({ seq: -1 });
  const seq = (last?.seq ?? -1) + 1;
  await TaskEvent.create({ taskId, seq, ...event });
};

// A visible system notice (budget breach, completion), rendered like content
// but never fed back as model context (`assembleTaskHistory` skips `system`).
const appendNotice = (task: TaskDocument, content: string): Promise<void> =>
  appendTaskEvent(task._id, {
    role: 'system',
    content: content.slice(0, MAX_NOTICE_CHARS),
    step: task.stepCount,
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
    const current = (await Task.findById(task._id)) ?? task;
    let stepCount = current.stepCount;
    const maxSteps = current.budget.maxSteps;

    for (;;) {
      if (stepCount >= maxSteps) {
        await appendNotice(current, `Task paused: reached its step budget (${maxSteps} steps).`);
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
        await appendNotice(current, 'Task completed.');
        await Task.updateOne(
          { _id: current._id, status: 'running' },
          { $set: { status: 'done', stepCount } },
        );
        return;
      }
    }
  };
