import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import TaskStatusChip from './TaskStatusChip';
import TaskService, { isTerminalTask, type TaskSummary } from '@/services/tasks';

// Embedded task card: a read-only pointer to the newest tasks a chat started.
// @see #255 #251

const POLL_MS = 3000;

// Only the newest few tasks show, so the composer stays on a phone screen.
const MAX_CARDS = 3;

const TaskCard: React.FC<{ sessionId: string; refreshSignal?: number }> = ({
  sessionId,
  refreshSignal = 0,
}) => {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      // Newest-first from the list route; the cap keeps only the newest rows.
      const next = await TaskService.listForSession(sessionId);
      setTasks(next.slice(0, MAX_CARDS));
    } catch {
      // A failed poll leaves the last good list; the card is best-effort.
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  // refreshSignal bumps when the composer creates a task; refetch at once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshSignal]);

  // Keyed on the boolean: a fresh array per tick would tear down the interval.
  const anyActive = tasks.some((t) => !isTerminalTask(t.status));
  useEffect(() => {
    if (!anyActive) return;
    timerRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [anyActive, load]);

  // Render nothing until the first poll lands.
  // @see #255
  if (!loaded || tasks.length === 0) return null;

  return (
    <div className="mb-2 space-y-1.5" data-testid="task-card">
      {tasks.map((task) => (
        <a
          key={task.id}
          href="/tasks"
          data-testid="task-card-item"
          className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={task.instruction}>
            {task.instruction || 'Background task'}
          </span>
          <TaskStatusChip status={task.status} />
        </a>
      ))}
    </div>
  );
};

export default TaskCard;
