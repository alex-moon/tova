import type { TaskDocument } from '../models/Task';
import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';

// Task processor (#254, epic #251) — the sequencer's driver seam.
//
// The real turn loop (one `maxSteps: 1` driver run per step, steering drained
// at step boundaries) is deliberately NOT implemented in this foundation slice:
// it is blocked on the connector change tracked as OQ9 in
// `docs/plan-254-task-entity.md` (the racing path cannot yet pin `maxSteps` or
// return the step's message list). Shipping the queue/model/runtime without a
// silent fake driver is the honest split — the foundation is real, the loop is
// a separate slice.
//
// Until then a claimed task immediately transitions to `paused` with a visible
// system event (the same mechanism D6 uses for a budget breach). This is
// preferable to marking it `done` (a lie) or leaving it `running` (it would
// strand until the stale sweep). Resumption is a queued instruction once the
// sequencer lands.
export const processTaskJob = async (task: TaskDocument): Promise<void> => {
  const notice =
    'Task sequencer is not yet implemented (epic #251, slice #254). ' +
    'The task is paused and will resume when the sequencer lands.';

  const last = await TaskEvent.findOne({ taskId: task._id }).sort({ seq: -1 });
  // Read-max-then-insert, not an atomic counter: safe because the stream has a
  // single writer (the epic's single-writer-per-stream invariant) and the poller
  // is single-consumer, so no two writers append to one task concurrently. The
  // `{taskId, seq}` unique index still catches a violation rather than letting
  // it corrupt the order.
  const seq = (last?.seq ?? -1) + 1;
  await TaskEvent.create({
    taskId: task._id,
    seq,
    role: 'system',
    content: notice,
    step: task.stepCount,
  });

  await Task.updateOne(
    { _id: task._id, status: 'running' },
    { $set: { status: 'paused', lastError: notice } },
  );
};
