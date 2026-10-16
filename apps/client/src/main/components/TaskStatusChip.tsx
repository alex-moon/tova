import type React from 'react';
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import type { TaskStatus } from '@/services/tasks';

// Status chip for a task (#254, epic #251). The six statuses are the server
// enum (Task.status); each maps to one icon + tone. Kept in one place so the
// list rows and the detail header cannot drift.
const STATUS_STYLE: Record<
  TaskStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  queued: {
    label: 'Queued',
    icon: CircleDashed,
    className: 'border-border bg-muted text-muted-foreground',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    className: 'border-primary/30 bg-primary/10 text-primary',
  },
  paused: {
    label: 'Paused',
    icon: PauseCircle,
    className: 'border-warning/40 bg-warning/10 text-warning',
  },
  done: {
    label: 'Done',
    icon: CheckCircle2,
    className: 'border-success/40 bg-success/10 text-success',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
  cancelled: {
    label: 'Cancelled',
    icon: CircleSlash,
    className: 'border-border bg-muted text-muted-foreground',
  },
};

const TaskStatusChip: React.FC<{ status: TaskStatus }> = ({ status }) => {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span
      data-testid={`task-status-${status}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${style.className}`}
    >
      <Icon className={`size-3 ${status === 'running' ? 'animate-spin' : ''}`} aria-hidden />
      {style.label}
    </span>
  );
};

export default TaskStatusChip;
