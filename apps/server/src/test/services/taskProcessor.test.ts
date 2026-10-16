import { Task } from '../../main/models/Task';
import { TaskEvent } from '../../main/models/TaskEvent';
import { claimNextTask, enqueueTask } from '../../main/services/taskService';
import { makeTaskProcessor, type TaskStepRunner } from '../../main/services/taskProcessor';
import type { TaskStepOutcome } from '../../main/services/taskSequencer';

// #254 sequencer loop: the worker-driven turn loop over the task stream, tested
// with an injected step runner so no provider, roster, or clock is needed. The
// real step runner (`runTaskStep`) is unit-pinned in `taskSequencer.test.ts`.

const blankStep = (overrides: Partial<TaskStepOutcome> = {}): TaskStepOutcome => ({
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  provider: 'deepinfra',
  text: '',
  tools: [],
  ...overrides,
});

const enqueue = (overrides: Partial<Parameters<typeof enqueueTask>[0]> = {}) =>
  enqueueTask({
    userId: '000000000000000000000000',
    instruction: 'do the thing',
    maxSteps: 25,
    maxCostUsd: 5,
    ...overrides,
  });

const eventsOf = (id: unknown) => TaskEvent.find({ taskId: id }).sort({ seq: 1 });

describe('processTaskJob sequencer loop (#254)', () => {
  it('runs steps until a text-only step completes the task', async () => {
    const task = await enqueue();
    const claimed = await claimNextTask();
    const steps: TaskStepOutcome[] = [
      blankStep({
        tools: [{ phase: 'result', name: 'read_file', label: 'Read file', status: 'ok' }],
      }),
      blankStep({ text: 'all done' }),
    ];
    const runStep: TaskStepRunner = jest.fn().mockImplementation(async () => steps.shift()!);

    await makeTaskProcessor(runStep)(claimed!);

    expect(runStep).toHaveBeenCalledTimes(2);
    const settled = await Task.findById(task._id);
    expect(settled?.status).toBe('done');
    expect(settled?.stepCount).toBe(2);

    const events = await eventsOf(task._id);
    // seed user, assistant step 0 (tool), assistant step 1 (text), system completion.
    expect(events.map((e) => e.role)).toEqual(['user', 'assistant', 'assistant', 'system']);
    expect(events[1].tools?.[0].name).toBe('read_file');
    expect(events[2].content).toBe('all done');
    expect(events[3].content).toMatch(/completed/i);
    // The notice belongs to the last-completed step (2), not the claim-time 0.
    expect(events[3].step).toBe(2);
  });

  it('enqueues a task embedding when the task settles to done (#294)', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const enqueueEmbed = jest.spyOn(
      jest.requireActual<typeof import('../../main/services/workspaceEmbeddingIngest')>(
        '../../main/services/workspaceEmbeddingIngest',
      ),
      'enqueueWorkspaceEmbedding',
    );
    const task = await enqueue();
    const claimed = await claimNextTask();
    const runStep: TaskStepRunner = jest.fn().mockResolvedValue(blankStep({ text: 'all done' }));

    try {
      await makeTaskProcessor(runStep)(claimed!);
      expect(enqueueEmbed).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'task', sourceId: String(task._id) }),
      );
    } finally {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
      enqueueEmbed.mockRestore();
    }
  });

  it('does not enqueue an embedding when the task pauses at the step budget (#294)', async () => {
    process.env.WORKSPACE_MEMORY_ENABLED = '1';
    const enqueueEmbed = jest.spyOn(
      jest.requireActual<typeof import('../../main/services/workspaceEmbeddingIngest')>(
        '../../main/services/workspaceEmbeddingIngest',
      ),
      'enqueueWorkspaceEmbedding',
    );
    const task = await enqueue({ maxSteps: 1 });
    const claimed = await claimNextTask();
    const runStep: TaskStepRunner = jest
      .fn()
      .mockResolvedValue(
        blankStep({ tools: [{ phase: 'result', name: 'read_file', label: 'Read', status: 'ok' }] }),
      );

    try {
      await makeTaskProcessor(runStep)(claimed!);
      const settled = await Task.findById(task._id);
      expect(settled?.status).toBe('paused');
      expect(enqueueEmbed).not.toHaveBeenCalled();
    } finally {
      delete process.env.WORKSPACE_MEMORY_ENABLED;
      enqueueEmbed.mockRestore();
    }
  });

  it('pauses at the step budget with a visible system event', async () => {
    const task = await enqueue({ maxSteps: 2 });
    const claimed = await claimNextTask();
    const runStep: TaskStepRunner = jest.fn().mockResolvedValue(blankStep());

    await makeTaskProcessor(runStep)(claimed!);

    expect(runStep).toHaveBeenCalledTimes(2);
    const settled = await Task.findById(task._id);
    expect(settled?.status).toBe('paused');
    expect(settled?.stepCount).toBe(2);
    expect(settled?.lastError).toMatch(/step budget/);
    const events = await eventsOf(task._id);
    expect(events.at(-1)?.role).toBe('system');
    expect(events.at(-1)?.content).toMatch(/budget/);
    expect(events.at(-1)?.step).toBe(2);
  });

  it('feeds queued steering to the next step boundary (D2)', async () => {
    const task = await enqueue();
    const claimed = await claimNextTask();
    // Simulate a steering instruction queued while step 0 is in flight.
    const seen: number[] = [];
    const runStep: TaskStepRunner = jest.fn().mockImplementation(async (_t, events) => {
      seen.push(events.filter((e) => e.role === 'user').length);
      if (seen.length === 1) {
        await TaskEvent.create({
          taskId: task._id,
          seq: (await eventsOf(task._id)).length,
          role: 'user',
          content: 'also do X',
        });
        return blankStep({
          tools: [{ phase: 'result', name: 'read_file', label: 'r', status: 'ok' }],
        });
      }
      return blankStep({ text: 'done' });
    });

    await makeTaskProcessor(runStep)(claimed!);

    // Step 0 sees the seed instruction; step 1 sees the seed + the steering turn.
    expect(seen).toEqual([1, 2]);
  });

  it('resumes from the persisted stream after a crash (D4)', async () => {
    const task = await enqueue();
    const claimed = await claimNextTask();
    // A prior run wrote step 0 and was killed before settling (stale-requeue).
    await TaskEvent.create({
      taskId: task._id,
      seq: 1,
      role: 'assistant',
      content: '',
      step: 0,
      tools: [{ phase: 'result', name: 'read_file', label: 'r', status: 'ok' }],
    });
    await Task.updateOne({ _id: task._id }, { $set: { stepCount: 1 } });

    const runStep: TaskStepRunner = jest.fn().mockResolvedValue(blankStep({ text: 'finished' }));
    await makeTaskProcessor(runStep)(claimed!);

    const settled = await Task.findById(task._id);
    expect(settled?.status).toBe('done');
    // Continued from step 1 — the pre-crash step was not re-run.
    expect(settled?.stepCount).toBe(2);
    const events = await eventsOf(task._id);
    // seed user (0), pre-crash assistant (1), resumed assistant (2), completion (3).
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('stops at the next step boundary when the task is cancelled mid-run (D13)', async () => {
    const task = await enqueue();
    const claimed = await claimNextTask();
    let calls = 0;
    const runStep: TaskStepRunner = jest.fn().mockImplementation(async () => {
      calls += 1;
      // A cancel lands while the first step is in flight (the API's header
      // write). The loop must observe it before issuing step 1 and return
      // without settling the task back to `done`.
      if (calls === 1) await Task.updateOne({ _id: task._id }, { $set: { status: 'cancelled' } });
      return blankStep({
        tools: [{ phase: 'result', name: 'read_file', label: 'r', status: 'ok' }],
      });
    });

    await makeTaskProcessor(runStep)(claimed!);

    expect(runStep).toHaveBeenCalledTimes(1);
    expect((await Task.findById(task._id))?.status).toBe('cancelled');
  });

  it('does not write a false completion notice when a cancel lands during the final step', async () => {
    const task = await enqueue();
    const claimed = await claimNextTask();
    const runStep: TaskStepRunner = jest.fn().mockImplementation(async () => {
      // The cancel arrives while the *final* (text-only) step is in flight, so
      // the loop never gets another top-of-loop re-read to observe it. The
      // completion branch must settle-and-announce guardedly, not append a
      // "Task completed." onto a task that was cancelled.
      await Task.updateOne({ _id: task._id }, { $set: { status: 'cancelled' } });
      return blankStep({ text: 'finished anyway' });
    });

    await makeTaskProcessor(runStep)(claimed!);

    expect((await Task.findById(task._id))?.status).toBe('cancelled');
    const events = await eventsOf(task._id);
    expect(events.some((e) => e.role === 'system' && /completed/i.test(e.content))).toBe(false);
  });
});

