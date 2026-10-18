# Plan — #392: escape task:completed / user:workspace blocks in the system prompt

## Motivation

[#392](https://github.com/alex-moon/tova/issues/392), from the #382 audit.

`promptAssembly.ts` inserts two user/model-controlled blocks into the **system
prompt** without `escapeEnvelopeBreakers`, unlike every other user-controlled
block (`buildUserEnvelope`, `fileElement`):

- `workspaceBlock` — retrieved workspace memory (derived from the user's own
  past chats, files, and tasks).
- `taskCompletionBlock` — completed background-task summaries, which include
  the task's final assistant answer: model output that may quote fetched web
  content.

A forged `</task:completed>` or `</user:workspace>` in that content closes the
envelope early, so the remainder lands unprompted as system-level instruction.

Additionally, `CLEAR_TAG_NAMES` in `attachmentEnvelope.ts` covers
`user:[a-z_]+` but not `task:*`, so the escaper cannot strip a
`</task:completed>` breaker even where it is invoked.

## Findings

- Verified empirically: the current escaper already matches `</user:workspace>`
  (via `user:[a-z_]+`) but passes `</task:completed>` through raw. Both blocks
  are currently escaped **never** — the raw trimmed string is interpolated
  directly.
- Task-completion content confirmed to embed `TaskEvent` assistant content
  (`chat.ts:633-638`), i.e. model output quoting untrusted web text.

## Decisions

- **Minimal, layout-preserving fix.** Wrap both blocks' content with
  `escapeEnvelopeBreakers` inside their existing builders; do not refactor them
  onto `buildUserEnvelope` (it reorders intro/tag lines, changing prompt layout
  beyond the ticket's scope).
- **Extend the tag list with `task:[a-z_]+`**, mirroring the existing
  `user:[a-z_]+` pattern, so any future `task:*` envelope is covered too, not
  just `task:completed`.
- **Defense-in-depth scope unchanged.** The escaper neutralises closing tags
  only; forged *opening* tags inside data remain untouched (consistent with
  every other envelope on this codebase).

## Done

- [x] Extend `CLEAR_TAG_NAMES` with `task:[a-z_]+`.
- [x] `workspaceBlock` escapes its content.
- [x] `taskCompletionBlock` escapes its content.
- [x] Tests: escaper covers `</task:completed>`; both system-prompt blocks
      escape forged closers while the real closer still terminates the
      envelope on its own line.
- [x] `npm run ci` green.

## Follow-ups

- #387 (roster retirement) will rewrite the prompt assembly area; the escaping
  introduced here is the ground it should build on, as the ticket intended.
