import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ListTree, Loader2, Send, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import MarkdownContent from './MarkdownContent';
import BackToChatLink from './BackToChatLink';
import TaskLibrary from './TaskLibrary';
import TaskStatusChip from './TaskStatusChip';
import TaskService, {
  isTerminalTask,
  isTaskNotFound,
  type TaskDetail,
  type TaskStreamEvent,
  type TaskSummary,
} from '@/services/tasks';
import type { ToolEvent } from '@/App';

// Chat view with queued turn-taking; the stream is read-only.
// @see #251
const POLL_MS = 3000;

// Reuse the chat chip presentation so tool use reads as in a chat.
// @see #196
const TaskToolChips: React.FC<{ tools: ToolEvent[] }> = ({ tools }) => {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  return (
    <div className="mb-2 text-xs text-muted-foreground" data-testid="task-tool-summary">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="task-tool-summary-toggle"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ChevronDown
          size={12}
          aria-hidden
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        />
        <span>
          Used {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="task-tool-chips">
          {tools.map((event, i) => (
            <span
              key={`${event.phase}-${event.name}-${i}`}
              data-testid={`task-tool-chip-${event.name}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1"
            >
              <span className="truncate">
                {event.label}
                {event.query ? ` “${event.query}”` : ''}
                {event.phase === 'result' && event.resultCount != null
                  ? ` — ${event.resultCount} results`
                  : ''}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const TaskStreamRow: React.FC<{ event: TaskStreamEvent }> = ({ event }) => {
  if (event.role === 'system') {
    return (
      <div
        data-testid="task-system-event"
        className="mb-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
      >
        {event.content}
      </div>
    );
  }
  if (event.role === 'user') {
    return (
      <div className="mb-4 flex min-w-0 flex-col items-end">
        <div className="max-w-[92%] min-w-0 rounded-lg rounded-br-sm border border-primary/25 bg-msg-user px-4 py-3 break-words md:max-w-[85%]">
          <MarkdownContent content={event.content} markdown={false} />
        </div>
      </div>
    );
  }
  // Reserved tool role never renders standalone; call+result ride one event.
  return (
    <div className="mb-6 min-w-0 max-w-[92%] md:max-w-[85%]">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary">
          <img src="/tova-logo.png" alt="Tova" className="size-5 rounded-full" />
        </span>
        Tova
        {event.step != null && <span data-testid="task-step-label">· step {event.step + 1}</span>}
      </div>
      <div className="px-4 py-3 md:px-5">
        <TaskToolChips tools={event.tools ?? []} />
        {event.content ? (
          <MarkdownContent content={event.content} markdown />
        ) : (event.tools?.length ?? 0) > 0 ? (
          <p className="text-sm text-muted-foreground">(working…)</p>
        ) : (
          <p className="text-sm text-muted-foreground">(no content returned)</p>
        )}
      </div>
      {(event.provider || event.model) && (
        <div className="mt-1 px-4 text-xs text-muted-foreground md:px-5">
          {event.provider && event.model ? `${event.provider} · ${event.model}` : event.model}
        </div>
      )}
    </div>
  );
};

const budgetLine = (task: TaskSummary): string =>
  `$${task.budget.spentUsd.toFixed(4)} of $${task.budget.maxCostUsd.toFixed(2)} · ` +
  `${task.stepCount}/${task.budget.maxSteps} steps`;

const TasksView: React.FC = () => {
  // Id kept separate from the header so polled responses don't re-trigger.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [seed, setSeed] = useState<TaskSummary | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Held until terminal: the cancel response still reports running until then.
  const [cancelRequested, setCancelRequested] = useState(false);

  // Compared after await so a stale response is discarded, not painted over.
  const selectedIdRef = useRef<string | null>(null);

  const loadDetail = useCallback(async (taskId: string, opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const next = await TaskService.get(taskId);
      if (selectedIdRef.current !== taskId) return;
      setDetail(next);
      setError(null);
    } catch (err) {
      if (selectedIdRef.current !== taskId) return;
      // 404 surfaces and stops polling; silent non-404s are retried next tick.
      if (isTaskNotFound(err)) {
        setDetail(null);
        setError(err.message);
        return;
      }
      if (opts.silent) return;
      setError(err instanceof Error ? err.message : 'Could not load this task');
    } finally {
      if (!opts.silent && selectedIdRef.current === taskId) setLoading(false);
    }
  }, []);

  // Reset per-task draft/stream so nothing leaks across tasks.
  const select = useCallback((task: TaskSummary) => {
    setSelectedId(task.id);
    setSeed(task);
    setDetail(null);
    setError(null);
    setInstruction('');
    setCancelling(false);
    setCancelRequested(false);
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!selectedId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // The header is the polled task, else the seed row until detail lands.
  const summary = detail?.task ?? seed;
  const terminal = summary != null && isTerminalTask(summary.status);
  // A task reported gone (404) is not polled any more.
  const gone = error != null && detail == null;

  // Poll while active so the stream advances; stop at terminal states.
  const active = selectedId != null && summary != null && !terminal && !gone;
  useEffect(() => {
    if (!active || !selectedId) return;
    const timer = setInterval(() => void loadDetail(selectedId, { silent: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [active, selectedId, loadDetail]);

  // Derived rather than stored, so no clearing effect is needed.
  const cancelPending = cancelRequested && !terminal;

  const handleInstruct = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = instruction.trim();
    if (!text || !selectedId || !summary || sending || terminal) return;
    setSending(true);
    try {
      await TaskService.instruct(selectedId, text);
      setInstruction('');
      toast.success('Instruction queued');
      await loadDetail(selectedId, { silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue instruction');
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedId || cancelling || cancelRequested || terminal) return;
    setCancelling(true);
    setCancelRequested(true);
    try {
      await TaskService.cancel(selectedId);
      // Server reports running until the next step boundary; keep Cancelling.
      await loadDetail(selectedId, { silent: true });
    } catch (err) {
      // The cancel did not take; clear pending so the button is usable.
      setCancelRequested(false);
      toast.error(err instanceof Error ? err.message : 'Could not cancel task');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      data-testid="tasks-view"
      className="flex h-full w-full flex-col bg-background text-foreground"
    >
      <div className="shrink-0 px-6">
        <div className="flex h-14 items-center">
          <h2 className="font-heading text-xl font-semibold">Tasks</h2>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div
          className={`min-w-0 shrink-0 overflow-hidden rounded-xl border border-border md:w-96 ${
            selectedId ? 'hidden md:block' : 'w-full'
          }`}
        >
          <TaskLibrary selectedId={selectedId} onSelect={select} />
        </div>
        <div
          className={`min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border panel-surface ${
            selectedId ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!summary ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <ListTree className="size-6" />
              <p className="text-sm">Select a task to follow it.</p>
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                <button
                  type="button"
                  data-testid="task-detail-back"
                  aria-label="Back to task list"
                  onClick={() => setSelectedId(null)}
                  className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
                >
                  <ChevronLeft className="size-4" />
                  Back
                </button>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <TaskStatusChip status={summary.status} />
                    <span
                      className="truncate text-xs text-muted-foreground"
                      data-testid="task-budget"
                    >
                      {budgetLine(summary)}
                    </span>
                  </div>
                </div>
                {!terminal && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleCancel()}
                    disabled={cancelling || cancelPending}
                    data-testid="task-cancel"
                    className="shrink-0"
                  >
                    {cancelling || cancelPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Square className="size-3.5" />
                    )}
                    {cancelPending ? 'Cancelling…' : 'Cancel'}
                  </Button>
                )}
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
                {loading && !detail ? (
                  <p
                    className="flex items-center gap-2 text-sm text-muted-foreground"
                    data-testid="task-detail-loading"
                  >
                    <Loader2 className="size-4 animate-spin" /> Loading…
                  </p>
                ) : error ? (
                  <p className="text-sm text-destructive" data-testid="task-detail-error">
                    {error}
                  </p>
                ) : detail && detail.events.length > 0 ? (
                  detail.events.map((event) => (
                    <TaskStreamRow key={`${event.seq}-${event.role}`} event={event} />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="task-detail-empty">
                    Waiting for the first step…
                  </p>
                )}
              </div>
              <footer className="shrink-0 border-t border-border p-3 md:px-4">
                <form onSubmit={handleInstruct}>
                  <div className="flex items-end gap-2">
                    <textarea
                      className="block max-h-[30dvh] min-h-9 w-full resize-none overflow-y-auto rounded-lg border border-border bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary"
                      rows={1}
                      placeholder={
                        terminal
                          ? 'This task has finished.'
                          : summary.status === 'paused'
                            ? 'Send an instruction to resume…'
                            : 'Steer the task — queued until the next step…'
                      }
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void handleInstruct(e as unknown as React.FormEvent);
                        }
                      }}
                      disabled={sending || terminal}
                      data-testid="task-instruction-input"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      className="h-9 shrink-0"
                      disabled={sending || terminal || !instruction.trim()}
                      data-testid="task-instruction-send"
                    >
                      <Send className="size-4" />
                      {summary.status === 'paused' ? 'Resume' : 'Queue'}
                    </Button>
                  </div>
                </form>
                <p className="mt-2 text-xs text-muted-foreground" data-testid="task-queue-note">
                  {terminal
                    ? 'A finished task is not reopened by a late instruction.'
                    : 'Steering queues until the task reaches its next step.'}
                </p>
              </footer>
            </>
          )}
        </div>
      </div>
      <BackToChatLink />
    </div>
  );
};

export default TasksView;
