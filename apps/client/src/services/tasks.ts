import axios from 'axios';
import type { ToolEvent } from '../App';

// Task API client (#254, epic #251). A task is a first-class stream — a twin
// of a chat, not a chat's child — so this mirrors `/api/tasks` (D15) rather
// than reusing the chat service. The shape here must track the server's
// `serializeTask`/`serializeEvent` in `apps/server/src/routes/tasks.ts`.

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface TaskOrigin {
  kind: 'chat' | 'direct';
  sessionId?: string;
}

export interface TaskBudget {
  maxSteps: number;
  maxCostUsd: number;
  spentUsd: number;
}

// The task header without its stream (the list payload). Mirrors
// `serializeTask`.
export interface TaskSummary {
  id: string;
  status: TaskStatus;
  instruction: string;
  origin: TaskOrigin | null;
  stepCount: number;
  budget: TaskBudget;
  createdAt: string;
  updatedAt: string;
}

// One stream event, in the shape a chat turn already has (role/content/tools/
// usage/model/provider) plus the task stream's `seq`/`step`. `system` rows
// (e.g. a budget-breach notice, D6) carry no model.
export interface TaskStreamEvent {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  model?: string;
  provider?: string;
  tools?: ToolEvent[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  step?: number;
  timestamp: string;
}

export interface TaskListPage {
  tasks: TaskSummary[];
  nextCursor: string | null;
}

export interface TaskDetail {
  task: TaskSummary;
  events: TaskStreamEvent[];
}

export class TaskError extends Error {
  // The HTTP status, when the failure came from a response. Lets callers treat
  // a 404 (the task is gone) differently from a transient/5xx failure.
  readonly status?: number;

  constructor(
    message = 'Something went wrong with that task',
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'TaskError';
    this.status = options?.status;
  }
}

const toTaskError = (err: unknown): TaskError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new TaskError(message, { cause: err, status: err.response?.status });
    return new TaskError('Something went wrong with that task', {
      cause: err,
      status: err.response?.status,
    });
  }
  return new TaskError('Something went wrong with that task', { cause: err });
};

// A task that no longer exists (deleted, or a foreign id) is a 404.
export const isTaskNotFound = (err: unknown): err is TaskError =>
  err instanceof TaskError && err.status === 404;

// A status is "active" while the worker can still make progress; terminal
// states (done/failed/cancelled, D14) close the stream, and `paused` is a
// budget breach that waits for a steering instruction to resume (D6/D14).
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];
export const isTerminalTask = (status: TaskStatus): boolean =>
  TERMINAL_TASK_STATUSES.includes(status);

const TaskService = {
  async list(cursor?: string | null): Promise<TaskListPage> {
    const res = await axios.get<TaskListPage>('/api/tasks', {
      params: cursor ? { cursor } : {},
    });
    return res.data;
  },

  // #255: the tasks a given chat started — the embedded card's data. The join
  // is the thin `origin.sessionId` reference (F1), filtered server-side.
  async listForSession(sessionId: string): Promise<TaskSummary[]> {
    const res = await axios.get<TaskListPage>('/api/tasks', {
      params: { originSessionId: sessionId },
    });
    return res.data.tasks;
  },

  // #255 (F7): the manual "send to worker" path — create a task from the
  // composer with this chat as its origin, instead of sending a chat turn.
  async create(instruction: string, origin?: TaskOrigin): Promise<TaskSummary> {
    try {
      const res = await axios.post<{ task: TaskSummary }>('/api/tasks', {
        instruction,
        ...(origin ? { origin } : {}),
      });
      return res.data.task;
    } catch (err) {
      throw toTaskError(err);
    }
  },

  async get(taskId: string): Promise<TaskDetail> {
    try {
      const res = await axios.get<TaskDetail>(`/api/tasks/${taskId}`);
      return res.data;
    } catch (err) {
      throw toTaskError(err);
    }
  },

  // Queue a steering turn (or resume a `paused` task, D14). A terminal task is
  // refused server-side with a 409 whose message surfaces verbatim.
  async instruct(taskId: string, instruction: string): Promise<TaskSummary> {
    try {
      const res = await axios.post<{ task: TaskSummary }>(`/api/tasks/${taskId}/instruction`, {
        instruction,
      });
      return res.data.task;
    } catch (err) {
      throw toTaskError(err);
    }
  },

  async cancel(taskId: string): Promise<TaskSummary> {
    try {
      const res = await axios.post<{ task: TaskSummary }>(`/api/tasks/${taskId}/cancel`, {});
      return res.data.task;
    } catch (err) {
      throw toTaskError(err);
    }
  },
};

export default TaskService;
