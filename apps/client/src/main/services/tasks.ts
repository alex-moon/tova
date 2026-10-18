import axios from 'axios';
import type { ToolEvent } from '../App';

// Task API client: a task is a first-class stream, a twin of a chat.
// @see #254 #251

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

// The task header without its stream; the list payload.
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

// One stream event: chat turn shape plus the task stream's seq/step.
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
  // HTTP status when the failure came from a response; 404 special-casing.
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

// A status is active while the worker can still make progress.
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

  // The tasks a given chat started; filtered server-side.
  // @see #255
  async listForSession(sessionId: string): Promise<TaskSummary[]> {
    const res = await axios.get<TaskListPage>('/api/tasks', {
      params: { originSessionId: sessionId },
    });
    return res.data.tasks;
  },

  // Manual "send to worker": create a task with this chat as origin.
  // @see #255
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

  // Queue a steering turn; a terminal task is refused with a 409.
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
