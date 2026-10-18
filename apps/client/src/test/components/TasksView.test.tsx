import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import TasksView from '../../main/components/TasksView';
import { TaskError, type TaskDetail, type TaskSummary } from '../../main/services/tasks';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../../main/services/tasks', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/services/tasks')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      get: vi.fn(),
      instruct: vi.fn(),
      cancel: vi.fn(),
    },
  };
});

import TaskService from '../../main/services/tasks';

const task = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 't1',
  status: 'running',
  instruction: 'Summarise the newest file',
  origin: { kind: 'direct' },
  stepCount: 2,
  budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0.0123 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  task: task(),
  events: [
    { seq: 0, role: 'user', content: 'Summarise the newest file', step: 0, timestamp: '' },
    {
      seq: 1,
      role: 'assistant',
      content: 'Let me look.',
      step: 0,
      model: 'm',
      provider: 'p',
      timestamp: '',
      tools: [{ phase: 'result', name: 'list_files', label: 'Listing files', resultCount: 3 }],
    },
    { seq: 2, role: 'system', content: 'Step budget reached — task paused.', timestamp: '' },
  ],
  ...over,
});

describe('TasksView (#254 client)', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(TaskService.list).mockReset().mockResolvedValue({ tasks: [], nextCursor: null });
    vi.mocked(TaskService.get).mockReset();
    vi.mocked(TaskService.instruct).mockReset();
    vi.mocked(TaskService.cancel).mockReset();
  });

  it('lists tasks and opens the read-only stream on selection', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({ tasks: [task()], nextCursor: null });
    vi.mocked(TaskService.get).mockResolvedValue(detail());

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-t1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('task-row-t1'));

    await waitFor(() => expect(screen.getByText('Let me look.')).toBeInTheDocument());
    expect(screen.getByTestId('task-tool-summary-toggle')).toBeInTheDocument();
    // A sequencer system notice renders as a neutral, non-chat row.
    expect(screen.getByTestId('task-system-event')).toHaveTextContent('Step budget reached');
    expect(TaskService.get).toHaveBeenCalledWith('t1');
  });

  // Regression: the loader keys on the id, or its own response re-fires.
  // @see #254
  it('does not re-fetch in a loop when each response is a fresh object', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({ tasks: [task()], nextCursor: null });
    vi.mocked(TaskService.get).mockImplementation(async () => detail());

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-t1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('task-row-t1'));
    await waitFor(() => expect(screen.getByText('Let me look.')).toBeInTheDocument());

    // Give the (3s) poll a chance to run; a loop would rack up hundreds here.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(vi.mocked(TaskService.get).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('shows the empty state when there are no tasks', async () => {
    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-library-empty')).toBeInTheDocument());
  });

  // Cursor-paged list: an appended page must survive the silent poll.
  it('loads the next page and keeps it across the active poll', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(TaskService.list).mockImplementation(async (cursor?: string | null) => {
        if (!cursor) return { tasks: [task({ id: 'p1' })], nextCursor: 'cur-1' };
        if (cursor === 'cur-1') return { tasks: [task({ id: 'p2' })], nextCursor: null };
        return { tasks: [], nextCursor: null };
      });

      render(<TasksView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('task-row-p1')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('task-load-more'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId('task-row-p1')).toBeInTheDocument();
      expect(screen.getByTestId('task-row-p2')).toBeInTheDocument();
      expect(TaskService.list).toHaveBeenLastCalledWith('cur-1');
      expect(screen.queryByTestId('task-load-more')).not.toBeInTheDocument();

      // A poll tick (the running p1 keeps the list polling) must not wipe p2.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByTestId('task-row-p1')).toBeInTheDocument();
      expect(screen.getByTestId('task-row-p2')).toBeInTheDocument();
      expect(screen.queryByTestId('task-load-more')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a steering instruction for an active task', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({ tasks: [task()], nextCursor: null });
    vi.mocked(TaskService.get).mockResolvedValue(detail());
    vi.mocked(TaskService.instruct).mockResolvedValue(task());

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-t1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('task-row-t1'));
    await waitFor(() => expect(screen.getByTestId('task-instruction-input')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('task-instruction-input'), {
      target: { value: 'focus on the PDF' },
    });
    fireEvent.click(screen.getByTestId('task-instruction-send'));

    await waitFor(() =>
      expect(TaskService.instruct).toHaveBeenCalledWith('t1', 'focus on the PDF'),
    );
  });

  it('offers cancel on an active task and hides the composer for a terminal one', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({
      tasks: [task({ id: 't2', status: 'done' })],
      nextCursor: null,
    });
    vi.mocked(TaskService.get).mockResolvedValue({
      task: task({ id: 't2', status: 'done' }),
      events: [{ seq: 0, role: 'assistant', content: 'All done.', timestamp: '' }],
    });

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-t2')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('task-row-t2'));

    await waitFor(() => expect(screen.getByText('All done.')).toBeInTheDocument());
    expect(screen.queryByTestId('task-cancel')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-instruction-input')).toBeDisabled();
    // The chip appears on both the list row and the detail header.
    expect(screen.getAllByTestId('task-status-done').length).toBeGreaterThan(0);
  });

  // A 404 mid-poll must surface and stop polling, not freeze on stale data.
  it('surfaces a 404 on a silent poll and stops polling', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({ tasks: [task()], nextCursor: null });
    vi.mocked(TaskService.get).mockResolvedValueOnce(detail());
    vi.mocked(TaskService.get).mockRejectedValueOnce(
      new TaskError('Task not found', { status: 404 }),
    );

    vi.useFakeTimers();
    try {
      render(<TasksView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByTestId('task-row-t1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Let me look.')).toBeInTheDocument();

      // The next silent poll 404s: the error surfaces and polling stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByTestId('task-detail-error')).toBeInTheDocument();

      const callsAfterError = vi.mocked(TaskService.get).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(vi.mocked(TaskService.get).mock.calls.length).toBe(callsAfterError);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cancel is observed server-side at the next step boundary; stay pending.
  it('keeps a pending cancel state until the task is terminal', async () => {
    vi.mocked(TaskService.list).mockResolvedValue({ tasks: [task()], nextCursor: null });
    vi.mocked(TaskService.get).mockResolvedValue(detail());
    vi.mocked(TaskService.cancel).mockResolvedValue(task());

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-t1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('task-row-t1'));
    await waitFor(() => expect(screen.getByTestId('task-cancel')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('task-cancel'));

    await waitFor(() => expect(screen.getByTestId('task-cancel')).toBeDisabled());
    expect(screen.getByTestId('task-cancel')).toHaveTextContent(/cancelling/i);
  });
});
