# Plan — #255 Chat-task integration

## Motivation

Per GitHub issue [alex-moon/tova#255](https://github.com/alex-moon/tova/issues/255),
slice of epic [#251](https://github.com/alex-moon/tova/issues/251).

The still-wanted parts of the closed #166: a chat can start a task; progress and
completion are visible in the chat; completion triggers a chat response in the origin
session. This slice is the join between the two streams — and the join is where the
epic's binding invariants bite hardest, so this doc settles the seam shapes before any
code.

Slices #252 (provenance), #253 (workspace memory) and #254 (task entity: model, poller,
sequencer, routes, client view) have landed on `epic/251-workspace`. A task already runs
offline, is steerable, and has its own `/tasks` view; what it does not yet have is any
connection to a chat.

## Binding design (from the epic — treated as decisions, not open)

These are fixed by the epic (`#251`) and are not re-litigated here.

- **Single writer per stream.** The chat stream and a task stream never write each
  other; cross-references are **thin** (origin ref, provenance, queued notification).
- **No `taskId` on `Message`.** A hard invariant from #254 (`Task.ts:7-8`): the task
  stream lives in `TaskEvent`, never in `messages`, and `Message` never gains a `taskId`
  FK. The completion notification must therefore carry task provenance *without*
  entangling the two collections.
- **Incognito/ZDR sessions never become workspace items**; reading the map from a ZDR
  turn stays read-only. A ZDR turn cannot create a task (D7).
- **No new infrastructure.** Mongo-only, in-process pollers, no brokers.

## Decisions

- **F1 — A task's link to its chat is `Task.origin.sessionId` (already built, D1).**
  The join is *pulled from the task side*: given a session, the chat surface asks "which
  tasks have `origin.sessionId == this`". No reverse pointer is added to `Session` or
  `Message`. This keeps the reference thin and one-directional (task → session), which
  is exactly the epic's "thin reference, not ownership".

- **F2 — `delegate_task` is a chat tool that creates a task with an origin session.**
  It attaches in `agentFor`'s tool map like the workspace tools (`mastraService.ts`).
  Its `execute` reads `userId`/`sessionId` from the per-call `RequestContext`
  (the same seam `generateFileExecute` uses for provenance, `mastraService.ts:636-642`)
  and calls `enqueueTask({ origin: { kind: 'chat', sessionId } })`.

- **F3 — ZDR turns cannot delegate.** A task is durable, so a ZDR turn must not create
  one (D7). `delegate_task` runs only on the persisted (non-ZDR) turn: a ZDR turn has no
  `sessionId` in its request context, and the tool refuses with a graceful result rather
  than throwing. The tool also re-reads `User.settings.zdr` and refuses, mirroring the
  creation route's refusal (`routes/tasks.ts:114-118`) so the two seams cannot disagree.

- **F4 — The completion notification is a *queued write* on the chat stream, drained by
  the chat route (the stream's single writer), never written by the task worker.**
  The task worker must not write `messages` (invariant). On completion the worker records
  the outcome on the task (status `done` + the existing "Task completed." `system` event,
  which already carries the summary); the *chat route* — the only writer of the chat
  stream — observes pending completions and, at the next turn boundary, writes the
  notification into that turn's history so the chat model responds to it as part of the
  turn.

  This is the conservative reading of #255's "the notification is a queued write — never
  lands mid-user-turn; it rides the next turn's history if the session is busy":
  **v1 delivers the notification on the next user turn, not as an autonomous
  server-triggered turn.** An autonomous turn (the worker driving a chat completion while
  the user is idle) needs a second writer on the chat stream and a background chat
  completion path; it is flagged below (F5) and deferred.

  Mechanism: the notification is derived, not copied. The chat route, before assembling
  history, queries the user's tasks with `origin.sessionId == session` that are `done`
  and not yet announced, appends a visible notification row to the turn's prompt context,
  and — **after this turn's assistant message has persisted** — marks them announced.
  Marking after persistence, not at read time, is deliberate: a turn that fails (provider
  error, abort, geo block) must not consume a completion the user never saw. The cost is
  a wider exactly-once race window (two concurrent turns on one session could both surface
  the same task); chats are single-flight per session on the client, so never losing a
  completion is the property worth buying. "Not yet announced" is a thin flag on `Task`
  (below), not a `Message` write from the worker.

- **F5 — Autonomous server-triggered completion turns are deferred (owner decision).**
  #255's stretch is "a chat completion is triggered so the chat model responds" with no
  user turn. That requires the server to write an assistant `Message` into the chat
  stream on its own — a deliberate second writer — and to route that completion. v1
  takes the conservative default (F4: notify on the next user turn, flag on the PR);
  a follow-up ticket is linked once the owner confirms the autonomous turn is wanted.
  *Flagged for owner veto per the epic fallback rule.*

- **F6 — The embedded task card is read-only and lives in the session view.** It renders
  the task's status chip (`TaskStatusChip`, #254) plus a link to `/tasks`, driven from
  the same `origin.sessionId` query (F1). No task stream is embedded inline in v1 —
  the card is a pointer, and the detail stays in the task view (mobile-first, per the
  standing client rules). It shows only the newest few tasks (`MAX_CARDS`) so a chat
  that has started many never pushes the composer off a phone screen; the full history
  is a tap away in `/tasks`. Progress is visible via a silent poll while any origin task
  is active (the `TaskLibrary` idiom).

- **F7 — The manual "send to worker" affordance is a composer control.** It takes the
  current composer text and creates a task directly (via the existing `POST /api/tasks`
  with `origin: { kind: 'chat', sessionId }`), instead of sending it as a chat turn. It
  is offered on a persisted session only (no ZDR; no new chat with no id yet — the task's
  origin needs a session id).

## Design detail — the "announced" flag

The notification-drain (F4) needs to know which completed tasks have already been
surfaced. Two options:

1. **A field on `Task`** — e.g. `origin.notifiedAt: Date | null` (or a top-level
   `notifiedAt`). The worker leaves it null on completion; the chat route sets it once
   the notification has landed (this turn's assistant message persisted). Thin
   (task-side), no `Message` entanglement, one write per notification. **Chosen.**
2. A separate `TaskNotification` collection. More general (supports non-chat origins)
   but new infrastructure for a single consumer. Rejected as over-built for v1
   (epic invariant: no new infrastructure unless needed).

`notifiedAt` is null for tasks with no origin session (direct-origin tasks are never
notified) and for completed tasks not yet drained.

## Implementation outline

### Server

- **`models/Task.ts`** — add `notifiedAt: { type: Date, default: null }`. Update the
  schema doc-comment: the flag is the chat route's drain marker, not a chat-stream write.
- **`services/mastraService.ts`** — define `delegateTaskTool` (`id: 'delegate_task'`,
  `inputSchema: { instruction: string }`, `outputSchema: { taskId?: string; error?: string }`),
  attach it in `agentFor`'s `tools` map, and describe it in `TOOL_INSTRUCTIONS`. Its
  `execute` reads `userId`/`sessionId` from `ctx.requestContext`, refuses on ZDR / missing
  session, and calls `enqueueTask` with the config budget.
- **`services/taskNotificationService.ts`** (new) — `pendingCompletionsFor(userId, sessionId)`:
  find `done` tasks with `origin.sessionId == sessionId` and `notifiedAt == null`, oldest
  first; `markNotified(taskIds)`. Pure data + the drain marker; no chat-stream write. The
  route reads via `pendingCompletionsFor` when assembling the turn and calls `markNotified`
  only after the assistant message persists.
- **`routes/chat.ts`** — in both persisted routes (non-streaming `POST /` and
  `POST /stream`), after the user message is saved and before the history read, read
  pending completions: build a visible notification line ("A background task finished:
  …" + provenance pointers) and inject it into the turn's context. The line is prepended
  to the assembled prompt as a `system`-level note (never persisted as a `user`/`assistant`
  Message; it is context for the model's response this turn). The drained task ids are
  marked notified only once the turn's assistant message is saved — a failed turn leaves
  them pending for the next turn.
- **Routes** — no task-route change; `serializeTask` may expose `notifiedAt` for tests,
  but the client does not need it.

### Client

- **`services/tasks.ts`** — add `TaskService.create(instruction, origin)` (the manual
  send-to-worker path) and `TaskService.listForSession(sessionId)` (or a `?origin=`
  query on `list`) so the card can fetch origin tasks.
- **`components/TaskCard.tsx`** (new) — the embedded card: status chip + instruction
  snippet + link to `/tasks`. Silent poll while active.
- **`components/ChatWindow.tsx`** — render `TaskCard`(s) for the active session above the
  composer (or in the message flow); add the "Send to worker" control in the composer
  footer (disabled on ZDR / new chat).

## Done

- [x] `Task.notifiedAt` field + schema-comment update; model test (default null, round-trips).
- [x] `delegate_task` tool (schema, execute, ZDR/session refusal) + attached in `agentFor`
      + `TOOL_INSTRUCTIONS` blurb; unit tests (creates task with origin session; ZDR refuses;
      no-session refuses).
- [x] `taskNotificationService` (`pendingCompletionsFor`, `markNotified`) + unit tests.
- [x] Chat routes drain pending completions into the next turn's context (both routes) +
      mark notified **after the turn's assistant message persists**; route tests (a
      completed origin task surfaces on the next turn; a non-origin task does not; a
      second turn does not re-surface; a failed turn leaves it pending).
- [x] Task list route: `originSessionId` filter + tests (filters to origin tasks; scoped
      by user).
- [x] Client: `TaskService.create` + origin list; `TaskCard`; ChatWindow wiring (card +
      "Send to worker"); unit tests (card renders status + link; send-to-worker calls
      create with origin).
- [x] Mobile-first verification in a real browser via `playwright-cli` (~375px) + e2e
      (`e2e/tasks.spec.ts` extension or a new `e2e/chat-task.spec.ts`).
- [x] `npm run ci` green.
- [x] PR against `epic/251-workspace`, plan doc linked — slice PR **#280** opened.

## Follow-ups

- **Autonomous completion turn (F5)** — server-triggered chat completion on task
  completion (a deliberate second writer); owner decision, then its own ticket.
- **Task provenance into workspace memory (#253)** — a completed task's output as a
  corpus item, via the #252 `kind: 'task'` vocabulary (already noted in #254's follow-ups).
- **Notification for direct-origin tasks** — v1 has none (no session to notify); a
  later surface (e.g. the tasks list) can badge completions.
