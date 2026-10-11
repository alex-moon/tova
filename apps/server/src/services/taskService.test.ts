import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import {
  MAX_TASK_ATTEMPTS,
  STALE_RUNNING_MS,
  cancelTask,
  claimNextTask,
  enqueueTask,
  isTaskPollerRunning,
  requeueStaleTasks,
  runTaskTick,
  startTaskPoller,
  steerTask,
  stopTaskPoller,
} from './taskService';
import type { TaskDocument } from '../models/Task';

// #254: Mongo-backed task queue running against the shared in-memory Mongo
// (test/setup.ts); the beforeEach wipe empties tasks between tests.

const budget = { maxSteps: 25, maxCostUsd: 5 };

const createTask = (tag = '') =>
  enqueueTask({
    userId: '000000000000000000000000',
    instruction: `do ${tag}`,
    maxSteps: budget.maxSteps,
    maxCostUsd: budget.maxCostUsd,
  });

const latestTask = async (id: string): Promise<TaskDocument | null> => Task.findById(id);

describe('enqueueTask (#254)', () => {
  it('creates a queued task with a snapshotted budget', async () => {
    const task = await createTask('enqueue');
    expect(task.status).toBe('queued');
    expect(task.budget.maxSteps).toBe(25);
    expect(task.budget.maxCostUsd).toBe(5);
    expect(task.budget.spentUsd).toBe(0);
    expect(task.instruction).toBe('do enqueue');
  });

  it('stores a chat origin when supplied and leaves it absent otherwise', async () => {
    const direct = await createTask('direct');
    expect(direct.origin).toBeUndefined();
    const withOrigin = await enqueueTask({
      userId: '000000000000000000000000',
      origin: { kind: 'chat', sessionId: 'abc' },
      maxSteps: 1,
      maxCostUsd: 1,
    });
    expect(withOrigin.origin?.kind).toBe('chat');
    expect(withOrigin.origin?.sessionId).toBe('abc');
  });
});

describe('claimNextTask (#254)', () => {
  it('claims the oldest queued task atomically and bumps attempts', async () => {
    const first = await createTask('first');
    await createTask('second');
    const claimed = await claimNextTask();
    expect(claimed?._id).toEqual(first._id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    // The claimed task is no longer claimable; the newer one still is.
    const second = await claimNextTask();
    expect(String(second?._id)).not.toBe(String(first._id));
    expect(await claimNextTask()).toBeNull();
  });
});

describe('runTaskTick (#254)', () => {
  it('marks the task done and skips when nothing is queued', async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    await runTaskTick(processor);
    expect(processor).not.toHaveBeenCalled();

    const task = await createTask('tick-success');
    await runTaskTick(processor);
    expect(processor).toHaveBeenCalledTimes(1);
    const settled = await latestTask(String(task._id));
    expect(settled?.status).toBe('done');
  });

  it('requeues a failed attempt under the retry cap and stores lastError', async () => {
    const task = await createTask('tick-retry');
    const processor = jest.fn().mockRejectedValue(new Error('boom'));
    await runTaskTick(processor);
    const afterFirst = await latestTask(String(task._id));
    expect(afterFirst?.status).toBe('queued');
    expect(afterFirst?.attempts).toBe(1);
    expect(afterFirst?.lastError).toBe('boom');
  });

  it('terminal-fails at the attempt cap', async () => {
    const task = await createTask('tick-cap');
    const processor = jest.fn().mockRejectedValue(new Error('driver exploded'));
    for (let i = 0; i < MAX_TASK_ATTEMPTS; i++) {
      await runTaskTick(processor);
    }
    const settled = await latestTask(String(task._id));
    expect(settled?.status).toBe('failed');
    expect(settled?.attempts).toBe(MAX_TASK_ATTEMPTS);
    expect(settled?.lastError).toBe('driver exploded');
  });

  it('does not clobber a paused task the processor settled itself', async () => {
    // A budget breach (D6) transitions the task to `paused` inside the
    // processor; the tick must not overwrite that with `done`.
    const task = await createTask('tick-paused');
    const processor = jest.fn().mockImplementation(async (claimed: TaskDocument) => {
      await Task.updateOne({ _id: claimed._id }, { $set: { status: 'paused' } });
    });
    await runTaskTick(processor);
    expect((await latestTask(String(task._id)))?.status).toBe('paused');
  });

  it('does not clobber a processor-settled status when the processor also throws', async () => {
    // The failure path must be symmetric with the success path: a processor
    // that pauses (D6 budget breach) and *then* throws must not be requeued by
    // the tick — the breach outcome and its recorded reason stand.
    const task = await createTask('tick-paused-throw');
    const processor = jest.fn().mockImplementation(async (claimed: TaskDocument) => {
      await Task.updateOne(
        { _id: claimed._id },
        { $set: { status: 'paused', lastError: 'budget breached' } },
      );
      throw new Error('driver exploded after settling');
    });
    await runTaskTick(processor);
    const settled = await latestTask(String(task._id));
    expect(settled?.status).toBe('paused');
    expect(settled?.lastError).toBe('budget breached');
  });
});

