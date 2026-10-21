import request from 'supertest';
import { createApp } from '../../main/index';
import { User } from '../../main/models/User';
import { Session } from '../../main/models/Session';
import { Task } from '../../main/models/Task';

const mockPlainGenerate = jest.fn();

jest.mock('../../main/services/llm/inferenceService', () => ({
  inferenceService: {
    createCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createToolFreeCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
    createStreamingCompletion: (...args: unknown[]) => mockPlainGenerate(...args),
  },
}));

jest.mock('../../main/services/metricsService', () => ({
  classifyAndPersistPromptDimensions: jest.fn().mockResolvedValue(undefined),
  isTriviallyNeutral: (content: string) => content.trim().length === 0,
}));

jest.mock('../../main/services/llm/followupService', () => ({
  generateFollowups: jest.fn().mockResolvedValue([]),
}));

// No vote to stub; trace-fact helpers stay real for route metadata.
// @see #310
jest.mock('../../main/services/workspace/workspaceTraceFacts', () =>
  jest.requireActual('../../main/services/workspace/workspaceTraceFacts'),
);

const MOCK_ROUTING = { model: 'mock-small-model', provider: 'deepinfra', reason: 'fixed-model' };

jest.mock('../../main/services/llm/chatRace', () => {
  const { inferenceService } = jest.requireMock('../../main/services/llm/inferenceService');
  return {
    chatRoute: () => MOCK_ROUTING,
    raceChatCompletion: async (opts: Record<string, unknown>) => {
      const completion = await inferenceService.createCompletion(opts);
      return { routing: MOCK_ROUTING, completion };
    },
    raceChatStream: async (opts: Record<string, unknown>) => {
      const stream = await inferenceService.createStreamingCompletion(opts);
      return { routing: MOCK_ROUTING, stream };
    },
  };
});

jest.mock('../../main/services/llm/titleService', () => ({
  generateChatTitle: jest.fn().mockResolvedValue('Hello'),
}));

const app = createApp();

const registerUser = async (email: string): Promise<{ id: string; cookies: string[] }> => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  await User.updateOne({ email }, { permissions: ['routing'] });
  const cookies = response.headers['set-cookie'];
  const user = await User.findOne({ email });
  return { id: String(user!._id), cookies: Array.isArray(cookies) ? cookies : [cookies] };
};

const completedTask = (userId: string, sessionId: string, instruction = 'research X') =>
  Task.create({
    userId,
    status: 'done',
    origin: { kind: 'chat', sessionId },
    instruction,
    budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
  });

const systemMessagesOf = (callIndex = 0): string[] => {
  const callOptions = mockPlainGenerate.mock.calls[callIndex][0] as {
    messages: { role: string; content: string }[];
  };
  return callOptions.messages.filter((m) => m.role === 'system').map((m) => m.content);
};

describe('task completion drain (#255)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlainGenerate.mockResolvedValue({
      choices: [{ message: { content: 'acknowledged' } }],
    });
  });

  it('folds a completed origin task into the next turn and marks it notified', async () => {
    const { id, cookies } = await registerUser('drain@example.com');
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'start' });
    const sessionId = first.body.sessionId as string;

    const task = await completedTask(id, sessionId);
    // A real result on the task stream (the last non-empty assistant step).
    const { TaskEvent } = await import('../../main/models/TaskEvent');
    await TaskEvent.create({
      taskId: task._id,
      seq: 0,
      role: 'assistant',
      content: 'The finding is 42.',
      step: 0,
    });

    mockPlainGenerate.mockClear();
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'and now?' });

    const system = systemMessagesOf().join('\n');
    expect(system).toContain('<task:completed>');
    expect(system).toContain('research X');
    expect(system).toContain('The finding is 42.');

    const after = await Task.findById(task._id);
    expect(after?.notifiedAt).toBeInstanceOf(Date);
  });

  it('does not re-surface a task on a later turn (exactly once)', async () => {
    const { id, cookies } = await registerUser('once@example.com');
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'start' });
    const sessionId = first.body.sessionId as string;
    await completedTask(id, sessionId);

    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'turn 2' });
    mockPlainGenerate.mockClear();
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'turn 3' });

    expect(systemMessagesOf().join('\n')).not.toContain('<task:completed>');
  });

  it('ignores a completed task with no origin session (direct-origin)', async () => {
    const { id, cookies } = await registerUser('direct@example.com');
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'start' });
    const sessionId = first.body.sessionId as string;
    await Task.create({
      userId: id,
      status: 'done',
      instruction: 'direct work',
      budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
    });

    mockPlainGenerate.mockClear();
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'next' });

    expect(systemMessagesOf().join('\n')).not.toContain('<task:completed>');
  });

  it('leaves an otherwise-identical turn untouched when nothing is pending', async () => {
    const { cookies } = await registerUser('clean@example.com');
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'start' });
    const sessionId = first.body.sessionId as string;

    mockPlainGenerate.mockClear();
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'next' });

    const system = systemMessagesOf().join('\n');
    expect(system).not.toContain('<task:completed>');
    expect(await Session.countDocuments()).toBe(1);
  });

  it('does not consume a completion when the turn fails to complete', async () => {
    const { id, cookies } = await registerUser('fail@example.com');
    const first = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ content: 'start' });
    const sessionId = first.body.sessionId as string;

    const task = await completedTask(id, sessionId);

    // The call fails; the completion must stay pending for a later turn.
    mockPlainGenerate.mockClear();
    mockPlainGenerate.mockRejectedValueOnce(new Error('provider exploded'));
    const failed = await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'and now?' });
    expect(failed.status).toBe(500);

    const afterFailure = await Task.findById(task._id);
    expect(afterFailure?.notifiedAt).toBeNull();

    // The next successful turn surfaces it.
    mockPlainGenerate.mockResolvedValue({
      choices: [{ message: { content: 'acknowledged' } }],
    });
    mockPlainGenerate.mockClear();
    await request(app)
      .post('/api/chat')
      .set('Cookie', cookies)
      .send({ sessionId, content: 'retry' });

    expect(systemMessagesOf().join('\n')).toContain('<task:completed>');
    expect((await Task.findById(task._id))?.notifiedAt).toBeInstanceOf(Date);
  });
});
