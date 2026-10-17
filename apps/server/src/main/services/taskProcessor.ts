import type { TaskDocument } from '../models/Task';
import { Task } from '../models/Task';
import { TaskEvent, type TaskEventDocument, type TaskToolEvent } from '../models/TaskEvent';
import type { TokenUsage } from './llmTypes';
import { runTaskStep, type TaskStepOutcome } from './taskSequencer';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

/* Task processor: the worker-driven turn loop — one tick claims a task and runs its steps to a terminal or paused state; the event write is the unit a step advances on; steering drains at call boundaries; crash recovery restarts from the persisted stream. */
// @see #254 #251

const MAX_NOTICE_CHARS = 500;

// The persistable event fields, as a plain shape — `TaskEventDocument.model` collides with mongoose's own `model()` method and resolves to the wrong type.
export interface TaskEventInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  step: number;
  model?: string;
  provider?: string;
  tools?: TaskToolEvent[];
  usage?: TokenUsage;
}

// Two writers can race for the same seq (poller + API steering); the unique index is the guard — re-read max seq and retry rather than surface a 500.
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

// Append one event at the next seq, retried on the unique-index collision (the single poller writer never collides; the retry covers the API's second writer).
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

// A visible system notice, rendered like content but never fed back as model context; `step` is the notice's step ordinal, passed explicitly (the claimed header is stale once the loop runs).
const appendNotice = (taskId: TaskDocument['_id'], content: string, step: number): Promise<void> =>
  appendTaskEvent(taskId, {
    role: 'system',
    content: content.slice(0, MAX_NOTICE_CHARS),
    step,
  });

export const processTaskJob = async (task: TaskDocument): Promise<void> =>
  makeTaskProcessor(runTaskStep)(task);

// Injectable step runner: production uses the live roster race; tests inject a deterministic fake — the seam is the whole model call.
export type TaskStepRunner = (
  task: TaskDocument,
  events: TaskEventDocument[],
) => Promise<TaskStepOutcome>;

export const makeTaskProcessor =
  (runStep: TaskStepRunner) =>
  async (task: TaskDocument): Promise<void> => {
    // Re-read the claimed task and the stream; on a resume these already carry the prior steps.
    const claimed = (await Task.findById(task._id)) ?? task;
    let stepCount = claimed.stepCount;

    for (;;) {
      // Re-read the header before each step: cancel (or any external status change) is observed at this boundary, the same one steering drains at.
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

      // The step's text is the driver's read on whether the task is done: a tool-only step continues; a text step with no tool calls is the final answer.
      if (outcome.text.trim() !== '' && outcome.tools.length === 0) {
        // Settle first, then announce: only a task still `running` settles to `done` and only a settled task gets the notice, so a cancel landing mid-step never writes a false "Task completed."
        const settled = await Task.updateOne(
          { _id: current._id, status: 'running' },
          { $set: { status: 'done', stepCount } },
        );
        if (settled.modifiedCount) {
          await appendNotice(current._id, 'Task completed.', stepCount);
          // Embed the settled task's stream for semantic retrieval: fire-and-forget, flag-gated, after the notice so the final answer is included; only a done task is embedded.
          // @see #294
          const taskEvents = await TaskEvent.find({
            taskId: current._id,
            role: { $in: ['user', 'assistant'] },
          })
            .sort({ seq: 1 })
            .select('role content')
            .lean();
          enqueueWorkspaceEmbedding({
            userId: String(current.userId),
            kind: 'task',
            sourceId: String(current._id),
            source: { kind: 'task', events: taskEvents },
          });
        }
        return;
      }
    }
  };
