import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { enqueueTask, claimNextTask } from './taskService';
import { processTaskJob } from './taskProcessor';

// #254 foundation: until the sequencer lands, a claimed task pauses with a
// visible system event rather than being silently marked done.

describe('processTaskJob (#254 foundation)', () => {
  it('pauses the task and records a visible system event', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      instruction: 'do the thing',
      maxSteps: 25,
      maxCostUsd: 5,
    });
    const claimed = await claimNextTask();
    expect(String(claimed?._id)).toBe(String(task._id));

    await processTaskJob(claimed!);

    const settled = await Task.findById(task._id);
    expect(settled?.status).toBe('paused');
    expect(settled?.lastError).toMatch(/not yet implemented/);

    const events = await TaskEvent.find({ taskId: task._id }).sort({ seq: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].role).toBe('system');
    expect(events[0].content).toMatch(/paused/);
  });

  it('appends after any existing stream events', async () => {
    const task = await enqueueTask({
      userId: '000000000000000000000000',
      maxSteps: 25,
      maxCostUsd: 5,
    });
    await TaskEvent.create({ taskId: task._id, seq: 0, role: 'user', content: 'seed' });
    const claimed = await claimNextTask();
    await processTaskJob(claimed!);
    const events = await TaskEvent.find({ taskId: task._id }).sort({ seq: 1 });
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });
});
