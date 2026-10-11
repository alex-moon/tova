import express from 'express';
import { isValidObjectId } from 'mongoose';
import { Task, type TaskDocument } from '../models/Task';
import { TaskEvent, type TaskEventDocument } from '../models/TaskEvent';
import { User } from '../models/User';
import { authenticate, AuthRequest } from '../middleware/auth';
import { taskCreateSchema, taskInstructionSchema } from '../validation';
import { enqueueTask, steerTask, cancelTask } from '../services/taskService';
import { config } from '../config';

const router = express.Router();

/*
 * Task API (#254 routes slice, epic #251; D15). A task is a first-class stream
 * — a twin of a chat — so this is its own surface, not a chat sub-route. Every
 * route is `authenticate`d and scoped by `userId`: a foreign task id is a 404,
 * never a 403 oracle. No route ever writes a `Message`; the task stream is
 * `TaskEvent` (D1).
 *
 * Reads are read-only for the map (the ZDR carve-out is moot here — a ZDR user
 * cannot create a task at all, D7). The instruction route is the only stream
 * write, and it goes through `steerTask`/`appendTaskEvent` (D12's seq retry).
 */

const LIST_PAGE_SIZE = 20;

// A list/summary view of a task — the header without its whole stream. Mirrors
// how the asset list returns a bounded `safeAsset` rather than the document.
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

// One stream event, in the shape the chat client already renders for a turn
// (role/content/tools/usage/model/provider), plus the task stream's `seq`/`step`.
//
// The persisted tool chip carries the executed call's raw `result` — the resume
// payload the *sequencer* replays from the stream (D10), not something the
// browser ever renders. Strip it here by rebuilding only the #196 chip summary
// fields (a mongoose subdoc must be converted to a plain object first; spreading
// a subdoc leaks its internals instead of its fields). Shipping raw tool output
// on every polled detail GET would balloon the response and leak tool internals
// into the page.
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

// Ownership-scoped lookup: a task the caller does not own is indistinguishable
// from one that does not exist.
const ownedTask = (req: AuthRequest): Promise<TaskDocument | null> =>
  Task.findOne({ _id: req.params.id, userId: req.user?.id });

// POST /api/tasks — create a task. ZDR refusal (D7): tasks are durable by
// definition, so an account with `settings.zdr` (or its `incognitoByDefault`
// alias, the same storage slot) may not create one. Checked at creation only
// (OQ8 v1), mirroring how the chat routes read the flag per turn.
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = taskCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid task' });
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
      // Budget is snapshotted at creation (D6) from the same config the poller
      // reads, so a mid-task env change cannot move the goalposts.
      maxSteps: config.task.maxSteps,
      maxCostUsd: config.task.maxCostUsd,
    });
    return res.status(201).json({ task: serializeTask(task) });
  } catch (err) {
    console.error('Task create error:', err);
    return res.status(500).json({ message: 'Error creating task' });
  }
});

// GET /api/tasks — cursor-paged, strictly scoped to the caller (mirrors
// `GET /api/assets`: newest first, `_id` descending as the cursor).
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const query: Record<string, unknown> = { userId: req.user?.id };
    const cursor = req.query.cursor;
    if (typeof cursor === 'string' && isValidObjectId(cursor)) {
      query._id = { $lt: cursor };
    }
    const tasks = await Task.find(query)
      .sort({ _id: -1 })
      .limit(LIST_PAGE_SIZE + 1);

    const hasMore = tasks.length > LIST_PAGE_SIZE;
    const page = hasMore ? tasks.slice(0, LIST_PAGE_SIZE) : tasks;
    return res.json({
      tasks: page.map(serializeTask),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
    });
  } catch (err) {
    console.error('Task list error:', err);
    return res.status(500).json({ message: 'Error listing tasks' });
  }
});

// GET /api/tasks/:id — the owned task plus its ordered stream. This is the
// detail view's data (D2: a chat view with queued turn-taking).
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

// POST /api/tasks/:id/instruction — queue a steering turn (or resume a
// `paused` task). Terminal tasks are refused (409, D14); the append and the
// possible `paused -> queued` re-queue are `steerTask` (D12/D6).
router.post('/:id/instruction', authenticate, async (req: AuthRequest, res) => {
  try {
    const parsed = taskInstructionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: parsed.error.issues[0]?.message ?? 'Invalid instruction' });
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

// POST /api/tasks/:id/cancel — stop an active task. A running task's processor
// observes the status at its next step boundary (D13); terminal tasks are left
// untouched (idempotent).
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
