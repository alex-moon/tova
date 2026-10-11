import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import TaskStatusChip from './TaskStatusChip';
import TaskService, { isTerminalTask, type TaskSummary } from '@/services/tasks';

/*
 * Embedded task card (#255, epic #251; F6). A read-only pointer to the tasks a
 * chat started, rendered in the chat surface — the detail itself stays in the
 * `/tasks` view, so no task stream is embedded inline (mobile-first: the card
 * is one row, not a nested viewport). The join is the thin `origin.sessionId`
 * reference the server filters on (F1); the card owns no task state.
 *
 * Silent poll while any origin task is still active, mirroring `TaskLibrary`;
 * a terminal list stops polling (nothing left to watch).
 */

const POLL_MS = 3000;

// The card is a pointer, not a task log: a chat that has started many tasks
// shows only the newest few, so the composer is never pushed off a phone screen.
// The full history lives in the `/tasks` view the card links to.
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
      // `listForSession` returns newest-first (the list route's `_id` descending
      // order); the cap keeps only the newest rows the card should show.
      const next = await TaskService.listForSession(sessionId);
      setTasks(next.slice(0, MAX_CARDS));
    } catch {
      // A failed poll leaves the last good list; the card is best-effort.
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  // `refreshSignal` changes when the composer creates a task (F7), so the card
  // picks it up immediately rather than waiting for the next poll — an empty
  // list does not poll (there is nothing active to watch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshSignal]);

  // Poll while any shown task is still active, mirroring `TaskLibrary`. Keyed
  // on the derived boolean, not the `tasks` array: `load` installs a fresh array
  // each tick, so depending on the array would tear down and re-create the
  // interval every poll.
  const anyActive = tasks.some((t) => !isTerminalTask(t.status));
  useEffect(() => {
    if (!anyActive) return;
    timerRef.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [anyActive, load]);

  // Nothing started from this chat, or the first poll has not landed: render
  // nothing rather than an empty shell (the pre-#255 chat is byte-identical).
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
