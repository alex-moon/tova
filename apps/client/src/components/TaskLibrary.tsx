import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ListTree } from 'lucide-react';
import TaskService, { isTerminalTask, type TaskSummary } from '@/services/tasks';
import TaskStatusChip from './TaskStatusChip';
import { cn } from '@/lib/utils';

// How often the list re-reads while any task is still active (queued/running/
// paused) — the same poll-while-pending idiom as AssetLibrary, so a task's
// status chip advances in place without the user re-selecting.
const POLL_MS = 3000;

const isActive = (task: TaskSummary): boolean => !isTerminalTask(task.status);

const originLabel = (task: TaskSummary): string | null => {
  if (task.origin?.kind === 'chat') return 'From chat';
  if (task.origin?.kind === 'direct') return 'Direct';
  return null;
};

// Short, single-line summary of a task for the list: the instruction's first
// line, falling back to the origin. Never rendered as markdown here.
const summaryOf = (task: TaskSummary): string => {
  const first = task.instruction.split('\n')[0]?.trim();
  return first || originLabel(task) || 'Task';
};

interface TaskLibraryProps {
  selectedId?: string | null;
  onSelect?: (task: TaskSummary) => void;
}

const TaskLibrary: React.FC<TaskLibraryProps> = ({ selectedId = null, onSelect }) => {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      if (!opts.silent) setLoading(true);
      const page = await TaskService.list();
      setTasks(page.tasks);
      setError(false);
    } catch (err) {
      console.error('Error listing tasks:', err);
      if (!opts.silent) setError(true);
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const anyActive = tasks.some(isActive);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load({ silent: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, load]);

  return (
    <div
      data-testid="task-library"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      {loading ? (
        <p
          className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
          data-testid="task-library-loading"
        >
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive" data-testid="task-library-error">
          Could not load your tasks
        </p>
      ) : tasks.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
          data-testid="task-library-empty"
        >
          <ListTree className="size-6" />
          <p className="text-sm">No tasks yet.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                data-testid={`task-row-${task.id}`}
                onClick={() => onSelect?.(task)}
                className={cn(
                  'mb-1 w-full rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary',
                  selectedId === task.id
                    ? 'border-primary/40 bg-accent'
                    : 'border-transparent bg-transparent',
                )}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <TaskStatusChip status={task.status} />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    step {task.stepCount}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{summaryOf(task)}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {originLabel(task) && <span>{originLabel(task)}</span>}
                    <span>
                      {new Date(task.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TaskLibrary;