describe('appendTaskEvent seq allocation (#254)', () => {
  it('appends after any existing stream events', async () => {
    const task = await enqueue({ instruction: undefined });
    await TaskEvent.create({ taskId: task._id, seq: 0, role: 'user', content: 'seed' });
    const { appendTaskEvent } = await import('../../main/services/taskProcessor');
    await appendTaskEvent(task._id, { role: 'system', content: 'note', step: 0 });
    const events = await eventsOf(task._id);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('retries the seq on a duplicate-key collision from a concurrent writer (D12)', async () => {
    const task = await enqueue({ instruction: undefined });
    const { appendTaskEvent } = await import('../../main/services/taskProcessor');
    // The pre-existing event the "other writer" landed at seq 0.
    await TaskEvent.create({ taskId: task._id, seq: 0, role: 'user', content: 'other' });
    // A concurrent writer already took the next seq, so the first insert here
    // collides with the unique index. Force it deterministically: the first
    // `create` throws the 11000 a real collision raises, then delegates to the
    // real implementation. The retry must re-read max-seq and land at 1.
    const realCreate = TaskEvent.create.bind(TaskEvent);
    let thrown = false;
    const spy = jest.spyOn(TaskEvent, 'create').mockImplementation((async (doc: unknown) => {
      if (!thrown) {
        thrown = true;
        const err = new Error('E11000 duplicate key') as Error & { code: number };
        err.code = 11000;
        throw err;
      }
      return realCreate(doc as never);
    }) as never);

    await appendTaskEvent(task._id, { role: 'user', content: 'a', step: 0 });

    spy.mockRestore();
    const events = await eventsOf(task._id);
    expect(events.map((e) => [e.seq, e.content])).toEqual([
      [0, 'other'],
      [1, 'a'],
    ]);
  });
});
