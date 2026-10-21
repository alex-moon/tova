import { Task, type TaskDocument } from '../../models/Task';

/* Completion drain: pending done tasks fold into the next turn once. */
// @see #255 #251 #254

// Completed-but-unannounced origin tasks for a session, oldest first.
// The drain is capped: many completions must not bloat one turn's context.
// @see #255 #395
export const MAX_DRAIN_COMPLETIONS = 5;

export const pendingCompletionsFor = async (
  userId: string,
  sessionId: string,
  limit: number = MAX_DRAIN_COMPLETIONS,
): Promise<TaskDocument[]> =>
  Task.find({
    userId,
    status: 'done',
    'origin.sessionId': sessionId,
    notifiedAt: null,
  })
    .sort({ updatedAt: 1 })
    .limit(limit);

// Guarded on `notifiedAt: null` so a concurrent drain cannot double-mark.
export const markNotified = async (taskIds: TaskDocument['_id'][]): Promise<void> => {
  if (!taskIds.length) return;
  await Task.updateMany(
    { _id: { $in: taskIds }, notifiedAt: null },
    { $set: { notifiedAt: new Date() } },
  );
};

// The line folded into the origin turn's context; clipped.
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
