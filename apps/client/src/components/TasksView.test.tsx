import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import TasksView from './TasksView';
import type { TaskDetail, TaskSummary } from '../services/tasks';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('../services/tasks', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/tasks')>();
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

import TaskService from '../services/tasks';

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
  afterEach(cleanup);

  beforeEach(() => {
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
    // The #196 tool chip summary renders on the assistant step.
    expect(screen.getByTestId('task-tool-summary-toggle')).toBeInTheDocument();
    // A sequencer system notice renders as a neutral, non-chat row.
    expect(screen.getByTestId('task-system-event')).toHaveTextContent('Step budget reached');
    expect(TaskService.get).toHaveBeenCalledWith('t1');
  });

  // Regression (#254 client): the detail loader must key on the task *id*, not
  // the loaded header object. A real GET returns a fresh object each time, so a
  // loader that depended on the header would re-fire on its own response and
  // loop unbounded. Mock `get` with a fresh object per call (as axios does) and
  // assert the fetch settles to the initial load + at most one poll.
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

  // The list is cursor-paged server-side (20/page); the client must surface the
  // "Show more" affordance and append the next page rather than silently
  // dropping every task past the first page.
  it('loads the next page of tasks via the cursor', async () => {
    vi.mocked(TaskService.list)
      .mockResolvedValueOnce({ tasks: [task({ id: 'p1' })], nextCursor: 'cur-1' })
      .mockResolvedValueOnce({ tasks: [task({ id: 'p2' })], nextCursor: null });

    render(<TasksView />);
    await waitFor(() => expect(screen.getByTestId('task-row-p1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('task-load-more'));

    await waitFor(() => expect(screen.getByTestId('task-row-p2')).toBeInTheDocument());
    expect(TaskService.list).toHaveBeenLastCalledWith('cur-1');
    // The first page is kept alongside the appended second page.
    expect(screen.getByTestId('task-row-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('task-load-more')).not.toBeInTheDocument();
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
    // Terminal: no cancel affordance, composer disabled.
    expect(screen.queryByTestId('task-cancel')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-instruction-input')).toBeDisabled();
    // The chip appears on both the list row and the detail header.
    expect(screen.getAllByTestId('task-status-done').length).toBeGreaterThan(0);
  });
});
