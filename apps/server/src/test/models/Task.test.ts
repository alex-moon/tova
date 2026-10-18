import mongoose from 'mongoose';
import { Task } from '../../main/models/Task';
import { Message } from '../../main/models/Message';

const validBudget = { maxSteps: 25, maxCostUsd: 5 };

const createTask = (overrides: Record<string, unknown> = {}) =>
  Task.create({
    userId: new mongoose.Types.ObjectId(),
    budget: validBudget,
    ...overrides,
  });

describe('Task model (#254)', () => {
  it('defaults status to queued and stepCount/attempts to 0', async () => {
    const task = await createTask();
    expect(task.status).toBe('queued');
    expect(task.stepCount).toBe(0);
    expect(task.attempts).toBe(0);
    expect(task.instruction).toBe('');
  });

  it('rejects a status outside the enum', async () => {
    await expect(createTask({ status: 'alien' })).rejects.toThrow();
  });

  it('leaves origin absent for a direct-origin task (absence preserved)', async () => {
    const task = await createTask();
    expect(task.origin).toBeUndefined();
  });

  it('round-trips a chat origin with sessionId', async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    const task = await createTask({ origin: { kind: 'chat', sessionId } });
    expect(task.origin?.kind).toBe('chat');
    expect(task.origin?.sessionId).toBe(sessionId);
  });

  it('round-trips a direct origin', async () => {
    const task = await createTask({ origin: { kind: 'direct' } });
    expect(task.origin?.kind).toBe('direct');
  });

  it('rejects an origin kind outside the enum', async () => {
    await expect(createTask({ origin: { kind: 'alien' } })).rejects.toThrow();
  });

  it('requires a budget (maxSteps/maxCostUsd)', async () => {
    await expect(Task.create({ userId: new mongoose.Types.ObjectId() })).rejects.toThrow();
    await expect(
      Task.create({ userId: new mongoose.Types.ObjectId(), budget: { maxSteps: 1 } }),
    ).rejects.toThrow();
  });

  it('defaults budget.spentUsd to 0', async () => {
    expect((await createTask()).budget.spentUsd).toBe(0);
  });

  it('does not entangle the Message schema with tasks (slice invariant)', async () => {
    // `Message` must never learn about tasks; its schema must stay untouched.
    expect(Message.schema.path('taskId')).toBeUndefined();
    const taskRef = Object.values(Message.schema.paths).some(
      (p) => (p as unknown as { options?: { ref?: string } }).options?.ref === 'Task',
    );
    expect(taskRef).toBe(false);
  });
});
