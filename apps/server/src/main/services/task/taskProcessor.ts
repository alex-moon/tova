import type { TaskDocument } from '../../models/Task';
import { Task } from '../../models/Task';
import { TaskEvent, type TaskEventDocument, type TaskToolEvent } from '../../models/TaskEvent';
import type { TokenUsage, LlmProvider } from '../llm/llmTypes';
import { priceRowsForModel } from '../model/modelDefaults';
import { estimateCostUsd } from '../trace/traceStatsCost';
import { runTaskStep, type TaskStepOpts, type TaskStepOutcome } from './taskSequencer';
import { enqueueWorkspaceEmbedding } from '../workspace/workspaceEmbeddingIngest';

/* Worker loop: one tick claims a task and runs steps to a terminal state. */
// @see #254 #251 #395

const MAX_NOTICE_CHARS = 500;

// Heartbeat period; the sweep cutoff is 5 min, so 60s keeps a live step safe.
const TASK_HEARTBEAT_MS = 60_000;

// Abort registry: a Set per task, since a stale twin may still hold a run;
// cancel must reach every live controller, release removes only its own.
// @see #395
const activeAborts = new Map<string, Set<AbortController>>();

export const registerTaskAbort = (taskId: string): AbortSignal => {
  const controller = new AbortController();
  const controllers = activeAborts.get(taskId) ?? new Set<AbortController>();
  controllers.add(controller);
  activeAborts.set(taskId, controllers);
  return controller.signal;
};

export const abortTaskRun = (taskId: string): void => {
  for (const controller of activeAborts.get(taskId) ?? []) controller.abort();
};

const releaseTaskAbort = (taskId: string, signal: AbortSignal): void => {
  const controllers = activeAborts.get(taskId);
  if (!controllers) return;
  for (const controller of controllers) {
    if (controller.signal === signal) {
      controllers.delete(controller);
      break;
    }
  }
  if (controllers.size === 0) activeAborts.delete(taskId);
};

// Step cost from reported usage; absent usage or an unpriced model is null.
const stepCost = (outcome: TaskStepOutcome): number | null => {
  if (!outcome.usage) return null;
  const row = priceRowsForModel(outcome.model)[outcome.provider as LlmProvider];
  return estimateCostUsd(
    outcome.usage.inputTokens ?? 0,
    outcome.usage.outputTokens ?? 0,
    row ?? null,
  );
};

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
  opts?: TaskStepOpts,
) => Promise<TaskStepOutcome>;

export const makeTaskProcessor =
  (runStep: TaskStepRunner) =>
  async (task: TaskDocument): Promise<void> => {
    // Re-read the claimed task; on a resume it carries prior steps.
    const claimed = (await Task.findById(task._id)) ?? task;
    let stepCount = claimed.stepCount;
    const taskId = String(task._id);
    // Claim lease: a swept-and-reclaimed task rotates the token, so a frozen
    // twin's reads and writes miss and it exits instead of double-running.
    // @see #395
    const lease = task.leaseToken ?? null;

    for (;;) {
      // Re-read the header before each step; cancel is observed here.
      const current = lease
        ? await Task.findOne({ _id: task._id, leaseToken: lease })
        : ((await Task.findById(task._id)) ?? claimed);
      if (!current || current.status !== 'running') return;
      const maxSteps = current.budget.maxSteps;

      if (stepCount >= maxSteps) {
        await appendNotice(
          current._id,
          `Task paused: reached its step budget (${maxSteps} steps).`,
          stepCount,
        );
        await Task.updateOne(
          { _id: current._id, ...(lease ? { leaseToken: lease } : {}), status: 'running' },
          { $set: { status: 'paused', stepCount, lastError: 'step budget reached' } },
        );
        return;
      }

      // Cost budget: pause before the next spend, mirroring the step cap.
      // @see #395
      const spent = current.budget.spentUsd ?? 0;
      if (spent >= current.budget.maxCostUsd) {
        await appendNotice(
          current._id,
          `Task paused: reached its cost budget ($${spent.toFixed(2)} of $${current.budget.maxCostUsd.toFixed(2)} estimated).`,
          stepCount,
        );
        await Task.updateOne(
          { _id: current._id, ...(lease ? { leaseToken: lease } : {}), status: 'running' },
          { $set: { status: 'paused', stepCount, lastError: 'cost budget reached' } },
        );
        return;
      }

      const events = await TaskEvent.find({ taskId: current._id }).sort({ seq: 1 });
      // Heartbeat: a long legitimate step must not look dead to the sweep.
      // @see #395
      const signal = registerTaskAbort(taskId);
      const heartbeat = setInterval(() => {
        void Task.updateOne(
          {
            _id: current._id,
            ...(lease ? { leaseToken: lease } : {}),
            status: 'running',
          },
          { $set: { updatedAt: new Date() } },
        ).catch(() => undefined);
      }, TASK_HEARTBEAT_MS);
      let outcome: TaskStepOutcome;
      try {
        // Cancel can land between the header read and this registration;
        // re-verify the lease before spending on the step. @see #395
        const owned = await Task.countDocuments({
          _id: current._id,
          status: 'running',
          ...(lease ? { leaseToken: lease } : {}),
        });
        if (!owned) return;
        outcome = await runStep(current, events, { signal });
      } finally {
        clearInterval(heartbeat);
        releaseTaskAbort(taskId, signal);
      }

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
      const cost = stepCost(outcome);
      await Task.updateOne(
        { _id: current._id, ...(lease ? { leaseToken: lease } : {}) },
        {
          $set: { stepCount },
          ...(cost !== null ? { $inc: { 'budget.spentUsd': cost } } : {}),
        },
      );

      // A text step with no tool calls is the driver's final answer.
      if (outcome.text.trim() !== '' && outcome.tools.length === 0) {
        // Settle guarded on running; a cancel mid-step never false-announces.
        const settled = await Task.updateOne(
          { _id: current._id, ...(lease ? { leaseToken: lease } : {}), status: 'running' },
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
