import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import TaskService, {
  isTerminalTask,
  TaskError,
  type TaskSummary,
} from '../../main/services/tasks';

// Pins the request contract against the server tasks route plus error mapping.
// @see #254 #251
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: (err: unknown) =>
      err instanceof Error && (err as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

const axiosGet = vi.mocked(axios.get);
const axiosPost = vi.mocked(axios.post);

const task: TaskSummary = {
  id: 't1',
  status: 'running',
  instruction: 'Do the thing',
  origin: { kind: 'direct' },
  stepCount: 2,
  budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0.0123 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  axiosGet.mockReset();
  axiosPost.mockReset();
});

describe('TaskService', () => {
  it('lists without a cursor and passes a cursor when given', async () => {
    axiosGet.mockResolvedValue({ data: { tasks: [], nextCursor: null } });
    await TaskService.list();
    expect(axiosGet).toHaveBeenCalledWith('/api/tasks', { params: {} });

    await TaskService.list('abc');
    expect(axiosGet).toHaveBeenLastCalledWith('/api/tasks', { params: { cursor: 'abc' } });
  });

  it('gets the owned task + stream', async () => {
    const detail = { task, events: [] };
    axiosGet.mockResolvedValue({ data: detail });
    await expect(TaskService.get('t1')).resolves.toEqual(detail);
    expect(axiosGet).toHaveBeenCalledWith('/api/tasks/t1');
  });

  it('posts the instruction body and unwraps the returned task', async () => {
    axiosPost.mockResolvedValue({ data: { task } });
    await expect(TaskService.instruct('t1', 'keep going')).resolves.toEqual(task);
    expect(axiosPost).toHaveBeenCalledWith('/api/tasks/t1/instruction', {
      instruction: 'keep going',
    });
  });

  it('posts cancel and unwraps the returned task', async () => {
    axiosPost.mockResolvedValue({ data: { task: { ...task, status: 'cancelled' } } });
    const result = await TaskService.cancel('t1');
    expect(result.status).toBe('cancelled');
    expect(axiosPost).toHaveBeenCalledWith('/api/tasks/t1/cancel', {});
  });

  it('lists the tasks a session started, filtered by originSessionId (#255)', async () => {
    axiosGet.mockResolvedValue({ data: { tasks: [task], nextCursor: null } });
    await expect(TaskService.listForSession('s1')).resolves.toEqual([task]);
    expect(axiosGet).toHaveBeenCalledWith('/api/tasks', {
      params: { originSessionId: 's1' },
    });
  });

  it('creates a task with a chat origin (#255)', async () => {
    axiosPost.mockResolvedValue({ data: { task } });
    await expect(TaskService.create('do it', { kind: 'chat', sessionId: 's1' })).resolves.toEqual(
      task,
    );
    expect(axiosPost).toHaveBeenCalledWith('/api/tasks', {
      instruction: 'do it',
      origin: { kind: 'chat', sessionId: 's1' },
    });
  });

  it('creates a task without an origin when none is given (#255)', async () => {
    axiosPost.mockResolvedValue({ data: { task } });
    await TaskService.create('do it');
    expect(axiosPost).toHaveBeenCalledWith('/api/tasks', { instruction: 'do it' });
  });

  it('surfaces the server message on an axios error (e.g. a 409 terminal refusal)', async () => {
    const err = new Error('Request failed with status code 409') as Error & {
      isAxiosError: boolean;
      response: { data: { message: string } };
    };
    err.isAxiosError = true;
    err.response = { data: { message: 'Task is no longer active' } };
    axiosPost.mockRejectedValue(err);

    await expect(TaskService.instruct('t1', 'x')).rejects.toThrow('Task is no longer active');
  });

  it('falls back to a generic TaskError for a non-axios failure', async () => {
    axiosGet.mockRejectedValue(new Error('boom'));
    await expect(TaskService.get('t1')).rejects.toBeInstanceOf(TaskError);
    await expect(TaskService.get('t1')).rejects.toThrow('Something went wrong with that task');
  });
});

describe('isTerminalTask', () => {
  it('treats done/failed/cancelled as terminal and the rest as active', () => {
    expect(isTerminalTask('done')).toBe(true);
    expect(isTerminalTask('failed')).toBe(true);
    expect(isTerminalTask('cancelled')).toBe(true);
    expect(isTerminalTask('queued')).toBe(false);
    expect(isTerminalTask('running')).toBe(false);
    expect(isTerminalTask('paused')).toBe(false);
  });
});
