# Plan — #298 Workspace memory: retrieve task work (artifacts + transcripts)

Issue: [alex-moon/tova#298](https://github.com/alex-moon/tova). Epic: #251. Follow-up to
#253 (workspace memory) and #254 (task entity).

## Motivation

Workspace memory (#253) retrieves over the user's past *chats* and *files*. Tasks
(#254) are a third stream of work — an instruction plus a sequence of assistant steps —
and that work is not retrievable at all. The #253 plan (decision 8) assumed task
outputs would arrive as `Asset` rows carrying `provenance.kind: 'task'`, so retrieval
would admit them at the file level; that was never implemented. This slice closes the
gap so that "what did the worker do about X" is answerable from memory, and so the #289
eval corpus ("chats + tasks + files") has task material to measure.

## Current behaviour (evidence, verified this pass)

- `retrieveWorkspaceBlock` (`workspaceRetrievalService.ts:197`) reads Session titles +
  `role: 'user'` Messages + Assets, with no provenance filter. A file a task generates
  is therefore already swept in — but as a `kind: 'file'` slice, attributed to no task.
- `generate_file` (`mastraService.ts:644`) stamps `{ kind: 'chat', sessionId }` only when
  a `sessionId` rides the tool request context. The task step
  (`taskSequencer.ts:139`) sets `userId` but no `sessionId`/`taskId`, so a task-generated
  file lands with provenance **absent**.
- `provenance.kind: 'task'` exists in the Asset enum (`Asset.ts:116`) with **zero
  writers repo-wide**.
- `TaskEvent` (instruction + assistant steps) is never read by retrieval.

## Decisions

1. **Two separable pieces, both in scope (owner, 2026-10-13).**
   - **A — attribute task artifacts:** thread `taskId` onto the task tool context and
     stamp `{ kind: 'task', taskId }` on files a task generates.
   - **B — index task work:** add `TaskEvent` as a retrieval corpus source producing
     `kind: 'task'` slices, so task transcripts are retrievable like chat work.

2. **`taskId` rides the same per-call request context as `userId`/`sessionId`.** Add
   `CompletionOptions.taskId`, set it in `callOptionsFrom`, and have `generate_file`
   prefer it: `taskId` → `{ kind: 'task', taskId }`, else `sessionId` →
   `{ kind: 'chat', sessionId }`, else absent. Precedence is safe because the task path
   sets no `sessionId` and the chat path sets no `taskId`.

3. **One task slice per task; text is the `TaskEvent` stream, not the header.** The
   slice text concatenates the task's `user` and `assistant` event content in `seq`
   order (`system` notices are skipped — they are visible-only, never model context).
   The header's `instruction` is used only for the slice title, so the instruction is
   not duplicated (it is also the first `user` event). A task with no events yields
   empty text and is dropped, mirroring the empty-message rule.

4. **Bounded, user-scoped, all statuses.** Read the newest `TASK_POOL` tasks for the
   user (by `updatedAt`), then their events by `taskId` — the same pool-first ownership
   discipline as the session/message read, so another user's activity cannot starve this
   user's history. `queued`/`paused`/`cancelled`/`failed` tasks are included when they
   carry content; a task is work regardless of how it settled. Tasks are never ZDR
   (D7: ZDR users get no tasks), so there is no ephemeral filter here.

5. **Block labelling gains `task`.** `buildWorkspaceBlock` renders `task "<title>"`
   beside `chat`/`file`, and the `<user:workspace>` intro is widened from "earlier chats
   and files" to name task work too. No route signature changes — the retrieval entry
   point still returns a rendered string.

## Done

- [x] Plan doc (this file)
- [x] `CompletionOptions.taskId` + request-context threading (`llmTypes`, `mastraService`)
- [x] `generate_file` stamps `{ kind: 'task', taskId }` when a task id is present
- [x] `taskSequencer.runTaskStep` sets `taskId`
- [x] `WorkspaceSlice.kind` gains `'task'`; task corpus read in `retrieveWorkspaceBlock`
- [x] `buildWorkspaceBlock` labels task slices; `<user:workspace>` intro updated
- [x] Tests: generate_file task provenance, block labelling, task corpus read + isolation
- [x] `npm run ci` green (97 suites, 1212 tests)

## Follow-ups

- Gate/retrieval evals over the task corpus are #289's scope, not this slice.
- Retrieval ranking improvements (#293 keyword/BM25, #294 embeddings) apply to task
  slices as they do to chats/files.
