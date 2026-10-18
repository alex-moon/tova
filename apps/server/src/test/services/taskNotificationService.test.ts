import { Task } from '../../main/models/Task';
import {
  completionNotificationLine,
  markNotified,
  pendingCompletionsFor,
} from '../../main/services/taskNotificationService';

// The completion-notification drain, Mongo-backed on the in-memory Mongo.
// @see #255
const UID = '000000000000000000000000';

const makeTask = (extra: Record<string, unknown> = {}) =>
  Task.create({
    userId: UID,
    status: 'done',
    budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
    ...extra,
  });

describe('pendingCompletionsFor (#255)', () => {
  it('returns only done origin tasks for this session not yet notified', async () => {
    await makeTask({ origin: { kind: 'chat', sessionId: 's1' }, instruction: 'a' });
    await makeTask({ origin: { kind: 'chat', sessionId: 's2' }, instruction: 'b' });
    await makeTask({
      origin: { kind: 'chat', sessionId: 's1' },
      instruction: 'c',
      status: 'running',
    });
    await makeTask({
      origin: { kind: 'chat', sessionId: 's1' },
      instruction: 'd',
      notifiedAt: new Date(),
    });
    await makeTask({ instruction: 'e' });

    const pending = await pendingCompletionsFor(UID, 's1');
    expect(pending.map((t) => t.instruction)).toEqual(['a']);
  });

  it('scopes by user — another user’s task is never drained', async () => {
    await makeTask({
      userId: '000000000000000000000001',
      origin: { kind: 'chat', sessionId: 's1' },
      instruction: 'other',
    });
    expect(await pendingCompletionsFor(UID, 's1')).toEqual([]);
  });
});

describe('markNotified (#255)', () => {
  it('sets notifiedAt and removes the task from the pending set', async () => {
    const task = await makeTask({ origin: { kind: 'chat', sessionId: 's1' } });
    expect((await pendingCompletionsFor(UID, 's1')).length).toBe(1);

    await markNotified([task._id]);
    const after = await Task.findById(task._id);
    expect(after?.notifiedAt).toBeInstanceOf(Date);
    expect(await pendingCompletionsFor(UID, 's1')).toEqual([]);
  });

  it('is a no-op for an empty list', async () => {
    await expect(markNotified([])).resolves.toBeUndefined();
  });

  it('does not re-mark an already-notified task (exactly-once)', async () => {
    const task = await makeTask({ origin: { kind: 'chat', sessionId: 's1' } });
    await markNotified([task._id]);
    const first = (await Task.findById(task._id))!.notifiedAt;
    await markNotified([task._id]);
    expect((await Task.findById(task._id))!.notifiedAt).toEqual(first);
  });
});

describe('completionNotificationLine (#255)', () => {
  it('names the task and includes the summary', () => {
    const line = completionNotificationLine(
      { instruction: 'research X' } as never,
      'Here is what I found.',
    );
    expect(line).toContain('research X');
    expect(line).toContain('Here is what I found.');
  });

  it('clips a long summary', () => {
    const line = completionNotificationLine({ instruction: 'x' } as never, 'y'.repeat(2000));
    expect(line.length).toBeLessThan(800);
    expect(line.endsWith('…')).toBe(true);
  });

  it('clips a long instruction too (a 4000-char instruction cannot dominate)', () => {
    const line = completionNotificationLine({ instruction: 'i'.repeat(4000) } as never, 'done');
    expect(line.length).toBeLessThan(900);
  });

  it('handles an empty summary honestly', () => {
    const line = completionNotificationLine({ instruction: 'x' } as never, '');
    expect(line).toContain('without a text summary');
  });
});
