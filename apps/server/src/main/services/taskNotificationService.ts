import { Task, type TaskDocument } from '../models/Task';

/*
 * Completion-notification drain (#255, epic #251; F4).
 *
 * A task's completion is surfaced to its origin chat as a *queued write* on the
 * chat stream, drained by the chat route — the chat stream's single writer.
 * The task worker never writes `messages` (single writer per stream); it only
 * leaves the task `done` with `notifiedAt: null`. The chat route, at the top of
 * the next turn, reads these pending completions, folds a visible notification
 * into that turn's context, and marks them notified (`notifiedAt` set), so a
 * completion is delivered exactly once and never mid-user-turn.
 *
 * The join is one-way and thin: a task points at its session via
 * `origin.sessionId` (Task.ts), and nothing on `Session`/`Message` points back.
 * `Message` never gains a `taskId` (hard invariant, #254).
 */

// The completed-but-unannounced origin tasks for a session, oldest first — the
// order a chat should narrate them. Only `done` tasks notify: a `failed` or
// `cancelled` task is a dead end the user chose or a hard error, not a work
// product to report; a `paused` task (budget breach, D6) is still steerable in
// the task view and not yet a result.
export const pendingCompletionsFor = async (
  userId: string,
  sessionId: string,
): Promise<TaskDocument[]> =>
  Task.find({
    userId,
    status: 'done',
    'origin.sessionId': sessionId,
    notifiedAt: null,
  }).sort({ updatedAt: 1 });

// Mark a batch of completions as announced. Guarded on `notifiedAt: null` so a
// concurrent drain (two turns racing, or a re-entrant read) cannot double-mark,
// and the notification is still exactly-once had the guard lost.
export const markNotified = async (taskIds: TaskDocument['_id'][]): Promise<void> => {
  if (!taskIds.length) return;
  await Task.updateMany(
    { _id: { $in: taskIds }, notifiedAt: null },
    { $set: { notifiedAt: new Date() } },
  );
};

// The line folded into the origin turn's context. Bounded: it names the task and
// its final answer (the last assistant step's text). Both are clipped — the
// instruction can be up to 4000 chars (the creation schema's cap) and the result
// unbounded, so either could otherwise dominate the prompt. Provenance pointers
// are the task's identity — the chat model can reference "the task" without any
// task stream leaking into the chat stream.
const NOTIFICATION_SUMMARY_CHARS = 600;
const NOTIFICATION_INSTRUCTION_CHARS = 200;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export const completionNotificationLine = (task: TaskDocument, summary: string): string => {
  const trimmed = summary.trim();
  const clipped = clip(trimmed, NOTIFICATION_SUMMARY_CHARS);
  const instruction = clip((task.instruction || '').trim(), NOTIFICATION_INSTRUCTION_CHARS);
  return (
    `A background task you started has finished. ` +
    `Task: "${instruction || '(no instruction)'}". ` +
    (clipped ? `Result: ${clipped}` : 'It finished without a text summary.')
  );
};
