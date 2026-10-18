import { RequestContext } from '@mastra/core/request-context';
import { User } from '../../main/models/User';
import { Task } from '../../main/models/Task';
import { TaskEvent } from '../../main/models/TaskEvent';
import { delegateTaskTool } from '../../main/services/mastraService';

/* `delegate_task`: createTool is identity; `execute` runs direct. */
// @see #255

const execute = (
  delegateTaskTool as unknown as {
    execute: (
      args: { instruction: string },
      ctx: unknown,
    ) => Promise<{ taskId?: string; error?: string }>;
  }
).execute;

const asCtx = (userId?: string, sessionId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  if (sessionId) requestContext.set('sessionId', sessionId);
  return { requestContext };
};

const seedUser = (zdr = false) =>
  User.create({ email: 'u@example.com', passwordHash: 'x', settings: { zdr } });

describe('delegate_task (#255)', () => {
  it('creates a task with a chat origin and the initial instruction', async () => {
    const user = await seedUser();
    const result = await execute(
      { instruction: 'research the topic' },
      asCtx(String(user._id), 'sess-1'),
    );

    expect(result.error).toBeUndefined();
    expect(result.taskId).toBeTruthy();
    const task = await Task.findById(result.taskId);
    expect(task?.status).toBe('queued');
    expect(task?.origin?.kind).toBe('chat');
    expect(task?.origin?.sessionId).toBe('sess-1');
    expect(task?.instruction).toBe('research the topic');
    // The stream's first event is the instruction (D1).
    const first = await TaskEvent.findOne({ taskId: task!._id }).sort({ seq: 1 });
    expect(first?.role).toBe('user');
    expect(first?.content).toBe('research the topic');
  });

  it('refuses when the turn has no session (e.g. a ZDR turn) and writes nothing', async () => {
    const user = await seedUser();
    const result = await execute({ instruction: 'x' }, asCtx(String(user._id)));
    expect(result.taskId).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(await Task.countDocuments()).toBe(0);
  });

  it('refuses for a ZDR account, mirroring the creation route', async () => {
    const user = await seedUser(true);
    const result = await execute({ instruction: 'x' }, asCtx(String(user._id), 'sess-1'));
    expect(result.taskId).toBeUndefined();
    expect(result.error).toMatch(/zero-data-retention/i);
    expect(await Task.countDocuments()).toBe(0);
  });

  it('refuses when there is no user on the context', async () => {
    const result = await execute({ instruction: 'x' }, asCtx());
    expect(result.taskId).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});
