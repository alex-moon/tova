import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import TaskCard from './TaskCard';
import type { TaskSummary } from '../services/tasks';

vi.mock('../services/tasks', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/tasks')>();
  return {
    ...original,
    default: {
      list: vi.fn(),
      listForSession: vi.fn(),
      create: vi.fn(),
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
  origin: { kind: 'chat', sessionId: 's1' },
  stepCount: 2,
  budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('TaskCard (#255)', () => {
  it('renders nothing when the session has no tasks', async () => {
    vi.mocked(TaskService.listForSession).mockResolvedValue([]);
    render(<TaskCard sessionId="s1" />);
    await waitFor(() => expect(TaskService.listForSession).toHaveBeenCalledWith('s1'));
    expect(screen.queryByTestId('task-card')).toBeNull();
  });

  it('renders a card per origin task with its status chip and a link', async () => {
    vi.mocked(TaskService.listForSession).mockResolvedValue([
      task({ id: 't1', status: 'running', instruction: 'Research X' }),
      task({ id: 't2', status: 'done', instruction: 'Build Y' }),
    ]);
    render(<TaskCard sessionId="s1" />);

    await waitFor(() => expect(screen.getAllByTestId('task-card-item')).toHaveLength(2));
    expect(screen.getByText('Research X')).toBeTruthy();
    expect(screen.getByTestId('task-status-running')).toBeTruthy();
    expect(screen.getByTestId('task-status-done')).toBeTruthy();
    expect(screen.getAllByTestId('task-card-item')[0].getAttribute('href')).toBe('/tasks');
  });

  it('renders nothing if the fetch fails', async () => {
    vi.mocked(TaskService.listForSession).mockRejectedValue(new Error('boom'));
    render(<TaskCard sessionId="s1" />);
    await waitFor(() => expect(TaskService.listForSession).toHaveBeenCalled());
    expect(screen.queryByTestId('task-card')).toBeNull();
  });

  it('caps the card list so a long chat cannot push the composer off-screen', async () => {
    vi.mocked(TaskService.listForSession).mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => task({ id: `t${i}`, instruction: `Task ${i}` })),
    );
    render(<TaskCard sessionId="s1" />);
    await waitFor(() => expect(screen.getAllByTestId('task-card-item')).toHaveLength(3));
    expect(screen.getByText('Task 0')).toBeTruthy();
    expect(screen.queryByText('Task 3')).toBeNull();
  });
});
