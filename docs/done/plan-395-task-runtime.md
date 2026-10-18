# Plan: #395 — task runtime hardening (requeue double-run, cancel, injection-adjacent gaps)

## Motivation

[#395](https://github.com/alex-moon/tova/issues/395), from the #382 backend audit. The
task runtime can double-run a live task (double provider spend), cancel does not stop an
in-flight step, the cost budget is stored but never enforced, and several small
correctness/robustness gaps.

Note: the code has drifted since the audit. The atomic claim (status + attempts bump in
one `findOneAndUpdate`) and the terminal-status settle guards already exist, so several
audit line items are partially addressed. This plan covers what still stands.

## Decisions

1. **Stale requeue: heartbeat + attempts charge, no new schema fields.**
   - `makeTaskProcessor` runs a 60s heartbeat interval while a step executes, touching
     the task header's `updatedAt` (fresh via `timestamps: true`). A live task whose step
     legitimately runs >5 min is never swept; a crashed task's heart stops and the
     existing 5-min cutoff reclaims it.
   - `requeueStaleTasks` now charges the stale path: stale tasks at
     `MAX_TASK_ATTEMPTS` are failed (`lastError`), the rest are requeued with
     `$inc: { attempts: 1 }`. A poison task (OOMs the process mid-step) can no longer
     restart forever. This reverses the previously deliberate no-bump behavior.
2. **Cancel aborts the in-flight step.** An AbortController registry lives in
   `taskProcessor` (the layer that owns running tasks; `taskService` already imports
   from it, so no cycle). `cancelTask` aborts after the status flip;
   `runTaskStep` threads the signal into `CompletionOptions.abortSignal` (supported end
   to end via the mastra connector). Settle guards make the resulting abort-throw a
   no-op on an already-cancelled task.
3. **History windowing mirrors chat's window.** `assembleTaskHistory` gains a
   post-pass: the newest message always rides (truncated when it alone busts the char
   budget, same as chat's `windowedHistory`), the first message (the instruction anchor)
   always rides, and the middle fills newest-first under 200 messages / 400k chars.
   Constants are task-local — importing chat route exports would deepen the layering
   inversion #398 item 9 will remove.
4. **Steer TOCTOU: post-append re-check.** Cross-collection transactions are not
   available on the standalone dev Mongo, so the race cannot be closed atomically.
   `steerTask` keeps the pre-append terminal check and adds a post-append re-check: if
   the task settled during the append, it returns `refused` so the API no longer claims
   a steering turn was queued onto a dead stream. Residual: the appended event can
   still exist on a just-settled task in a sub-millisecond window; it is inert (the
   stream is terminal and never read again).
5. **Cost budget enforced.** Per step, cost is computed from the outcome's token usage
   via the existing `estimateCostUsd` + `priceRowsForModel` (#199/#387 pricing table) and
   `$inc`'d into `budget.spentUsd` in the same header write as `stepCount`. At the loop
   top, `spentUsd >= maxCostUsd` pauses the task with a notice — mirroring the
   step-budget pause. Absent usage or an unpriced model means no increment: unknown cost
   is not enforceable, never faked.
6. **Empty instruction.** `taskCreateSchema.instruction` gains `min(1)` (rejecting `''`
   like `taskInstructionSchema`); `enqueueTask` seeds a placeholder user event when the
   instruction is absent so the stream is never empty, and compensates (deletes the
   header) if that seed write fails — the create call surfaces the error instead of
   stranding a zombie queued task.
7. **Drain cap.** `pendingCompletionsFor` takes a limit (default 5, oldest first); the
   rest stay pending and drain on later turns.
8. **Boot-sweep failures are logged**, not swallowed: `console.error` with
   `redactForLog`.

## Done

- [x] `requeueStaleTasks` charges an attempt and caps poison tasks; heartbeat keeps live tasks off the sweep
- [x] Cancel aborts the in-flight step via an abort registry threaded into `CompletionOptions.abortSignal`
- [x] `assembleTaskHistory` windows replay (anchor + newest always, bounded middle)
- [x] `steerTask` re-checks status after the append and refuses honestly
- [x] Cost budget: per-step `$inc` of `budget.spentUsd`, pause at the cap
- [x] `taskCreateSchema` rejects `''`; `enqueueTask` seeds a placeholder and compensates on seed failure
- [x] Completion drain capped at 5 per turn
- [x] Boot-sweep failure logged
- [x] Tests updated/added for all the above; `npm run ci` green

## Follow-ups

- None created yet; residual risks are documented in the decisions above.

## Hardening round (pre-review)

Three holes found while re-attacking the draft, all fixed on this branch:

1. **Frozen-process double-run.** The heartbeat only prevents the sweep from
   requeuing a live task; it cannot fence a *frozen* one (laptop sleep,
   container freeze): the sweep requeues, a twin processor claims, and the
   woken original re-reads the header, sees `running` (now the twin's), and
   keeps stepping alongside it. This reverses decision 1's "no new schema
   fields": claims now stamp a `leaseToken`, and every processor re-read and
   write (header, heartbeat, budget writes, settle, the poll tick's
   settle/error paths) is scoped on it — a stale twin's reads miss and it
   exits. Residual: a step already in flight appends its event before
   noticing; the settle it attempts is fenced, so the twin stays authoritative.
2. **Abort registry race.** One controller per task meant a second
   registration orphaned the first and a release dropped the survivor's entry
   — cancel could end up aborting nothing. The registry is now a Set per task:
   cancel aborts every live run, release removes only its own controller.
3. **Cancel window before step start.** Cancel landing between the loop-top
   header read and the abort registration (spanning the cost check and the
   stream fetch) ran a full billed step on a cancelled task. The processor now
   re-verifies ownership (`_id` + lease + `running`) after registering, before
   `runStep`.

Also hardened: `enqueueTask`'s seed-failure compensation deletes the header
only while it is still `queued`, so a claim that slipped in during the window
is never stranded with a deleted header.