describe('stale `running` requeue (#254)', () => {
  const strandTask = async (ageMs: number): Promise<TaskDocument> => {
    await createTask('strand');
    const claimed = await claimNextTask();
    expect(claimed?.status).toBe('running');
    if (ageMs > 0) {
      // Backdate updatedAt past the staleness cutoff. Bypass mongoose so the
      // timestamps plugin cannot rewrite the supplied value.
      await Task.collection.updateOne(
        { _id: claimed?._id },
        { $set: { updatedAt: new Date(Date.now() - ageMs) } },
      );
    }
    return claimed as TaskDocument;
  };

  it('requeues only running tasks older than the cutoff', async () => {
    const fresh = await strandTask(0);
    const stale = await strandTask(STALE_RUNNING_MS + 1000);

    expect(await requeueStaleTasks()).toBe(1);
    expect((await latestTask(String(fresh._id)))?.status).toBe('running');
    const staleAfter = await latestTask(String(stale._id));
    expect(staleAfter?.status).toBe('queued');
    // The sweep does not charge an attempt.
    expect(staleAfter?.attempts).toBe(1);
  });

  it('a stranded running task self-heals on the next poller start', async () => {
    const task = await strandTask(STALE_RUNNING_MS + 1000);
    const processor = jest.fn().mockResolvedValue(undefined);
    startTaskPoller(processor, 10);
    await new Promise((r) => setTimeout(r, 60));
    stopTaskPoller();
    await new Promise((r) => setTimeout(r, 60));
    expect(processor).toHaveBeenCalledTimes(1);
    expect((await latestTask(String(task._id)))?.status).toBe('done');
  });
});

describe('poller lifecycle (#254)', () => {
  it('polls until stopped', async () => {
    const processor = jest.fn().mockResolvedValue(undefined);
    startTaskPoller(processor, 10);
    expect(isTaskPollerRunning()).toBe(true);
    const task = await createTask('poller');
    await new Promise((r) => setTimeout(r, 80));
    expect(processor.mock.calls.length).toBeGreaterThanOrEqual(1);
    stopTaskPoller();
    expect(isTaskPollerRunning()).toBe(false);
    const callsAtStop = processor.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(processor.mock.calls.length).toBe(callsAtStop);
    expect((await latestTask(String(task._id)))?.status).toBe('done');
  });
});

describe('steerTask / cancelTask (#254 routes slice)', () => {
  it('appends a steering user event on an active task', async () => {
    const task = await createTask('steer');
    const result = await steerTask(task, 'change of plan');
    expect(result.status).toBe('queued');
    const events = await TaskEvent.find({ taskId: task._id }).sort({ seq: 1 });
    expect(events.map((e) => [e.seq, e.role, e.content])).toEqual([
      [0, 'user', 'do steer'],
      [1, 'user', 'change of plan'],
    ]);
  });

  it('re-queues a paused task on a steering instruction (resume-as-steering, D6)', async () => {
    const task = await createTask('resume');
    await Task.updateOne({ _id: task._id }, { $set: { status: 'paused' } });
    const paused = await latestTask(String(task._id));
    const result = await steerTask(paused!, 'continue');
    expect(result.status).toBe('queued');
    expect((await latestTask(String(task._id)))?.status).toBe('queued');
  });

  it('refuses to steer a terminal task without appending (D14)', async () => {
    const task = await createTask('terminal');
    await Task.updateOne({ _id: task._id }, { $set: { status: 'done' } });
    const done = await latestTask(String(task._id));
    const result = await steerTask(done!, 'too late');
    expect(result).toEqual({ status: 'refused' });
    expect(await TaskEvent.countDocuments({ taskId: task._id })).toBe(1);
  });

  it('cancels an active task and leaves terminal tasks untouched', async () => {
    const active = await createTask('cancel');
    await cancelTask(active);
    expect((await latestTask(String(active._id)))?.status).toBe('cancelled');

    await Task.updateOne({ _id: active._id }, { $set: { status: 'done' } });
    await cancelTask((await latestTask(String(active._id)))!);
    expect((await latestTask(String(active._id)))?.status).toBe('done');
  });
});
