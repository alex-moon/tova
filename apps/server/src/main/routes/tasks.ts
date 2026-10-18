import express from 'express';
import { isValidObjectId } from 'mongoose';
import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent, type TaskEventDocument } from '../models/TaskEvent';
import { User } from '../models/User';
import { authenticate, AuthRequest } from '../middleware/auth';
import { zodMessage, taskCreateSchema, taskInstructionSchema } from '../validation';
import { enqueueTask, steerTask, cancelTask } from '../services/taskService';
import { cursorPage, LIST_PAGE_SIZE } from '../services/cursorPage';
import { config } from '../config';

const router = express.Router();

/* Task API: a first-class stream; every route user-scoped, 404 no oracle. */
// @see #254 #251

// A list/summary view of a task — the header without its whole stream.
const serializeTask = (task: TaskDocument) => ({
  id: String(task._id),
  status: task.status,
  instruction: task.instruction,
  origin: task.origin
    ? {
        kind: task.origin.kind,
        ...(task.origin.sessionId ? { sessionId: task.origin.sessionId } : {}),
      }
    : null,
  stepCount: task.stepCount,
  budget: {
    maxSteps: task.budget.maxSteps,
    maxCostUsd: task.budget.maxCostUsd,
    spentUsd: task.budget.spentUsd,
  },
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

// Chat-turn event shape plus `seq`/`step`; raw `result` stripped to chips.
// @see #196
const serializeToolEvent = (tool: unknown) => {
  const plain = (
    typeof (tool as { toObject?: unknown }).toObject === 'function'
      ? (tool as { toObject: () => Record<string, unknown> }).toObject()
      : (tool as Record<string, unknown>)
  ) as Record<string, unknown>;
  return {
    phase: plain.phase,
    name: plain.name,
    label: plain.label,
    ...(plain.query ? { query: plain.query } : {}),
    ...(plain.status ? { status: plain.status } : {}),
    ...(plain.resultCount !== undefined && plain.resultCount !== null
      ? { resultCount: plain.resultCount }
      : {}),
    ...(plain.domains ? { domains: plain.domains } : {}),
    ...(plain.filename ? { filename: plain.filename } : {}),
  };
};

const serializeEvent = (event: TaskEventDocument) => ({
  seq: event.seq,
  role: event.role,
  content: event.content,
  ...(event.model ? { model: event.model } : {}),
  ...(event.provider ? { provider: event.provider } : {}),
  ...(event.tools ? { tools: event.tools.map(serializeToolEvent) } : {}),
  ...(event.usage ? { usage: event.usage } : {}),
  ...(event.step !== undefined && event.step !== null ? { step: event.step } : {}),
  timestamp: event.timestamp,
});

// Ownership-scoped lookup: unowned or malformed id is a 404.
const ownedTask = (req: AuthRequest): Promise<TaskDocument | null> =>
  isValidObjectId(req.params.id)
    ? Task.findOne({ _id: req.params.id, userId: req.user?.id })
    : Promise.resolve(null);

// Create a task; refused for ZDR accounts (tasks are durable).
// @see #254
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = taskCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: zodMessage(parsed, 'Invalid task') });
    }
    const user = await User.findById(req.user?.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.settings?.zdr) {
      return res
        .status(403)
        .json({ message: 'Tasks are not available with zero-data-retention enabled' });
    }

    const task = await enqueueTask({
      userId: req.user?.id as string,
      ...(parsed.data.instruction ? { instruction: parsed.data.instruction } : {}),
      ...(parsed.data.origin ? { origin: parsed.data.origin } : {}),
      // Budget snapshotted at creation; env changes can't move it.
      maxSteps: config.task.maxSteps,
      maxCostUsd: config.task.maxCostUsd,
    });
    return res.status(201).json({ task: serializeTask(task) });
  } catch (err) {
    console.error('Task create error:', err);
    return res.status(500).json({ message: 'Error creating task' });
  }
});

// Cursor-paged, caller-scoped; optional `originSessionId` filter.
// @see #255
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const query: Record<string, unknown> = { userId: req.user?.id };
    const cursor = req.query.cursor;
    if (typeof cursor === 'string' && isValidObjectId(cursor)) {
      query._id = { $lt: cursor };
    }
    const originSessionId = req.query.originSessionId;
    if (typeof originSessionId === 'string' && originSessionId) {
      query['origin.sessionId'] = originSessionId;
    }
    const tasks = await Task.find(query)
      .sort({ _id: -1 })
      .limit(LIST_PAGE_SIZE + 1);

    const { page, nextCursor } = cursorPage(tasks);
    return res.json({
      tasks: page.map(serializeTask),
      nextCursor,
    });
  } catch (err) {
    console.error('Task list error:', err);
    return res.status(500).json({ message: 'Error listing tasks' });
  }
});

// The owned task plus its ordered stream — the detail view's data.
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await ownedTask(req);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const events = await TaskEvent.find({ taskId: task._id }).sort({ seq: 1 });
    return res.json({ task: serializeTask(task), events: events.map(serializeEvent) });
  } catch (err) {
    console.error('Task get error:', err);
    return res.status(500).json({ message: 'Error loading task' });
  }
});

// Queue a steering turn (or resume paused); terminal is 409.
router.post('/:id/instruction', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = taskInstructionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: zodMessage(parsed, 'Invalid instruction') });
    }
    const task = await ownedTask(req);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const result = await steerTask(task, parsed.data.instruction);
    if (result.status === 'refused') {
      return res.status(409).json({ message: 'Task is no longer active' });
    }
    return res.json({ task: serializeTask((await Task.findById(task._id)) ?? task) });
  } catch (err) {
    console.error('Task instruction error:', err);
    return res.status(500).json({ message: 'Error steering task' });
  }
});

// Stop an active task; aborts the in-flight step; idempotent. @see #395
router.post('/:id/cancel', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await ownedTask(req);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    await cancelTask(task);
    return res.json({ task: serializeTask((await Task.findById(task._id)) ?? task) });
  } catch (err) {
    console.error('Task cancel error:', err);
    return res.status(500).json({ message: 'Error cancelling task' });
  }
});

export default router;
