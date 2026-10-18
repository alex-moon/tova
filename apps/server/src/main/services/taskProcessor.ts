import type { TaskDocument } from '../models/Task';
import { Task } from '../models/Task';
import { TaskEvent, type TaskEventDocument, type TaskToolEvent } from '../models/TaskEvent';
import type { TokenUsage } from './llmTypes';
import { runTaskStep, type TaskStepOutcome } from './taskSequencer';
import { enqueueWorkspaceEmbedding } from './workspaceEmbeddingIngest';

/* Worker loop: one tick claims a task and runs steps to a terminal state. */
// @see #254 #251

const MAX_NOTICE_CHARS = 500;

// Plain event shape: TaskEventDocument.model collides with mongoose's model().
export interface TaskEventInput {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  step: number;
  model?: string;
  provider?: string;
  tools?: TaskToolEvent[];
  usage?: TokenUsage;
}

// Unique index guards the seq race; re-read and retry on collision.
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

// Append one event at the next seq, retried on duplicate-key collision.
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

// A visible system notice, never fed back as model context.
const appendNotice = (taskId: TaskDocument['_id'], content: string, step: number): Promise<void> =>
  appendTaskEvent(taskId, {
    role: 'system',
    content: content.slice(0, MAX_NOTICE_CHARS),
    step,
  });

export const processTaskJob = async (task: TaskDocument): Promise<void> =>
  makeTaskProcessor(runTaskStep)(task);

// Injectable step runner: production races the roster; tests inject a fake.
export type TaskStepRunner = (
  task: TaskDocument,
  events: TaskEventDocument[],
) => Promise<TaskStepOutcome>;

export const makeTaskProcessor =
  (runStep: TaskStepRunner) =>
  async (task: TaskDocument): Promise<void> => {
    // Re-read the claimed task; on a resume it carries prior steps.
    const claimed = (await Task.findById(task._id)) ?? task;
    let stepCount = claimed.stepCount;

    for (;;) {
      // Re-read the header before each step; cancel is observed here.
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

      // A text step with no tool calls is the driver's final answer.
      if (outcome.text.trim() !== '' && outcome.tools.length === 0) {
        // Settle guarded on running; a cancel mid-step never false-announces.
        const settled = await Task.updateOne(
          { _id: current._id, status: 'running' },
          { $set: { status: 'done', stepCount } },
        );
        if (settled.modifiedCount) {
          await appendNotice(current._id, 'Task completed.', stepCount);
          // Embed the settled stream; after the notice so the answer is in.
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
